/**
 * Rete LAN: quella che il router OFFRE (requisito 4a).
 *
 * Il pezzo delicato non e' il modulo, e' il fatto che cambiare l'indirizzo del
 * router rompe applica-e-conferma: la conferma dovrebbe arrivare da una pagina
 * che dopo la modifica sta su un indirizzo inesistente.
 *
 * La soluzione qui adottata: durante la finestra di conferma il router tiene
 * ATTIVI ENTRAMBI gli indirizzi, vecchio e nuovo. Chi non ha ancora rinnovato
 * il DHCP continua a raggiungere il vecchio e puo' confermare; chi lo ha
 * rinnovato usa il nuovo. Alla conferma il vecchio viene rimosso.
 *
 * Nessun meccanismo nuovo: e' lo stesso applica-e-conferma di D5, reso
 * raggiungibile.
 */

import { lanText } from '../i18n/lan';
import { call } from './ubus';
import { isValidIp, overlaps, parseIp, sortKey, subnetOfMask } from './ip';
import { normalizeMac } from './wifi';

export interface LanDhcp {
  start: string;
  limit: string;
  leasetime: string;
  ignore: boolean;
}

export interface LanConfig {
  device: string;
  up: boolean;
  /** Piu' di uno solo durante una finestra di conferma. */
  addresses: string[];
  netmask: string;
  dhcp: LanDhcp;
  /**
   * Indirizzi IPv6 del router sulla LAN, COL PREFISSO attaccato.
   *
   * Al contrario di `addresses`, che escono nudi perche' alimentano un campo di
   * input: questi vanno in una riga di sola lettura, e li' il prefisso e' la
   * meta' informativa.
   */
  addresses6: string[];
  /** Prefisso ULA del router, vuoto se OpenWrt non l'ha generato. */
  ula: string;
  /** DNS annunciati ai client via DHCP. Vuoto = il router stesso. */
  dns_client: string[];
  /** DNS v6 annunciati ai client, da `dhcp.lan.dns` (li legge odhcpd). */
  dns_client6: string[];
  /** Resolver che usa il router. Vuoto = quelli che arrivano dalla WAN. */
  dns_upstream: string[];
  /** Nome reale della sezione dnsmasq: `@dnsmasq[0]` non e' accettato da ubus. */
  dnsmasq_section: string;
  /** Tutte le dhcp_option, per riscrivere solo la 6 senza perdere le altre. */
  dhcp_options: string[];
  /** Valori grezzi di RA e DHCPv6: la modalita' la deduce `matchRaMode`. */
  ra: string;
  dhcpv6: string;
  ra_flags: string[];
  ra_slaac: string;
  ra_default: string;
}

/** La LAN come arriva dall'rpcd, dove i campi nuovi possono mancare. */
type RawLan = Omit<
  LanConfig,
  'addresses6' | 'ula' | 'dns_client6' | 'ra' | 'dhcpv6' | 'ra_flags' | 'ra_slaac' | 'ra_default'
> &
  Partial<
    Pick<
      LanConfig,
      'addresses6' | 'ula' | 'dns_client6' | 'ra' | 'dhcpv6' | 'ra_flags' | 'ra_slaac' | 'ra_default'
    >
  >;

export async function getLan(): Promise<LanConfig> {
  const lan = await call<RawLan>('travel', 'lan');
  // Normalizzato al confine: da qui in giu' un indirizzo v4 e' un indirizzo,
  // mai un indirizzo con la maschera attaccata. Quelli v6 invece il prefisso lo
  // tengono, ed e' voluto.
  return {
    ...lan,
    addresses: (lan.addresses ?? []).map(stripPrefix),
    addresses6: lan.addresses6 ?? [],
    ula: lan.ula ?? '',
    dns_client6: lan.dns_client6 ?? [],
    ra: lan.ra ?? '',
    dhcpv6: lan.dhcpv6 ?? '',
    ra_flags: lan.ra_flags ?? [],
    ra_slaac: lan.ra_slaac ?? '',
    ra_default: lan.ra_default ?? '',
  };
}

// --- RA e DHCPv6 --------------------------------------------------------------

/**
 * Come il router annuncia IPv6 ai dispositivi: tre scelte, non sette manopole.
 *
 * `custom` non e' una scelta offerta: e' cio' che si risponde quando la
 * configurazione sul router non e' nessuna delle tre. In quel caso la
 * schermata mostra i valori grezzi e si RIFIUTA di sovrascriverli - stessa
 * regola di `matchDnsProvider`: non si mostra mai uno stato in cui il router
 * non e'.
 */
export type RaMode = 'auto' | 'slaac' | 'off' | 'custom';

export interface RaOption {
  id: RaMode;
  label: string;
  hint: string;
}

export const RA_OPTIONS: RaOption[] = [
  {
    id: 'auto',
    get label() {
      return lanText().lib.ra.auto.label;
    },
    get hint() {
      return lanText().lib.ra.auto.hint;
    },
  },
  {
    id: 'slaac',
    get label() {
      return lanText().lib.ra.slaac.label;
    },
    get hint() {
      return lanText().lib.ra.slaac.hint;
    },
  },
  {
    id: 'off',
    get label() {
      return lanText().lib.ra.off.label;
    },
    get hint() {
      return lanText().lib.ra.off.hint;
    },
  },
];

/** I valori uci di ogni modalita'. `null` significa cancellare l'opzione. */
interface RaValues {
  ra: string;
  dhcpv6: string;
  ra_flags: string[] | null;
  ra_slaac: string | null;
}

/**
 * Una funzione sola a decidere cosa scrive ogni modalita'.
 *
 * Averle sparse fra la scrittura e la rilettura e' il modo in cui le due si
 * disallineano: si scriverebbe una combinazione che poi `matchRaMode` non
 * riconosce piu', e la schermata direbbe "Personalizzato" subito dopo aver
 * salvato.
 */
export function raValues(mode: Exclude<RaMode, 'custom'>): RaValues {
  if (mode === 'auto') {
    return {
      ra: 'server',
      dhcpv6: 'server',
      ra_flags: ['managed-config', 'other-config'],
      ra_slaac: '1',
    };
  }
  if (mode === 'slaac') {
    return { ra: 'server', dhcpv6: 'disabled', ra_flags: ['other-config'], ra_slaac: '1' };
  }
  return { ra: 'disabled', dhcpv6: 'disabled', ra_flags: null, ra_slaac: null };
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Quale modalita' descrive la configurazione attuale, o `custom`.
 *
 * `ra_slaac` assente vale `1`, che e' il default di odhcpd: un router appena
 * installato quell'opzione non ce l'ha scritta, e pretenderla renderebbe
 * "Personalizzato" la configurazione piu' comune che esista.
 */
export function matchRaMode(lan: LanConfig): RaMode {
  const slaac = lan.ra_slaac === '' ? '1' : lan.ra_slaac;

  for (const id of ['auto', 'slaac', 'off'] as const) {
    const want = raValues(id);
    if (lan.ra !== want.ra || lan.dhcpv6 !== want.dhcpv6) continue;
    if (want.ra_flags === null) {
      // Spento: dei flag non importa niente, perche' senza RA non si annuncia
      // niente comunque, e pretenderli vuoti renderebbe "Personalizzato" un
      // router spento che si porta dietro i flag di prima.
      return id;
    }
    if (!sameList(lan.ra_flags, want.ra_flags)) continue;
    if (want.ra_slaac !== null && slaac !== want.ra_slaac) continue;
    return id;
  }
  return 'custom';
}

// --- Conflitti con le reti a monte --------------------------------------------

export interface WanSubnet {
  label: string;
  ipv4: string;
  netmask: string;
}

export interface Conflict {
  label: string;
  ipv4: string;
}

/**
 * Conflitti fra la LAN e le reti a monte.
 *
 * E' il vero motivo per cui questa schermata esiste: se l'albergo distribuisce
 * la stessa sottorete della LAN, il router non sa piu' distinguere cio' che e'
 * locale da cio' che sta a monte e il traffico non esce. Succede spesso, perche'
 * quasi tutti usano gli stessi due o tre intervalli.
 *
 * IPv6 non entra in questo controllo, e non e' una dimenticanza. La collisione
 * e' un problema degli indirizzi privati IPv4, che sono pochi e li usano tutti:
 * un prefisso delegato e' unico per costruzione, e due ULA che collidono sono
 * un caso che non capita. Soprattutto, il prefisso v6 della LAN non lo sceglie
 * nessuno - arriva dalla delega - quindi non ci sarebbe niente da proporre.
 *
 * Il filtro passa da subnetOfMask, che risponde null a un indirizzo v6: una WAN
 * dual-stack viene confrontata sulla sola meta' v4, che e' esattamente quello
 * che serve.
 */
export function findConflicts(
  lanIp: string,
  lanMask: string,
  wans: WanSubnet[],
): Conflict[] {
  const lan = subnetOfMask(lanIp, lanMask);
  if (!lan) return [];

  const conflicts: Conflict[] = [];
  for (const wan of wans) {
    if (!wan.ipv4) continue;
    const other = subnetOfMask(wan.ipv4, wan.netmask || '255.255.255.0');
    if (other && overlaps(lan, other)) {
      conflicts.push({ label: wan.label, ipv4: `${wan.ipv4}/${wan.netmask || '?'}` });
    }
  }
  return conflicts;
}

/**
 * Sottoreti candidate, scelte fra quelle che quasi nessun router usa di
 * fabbrica: una proposta che collide di nuovo non serve a niente.
 */
const CANDIDATES = [
  '192.168.10.1',
  '192.168.42.1',
  '192.168.77.1',
  '10.44.1.1',
  '10.77.9.1',
  '172.31.9.1',
  '192.168.123.1',
];

/** Primo indirizzo candidato che non collide con nessuna WAN attiva. */
export function suggestAddress(current: string, wans: WanSubnet[]): string | null {
  for (const candidate of CANDIDATES) {
    if (candidate === current) continue;
    if (findConflicts(candidate, '255.255.255.0', wans).length === 0) return candidate;
  }
  return null;
}

// --- Scrittura ----------------------------------------------------------------

/**
 * La rete locale e' sempre /24, e la maschera non e' un campo.
 *
 * 254 indirizzi sono piu' che sufficienti per un router da viaggio, e una rete
 * piu' piccola collide meno con quelle degli alberghi, non di piu'. In cambio
 * sparisce un campo che non si sa cosa metterci.
 */
export const LAN_NETMASK = '255.255.255.0';

/**
 * Toglie l'eventuale prefisso CIDR da un indirizzo.
 *
 * `uci` accetta anche la forma `192.168.10.1/24`, e chi ha configurato la rete
 * da LuCI puo' averla scritta cosi'. Il campo dell'interfaccia chiede un
 * indirizzo, quindi la maschera va tolta a monte invece di finire davanti a chi
 * scrive - e vale anche per quello che viene incollato dentro il campo.
 *
 * Va bene cosi' anche per IPv6, e non serve "aggiustarlo": in un indirizzo v6
 * la barra compare solo davanti al prefisso, quindi split('/')[0] taglia nel
 * punto giusto tanto per "192.168.10.1/24" quanto per "fd66:67c3:698b::1/64".
 */
export function stripPrefix(address: string): string {
  return address.trim().split('/')[0].trim();
}

/** Prefisso /24 di un indirizzo, per mostrare la rete che ne deriva. */
export function prefix24(address: string): string {
  const parts = stripPrefix(address).split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') : '';
}

/**
 * Ultimo ottetto, oppure null se l'indirizzo non e' un IPv4.
 *
 * Solo IPv4 di proposito: "l'ultimo ottetto" e' il numero che si scrive nel
 * campo dell'indirizzo e negli estremi del pool DHCP, e la LAN v4 resta una
 * /24 fissa. In IPv6 non c'e' niente di equivalente da mostrare.
 */
export function lastOctet(address: string): number | null {
  const addr = parseIp(stripPrefix(address));
  return addr && addr.family === 4 ? addr.bytes[3] : null;
}

/** Indirizzo utilizzabile da un host in una /24: non la rete, non il broadcast. */
export function isHostAddress(address: string): boolean {
  const octet = lastOctet(address);
  return octet !== null && octet >= 1 && octet <= 254;
}

// --- DNS ----------------------------------------------------------------------

export interface DnsProvider {
  id: string;
  label: string;
  servers: string[];
  /**
   * Gli indirizzi v6 dello stesso fornitore.
   *
   * Vuoto per `auto` e `custom`, che fornitori non sono. Le voci dei fornitori
   * scrivono SEMPRE tutte e due le famiglie e mai la sola v6: un resolver v6 e'
   * raggiungibile solo con una WAN v6, e offrirlo da solo darebbe una
   * configurazione che smette di risolvere appena si cambia albergo.
   */
  servers6?: string[];
}

const PROVIDERS: DnsProvider[] = [
  {
    id: 'google',
    label: 'Google DNS',
    servers: ['8.8.8.8', '8.8.4.4'],
    servers6: ['2001:4860:4860::8888', '2001:4860:4860::8844'],
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    servers: ['1.1.1.1', '1.0.0.1'],
    servers6: ['2606:4700:4700::1111', '2606:4700:4700::1001'],
  },
  {
    id: 'quad9',
    label: 'Quad9',
    servers: ['9.9.9.9', '149.112.112.112'],
    servers6: ['2620:fe::fe', '2620:fe::9'],
  },
  {
    id: 'adguard',
    label: 'AdGuard DNS',
    servers: ['94.140.14.14', '94.140.15.15'],
    servers6: ['2a10:50c0::ad1:ff', '2a10:50c0::ad2:ff'],
  },
];

/** Opzioni per i DNS annunciati ai dispositivi: l'automatico e' il router. */
export const CLIENT_DNS_OPTIONS: DnsProvider[] = [
  {
    id: 'auto',
    get label() {
      return lanText().lib.autoRouter;
    },
    servers: [],
  },
  ...PROVIDERS,
  {
    id: 'custom',
    get label() {
      return lanText().lib.custom;
    },
    servers: [],
  },
];

/** Opzioni per i resolver del router: l'automatico sono quelli della WAN. */
export const ROUTER_DNS_OPTIONS: DnsProvider[] = [
  ...PROVIDERS,
  {
    id: 'auto',
    get label() {
      return lanText().lib.autoWan;
    },
    servers: [],
  },
  {
    id: 'custom',
    get label() {
      return lanText().lib.custom;
    },
    servers: [],
  },
];

/**
 * Quale voce dell'elenco corrisponde a una configurazione esistente.
 *
 * La tendina mostra sempre lo stato reale: far comparire un fornitore che non e'
 * quello in uso farebbe credere di avere una configurazione che non si ha.
 */
/**
 * Confronta SOLO la lista v4, e tratta quella v6 come derivata.
 *
 * Non e' pigrizia: un router configurato da una versione precedente
 * dell'interfaccia ha i v4 di Cloudflare e nessun v6, e pretendere anche quelli
 * gli farebbe mostrare "Personalizzato" al posto del fornitore che ha davvero.
 * Quale sia la meta' v6 lo dice la voce del fornitore, non il router.
 */
export function matchDnsProvider(servers: string[], options: DnsProvider[]): string {
  if (servers.length === 0) return 'auto';

  // Solo la meta' v4: i resolver del router stanno in una lista sola con
  // entrambe le famiglie, e confrontarla intera non combacerebbe con nessun
  // fornitore, che di indirizzi v4 ne dichiara due.
  const v4 = servers.filter((s) => parseIp(s)?.family === 4);

  for (const option of options) {
    if (option.servers.length === 0) continue;
    if (option.servers.length === v4.length && option.servers.every((s, i) => s === v4[i])) {
      return option.id;
    }
  }
  return 'custom';
}

/**
 * I DNS annunciati ai dispositivi, tutti insieme.
 *
 * Le due famiglie vivono in due opzioni uci diverse - `dhcp_option 6` e
 * `dhcp.lan.dns` - ma nell'interfaccia sono UNA scelta sola, e lo stato della
 * schermata va costruito su tutte e due.
 *
 * Leggerne una sola non e' un'imprecisione, e' una perdita di dati: la meta'
 * non letta resta fuori dallo stato della schermata, e siccome il salvataggio
 * riscrive comunque entrambe le opzioni, un salvataggio qualunque - anche solo
 * per spostare il pool DHCP - cancellerebbe i DNS IPv6 gia' configurati senza
 * che nessuno l'abbia chiesto.
 */
export function clientDns(lan: LanConfig): string[] {
  return [...lan.dns_client, ...lan.dns_client6];
}

/**
 * Se la scelta dei DNS si puo' modificare da questa schermata.
 *
 * I campi liberi sono DUE. Una lista scelta a mano piu' lunga di due voci non
 * ci sta dentro, e mostrarne solo le prime due non sarebbe una semplificazione
 * innocua: al salvataggio si riscriverebbe la lista troncata e il resto
 * sparirebbe senza che niente lo dica. Con le due famiglie separate il caso e'
 * diventato normale - due resolver v4 piu' uno v6 fanno gia' tre voci - mentre
 * prima serviva configurare a mano tre DNS v4.
 *
 * Un fornitore riconosciuto e' sempre modificabile, per lunga che sia la lista:
 * li' le voci non sono un dato da conservare, sono la definizione della scelta.
 *
 * Stessa regola di `matchRaMode`: una configurazione che non si sa
 * rappresentare si mostra com'e' e non si tocca.
 */
export function dnsEditable(current: string[], options: DnsProvider[]): boolean {
  return matchDnsProvider(current, options) !== 'custom' || current.length <= 2;
}

/**
 * Se i due campi liberi dei DNS contengono qualcosa che si puo' salvare.
 *
 * Il controllo vale **solo** quando quei campi si possono davvero modificare.
 * Un elenco che la schermata mostra e non tocca non ha nessun diritto di
 * bloccare il salvataggio del resto della rete locale: i suoi valori non
 * vengono scritti, e chi guarda non ha nemmeno un campo dove correggerli - il
 * pulsante resterebbe spento senza spiegare perche'.
 *
 * Il caso non e' teorico: `dhcp.<sezione>.server` accetta forme che indirizzi
 * non sono, come `/example.com/192.168.1.1` per risolvere un dominio con un
 * resolver dedicato. Sono configurazioni legittime, e `isValidIp` le rifiuta.
 */
export function dnsFieldsOk(
  editable: boolean,
  mode: string,
  one: string,
  two: string,
): boolean {
  if (!editable || mode !== 'custom') return true;
  return isValidIp(one) && (two === '' || isValidIp(two));
}

export function dnsProvider(id: string, options: DnsProvider[]): DnsProvider | undefined {
  return options.find((o) => o.id === id);
}

export interface LanSettings {
  address: string;
  /** Ultimo ottetto del primo indirizzo assegnato. */
  poolFrom: number;
  /** Ultimo ottetto dell'ultimo indirizzo assegnato. */
  poolTo: number;
  /**
   * DNS v4 annunciati ai dispositivi. `null` significa **non toccare**.
   *
   * Il `null` non e' un vezzo: la schermata mostra due campi, e una
   * configurazione che non ci sta dentro non si sovrascrive. Vedi `dnsEditable`.
   */
  dnsClient: string[] | null;
  /**
   * DNS v6 annunciati ai dispositivi, e lo stesso `null`.
   *
   * Lista separata da `dnsClient` perche' finisce in un posto separato, e la
   * separazione e' l'intero punto: vedi la scrittura in `stageLan`.
   */
  dnsClient6: string[] | null;
  dnsUpstream: string[] | null;
  /** Modalita' di annuncio IPv6. `custom` non si scrive mai. */
  raMode: RaMode;
}

export interface PoolProblem {
  message: string;
}

/**
 * Controlli sul pool, con il motivo scritto per esteso.
 *
 * L'indirizzo del router dentro il pool e' l'errore che non si vede: il DHCP lo
 * assegnerebbe a un dispositivo e da quel momento due macchine risponderebbero
 * allo stesso indirizzo.
 */
export function checkPool(address: string, from: number, to: number): PoolProblem | null {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return { message: lanText().lib.poolNotNumbers };
  }
  if (from < 2 || from > 254 || to < 2 || to > 254) {
    return { message: lanText().lib.poolRange };
  }
  if (from > to) {
    return { message: lanText().lib.poolOrder };
  }

  const octet = lastOctet(address);
  if (octet !== null && octet >= from && octet <= to) {
    return {
      message: lanText().lib.poolHasRouter(octet),
    };
  }
  return null;
}

/**
 * Prepara la nuova configurazione della LAN.
 *
 * Indirizzo, maschera, pool DHCP e DNS si scrivono insieme: lo stato intermedio
 * "LAN spostata ma pool fermo sulla vecchia sottorete" e' una rete che non
 * distribuisce piu' indirizzi, e non deve poter esistere.
 *
 * `keepAddress` resta attivo accanto al nuovo per tutta la finestra di
 * conferma. E' cio' che rende la conferma raggiungibile.
 */
export async function stageLan(
  settings: LanSettings,
  keepAddress: string | null,
  current: LanConfig,
): Promise<void> {
  const addresses =
    keepAddress && keepAddress !== settings.address
      ? [settings.address, keepAddress]
      : [settings.address];

  /**
   * Ogni scrittura dice a cosa si riferisce.
   *
   * Un "argomento non valido" senza contesto costringe a indovinare quale
   * delle quattro scritture non e' piaciuta a uci.
   */
  const write = async (what: string, args: Record<string, unknown>) => {
    try {
      await call('uci', 'set', args);
    } catch (err) {
      throw new Error(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Cancella un'opzione a lista invece di scriverla vuota, che uci rifiuta. */
  const clear = async (config: string, section: string, option: string) => {
    try {
      await call('uci', 'delete', { config, section, option });
    } catch {
      // Non c'era: e' il caso normale della prima configurazione.
    }
  };

  const t = lanText().lib;
  await write(t.writeLanAddress, {
    config: 'network',
    section: 'lan',
    values: { ipaddr: addresses, netmask: LAN_NETMASK },
  });

  // uci vuole il primo indirizzo e QUANTI, non l'ultimo: la conversione si fa
  // qui una volta sola, cosi' l'interfaccia puo' parlare di "da" e "a".
  await write(t.writePool, {
    config: 'dhcp',
    section: 'lan',
    values: {
      start: String(settings.poolFrom),
      limit: String(settings.poolTo - settings.poolFrom + 1),
    },
  });

  // I DNS annunciati ai dispositivi si scrivono in DUE posti indipendenti, e
  // non e' una ridondanza: sono due protocolli diversi.
  //
  // `dhcp_option 6,<csv>` e' DHCPv4 e SOLO DHCPv4. Un indirizzo IPv6 li' dentro
  // non annuncia niente a nessuno, e non si limita a essere inutile: dnsmasq
  // puo' rifiutare l'INTERA lista per una voce che non gli piace, quindi si
  // romperebbero anche i DNS v4 mentre si crede di aggiungerne. Per questo qui
  // entra solo `dnsClient`, che la schermata convalida come v4.
  //
  // I DNS v6 vivono in `dhcp.lan.dns`, una lista che legge odhcpd - non dnsmasq
  // - e che finisce sia nel campo RDNSS dell'RA sia nella risposta DHCPv6.
  //
  // Si sostituisce solo l'opzione 6, davvero: le altre dhcp_option vengono
  // rimesse com'erano invece di sparire.
  // `null` significa "non toccare": la schermata non e' riuscita a
  // rappresentare quella lista, quindi non ha nessun diritto di riscriverla.
  if (settings.dnsClient !== null) {
    const others = (current.dhcp_options ?? []).filter((o) => !o.startsWith('6,'));
    const options =
      settings.dnsClient.length > 0 ? [...others, `6,${settings.dnsClient.join(',')}`] : others;

    if (options.length > 0) {
      await write(t.writeClientDns, {
        config: 'dhcp',
        section: 'lan',
        values: { dhcp_option: options },
      });
    } else {
      await clear('dhcp', 'lan', 'dhcp_option');
    }
  }

  if (settings.dnsClient6 !== null) {
    if (settings.dnsClient6.length > 0) {
      await write(t.writeClientDns6, {
        config: 'dhcp',
        section: 'lan',
        values: { dns: settings.dnsClient6 },
      });
    } else {
      // Cancellata, non scritta vuota: e' la stessa regola delle altre liste, e
      // uci una lista vuota non la accetta comunque.
      await clear('dhcp', 'lan', 'dns');
    }
  }

  // RA e DHCPv6. `custom` non si scrive MAI: significa che il router e' in una
  // configurazione che non e' nessuna delle tre, e sovrascriverla vorrebbe dire
  // buttare via una scelta fatta altrove senza che nessuno l'abbia chiesto.
  if (settings.raMode !== 'custom') {
    const ra = raValues(settings.raMode);
    await write(t.writeRa, {
      config: 'dhcp',
      section: 'lan',
      // `ra_default` resta fisso a 0 e non ha un interruttore. A 1 il router si
      // annuncerebbe come gateway v6 predefinito ANCHE senza un upstream v6:
      // i client proverebbero a uscire da una strada che non porta da nessuna
      // parte, e IPv6 sparirebbe in ogni rete v4-only.
      values: { ra: ra.ra, dhcpv6: ra.dhcpv6, ra_default: '0' },
    });

    if (ra.ra_flags === null) {
      await clear('dhcp', 'lan', 'ra_flags');
    } else {
      await write(t.writeRa, {
        config: 'dhcp',
        section: 'lan',
        values: { ra_flags: ra.ra_flags },
      });
    }

    if (ra.ra_slaac === null) {
      await clear('dhcp', 'lan', 'ra_slaac');
    } else {
      await write(t.writeRa, {
        config: 'dhcp',
        section: 'lan',
        values: { ra_slaac: ra.ra_slaac },
      });
    }
  }

  // La sezione dnsmasq ha un nome anonimo reale: "@dnsmasq[0]" e' comodo da
  // riga di comando ma non e' quello che accetta `uci set` via ubus.
  if (current.dnsmasq_section && settings.dnsUpstream !== null) {
    if (settings.dnsUpstream.length > 0) {
      await write(t.writeRouterDns, {
        config: 'dhcp',
        section: current.dnsmasq_section,
        values: { server: settings.dnsUpstream },
      });
    } else {
      await clear('dhcp', current.dnsmasq_section, 'server');
    }
  }
}

/**
 * Toglie il vecchio indirizzo dopo che la modifica e' stata confermata.
 *
 * Applicato senza ritorno indietro: a questo punto la configurazione nuova ha
 * gia' dimostrato di funzionare, ed e' quella su cui si vuole restare.
 */
export async function dropOldAddress(address: string): Promise<void> {
  await call('uci', 'set', {
    config: 'network',
    section: 'lan',
    values: { ipaddr: [address] },
  });
  await call('uci', 'apply', {});
}

/** Pool DHCP sensato per una sottorete /24 appena scelta. */
export function defaultPool(): { start: string; limit: string } {
  return { start: '100', limit: '150' };
}

// --- Porte ethernet commutabili (requisito C) ---------------------------------

export type PortMode = 'wan' | 'lan';
/** `free` = ne' nel bridge ne' con un'interfaccia WAN attiva. */
export type PortRole = PortMode | 'free';

export interface EthPort {
  /** Nome del device di sistema, es. "lan1". Enumerato dal kernel. */
  name: string;
  /** Dedotto dalla realta': dove sta la porta adesso. */
  role: PortRole;
  /** Interfaccia logica che la usa come WAN, vuota se non ce n'e' una. */
  network: string;
  carrier: number;
  mwan3: boolean;
  /** Il MAC con cui la porta si presenta adesso, letto dal kernel. */
  mac: string;
  /** Il MAC imposto in configurazione, vuoto se si usa quello di fabbrica. */
  mac_config: string;
  /** Sezione `device` di uci che descrive la porta, vuota se non esiste. */
  device_section: string;
}

export interface EthPorts {
  /** Nome reale della sezione del bridge br-lan, quello che `uci set` accetta. */
  bridge_section: string;
  bridge_ports: string[];
  /** Sezione della zona firewall wan, es. "@zone[1]". */
  zone_section: string;
  zone_networks: string[];
  ports: EthPort[];
}

/**
 * Una porta con i campi del MAC sempre presenti.
 *
 * `mac`, `mac_config` e `device_section` sono arrivati dopo: un router che ha
 * ancora l'rpcd precedente non li manda, ed e' lo stato normale fra
 * l'aggiornamento dell'interfaccia e quello del pacchetto - la UI sta in
 * `/www`, il metodo in un file diverso. Si riempiono all'ingresso, una volta
 * sola, cosi' nessuna schermata deve ricordarsi che potrebbero mancare:
 * leggerne uno assente farebbe morire tutta la scheda LAN per un campo che non
 * c'e'.
 *
 * E' lo stesso trattamento che ricevono le reti salvate nate prima che
 * l'hostname per rete esistesse.
 */
export function withMacDefaults(port: EthPort): EthPort {
  return {
    ...port,
    mac: port.mac ?? '',
    mac_config: port.mac_config ?? '',
    device_section: port.device_section ?? '',
  };
}

export async function getEthPorts(): Promise<EthPorts> {
  const info = await call<EthPorts>('travel', 'ethports');
  return { ...info, ports: (info.ports ?? []).map(withMacDefaults) };
}

/**
 * Nome dell'interfaccia logica per una porta usata come WAN.
 *
 * Le sezioni uci accettano solo lettere, cifre e trattini bassi: un nome di
 * porta con un punto - le VLAN ne hanno - romperebbe la configurazione senza
 * dire perche'.
 */
export function wanNetworkName(port: string): string {
  return `wan_${port.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

/**
 * Nome della sezione `device` per una porta che non ne ha ancora una.
 *
 * Stesse regole di `wanNetworkName`: uci accetta solo lettere, cifre e
 * trattini bassi nei nomi di sezione, e i nomi di porta con un punto - le VLAN
 * ne hanno - romperebbero la configurazione senza dire perche'.
 */
export function devSectionName(port: string): string {
  return `dev_${port.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

/**
 * Prepara il cambio di MAC di una porta ethernet.
 *
 * Il MAC di un device si scrive nella sezione `device` di
 * `/etc/config/network`, non sull'interfaccia: da OpenWrt 21.02 netifd lo
 * legge solo da li'. Messo sull'interfaccia verrebbe ignorato in silenzio, che
 * e' il modo peggiore di sbagliare - la schermata direbbe fatto e la porta si
 * presenterebbe come prima.
 *
 * MAC vuoto significa tornare a quello di fabbrica, e si ottiene cancellando
 * l'opzione, non scrivendola vuota: `macaddr=` verrebbe passato al kernel
 * cosi' com'e'. E' la stessa distinzione che vale per la STA WiFi in
 * `stageStaMac`, ed e' la differenza fra una porta che torna su e una che non
 * sale piu'.
 *
 * La sezione resta anche quando si toglie il MAC: puo' portare altre
 * impostazioni della porta - l'MTU, per dirne una - e cancellarla per riordino
 * porterebbe via anche quelle.
 */
export async function stageEthMac(port: EthPort, requested: string): Promise<void> {
  // In forma canonica prima di scrivere: quello che finisce in uci viene poi
  // confrontato con l'indirizzo che il kernel riporta, sempre minuscolo.
  const mac = normalizeMac(requested);

  if (mac) {
    if (port.device_section) {
      await call('uci', 'set', {
        config: 'network',
        section: port.device_section,
        values: { macaddr: mac },
      });
    } else {
      await call('uci', 'add', {
        config: 'network',
        type: 'device',
        name: devSectionName(port.name),
        values: { name: port.name, macaddr: mac },
      });
    }
    return;
  }

  // Non c'era nessuna sezione: non c'e' nemmeno niente da togliere.
  if (!port.device_section) return;

  await call('uci', 'delete', {
    config: 'network',
    section: port.device_section,
    option: 'macaddr',
  });
}

/**
 * Prepara il cambio di ruolo di una porta. Una transazione sola.
 *
 * Verso LAN: la porta entra nel bridge e la sua interfaccia WAN viene
 * disattivata. Un device non puo' stare in un bridge ed essere anche
 * un'interfaccia a se'; disattivare invece di cancellare conserva la
 * configurazione per il ritorno. Il DHCP non si tocca, il bridge usa gia' il
 * pool della LAN.
 *
 * Verso WAN: la porta esce dal bridge e prende un'interfaccia propria in DHCP,
 * creata se non esiste e aggiunta alla zona firewall - senza quella il traffico
 * non verrebbe mascherato e i client non uscirebbero.
 *
 * Con mwan3 presente la sua voce segue la porta: altrimenti resterebbe un
 * health check su una WAN che non esiste piu'.
 */
/**
 * Vero se la sezione uci esiste gia'.
 *
 * `uci get` su una sezione che non c'e' risponde con un errore, non con un
 * valore vuoto: l'assenza si legge solo intercettandolo.
 */
async function sectionExists(config: string, section: string): Promise<boolean> {
  try {
    await call('uci', 'get', { config, section });
    return true;
  } catch {
    return false;
  }
}

export async function stageEthPort(
  info: EthPorts,
  port: EthPort,
  target: PortMode,
): Promise<void> {
  if (!info.bridge_section) throw new Error(lanText().lib.noBridge);

  const ports = info.bridge_ports.filter((p) => p !== port.name);
  if (target === 'lan') ports.push(port.name);

  if (ports.length > 0) {
    await call('uci', 'set', {
      config: 'network',
      section: info.bridge_section,
      values: { ports },
    });
  } else {
    // Bridge senza porte ethernet: la rete locale resta sul WiFi. E' la
    // configurazione in cui si finisce appena si vogliono due uplink via cavo,
    // perche' l'ultima porta rimasta nel bridge se ne va.
    //
    // La lista vuota non si puo' scrivere: `uci set` con un array vuoto
    // risponde "argomento non valido" senza spiegare quale. Si cancella
    // l'opzione, che per uci e' la stessa cosa - stesso motivo per cui i DNS
    // si cancellano invece di scriverli vuoti.
    try {
      await call('uci', 'delete', {
        config: 'network',
        section: info.bridge_section,
        option: 'ports',
      });
    } catch {
      // Non c'era gia' nessuna porta: niente da togliere.
    }
  }

  const network = port.network || wanNetworkName(port.name);

  if (target === 'wan') {
    if (port.network) {
      await call('uci', 'set', {
        config: 'network',
        section: network,
        values: { disabled: '0', device: port.name },
      });
    } else {
      // Nessun `ipv6`: l'opzione su una `proto dhcp` non la legge nessuno
      // (netifd non la nomina nemmeno), quindi scriverla in un senso o
      // nell'altro non cambierebbe niente. IPv6 lo accende la sezione `<net>6`
      // qui sotto, che e' l'unico meccanismo che esiste.
      //
      // `hostname: '*'` significa non mandare nessun nome nella richiesta
      // DHCP: e' il default del progetto, e una porta nuova non deve nascere
      // piu' loquace delle altre.
      await call('uci', 'add', {
        config: 'network',
        type: 'interface',
        name: network,
        values: { proto: 'dhcp', device: port.name, hostname: '*' },
      });
    }

    // La gemella IPv6, come la crea setup.sh per le altre WAN: `device` e' il
    // riferimento simbolico `@<net>`, cosi' segue la sorella v4 anche se il suo
    // device cambia. Senza questa sezione la porta nascerebbe IPv4-only, e
    // sarebbe l'unica WAN del router a esserlo.
    const network6 = `${network}6`;
    if (!(await sectionExists('network', network6))) {
      await call('uci', 'add', {
        config: 'network',
        type: 'interface',
        name: network6,
        values: { proto: 'dhcpv6', device: `@${network}` },
      });
    }

    // Le due sezioni entrano insieme nella zona firewall: una WAN v6 fuori
    // dalla zona sembrerebbe su senza far passare niente.
    const missing = [network, network6].filter((n) => !info.zone_networks.includes(n));
    if (info.zone_section && missing.length > 0) {
      await call('uci', 'set', {
        config: 'firewall',
        section: info.zone_section,
        values: { network: [...info.zone_networks, ...missing] },
      });
    }
  } else if (port.network) {
    await call('uci', 'set', {
      config: 'network',
      section: network,
      values: { disabled: '1' },
    });
  }

  if (port.mwan3) {
    await call('uci', 'set', {
      config: 'mwan3',
      section: network,
      values: { enabled: target === 'wan' ? '1' : '0' },
    });
  }
}

// --- Dispositivi collegati ----------------------------------------------------

export interface LanClient {
  mac: string;
  /** Vuoto per chi e' associato ma non ha ancora preso un indirizzo. */
  ip: string;
  /** Nome dichiarato nel DHCP o scritto a mano; vuoto se nessuno dei due. */
  name: string;
  /**
   * Indirizzi IPv6 globali, i link-local esclusi.
   *
   * Obbligatorio: leggerlo non deve mai richiedere una guardia. Ce lo mette
   * `withClientDefaults` all'ingresso, perche' un router con il pacchetto
   * vecchio questo campo non lo manda affatto.
   *
   * Possono essere tre o quattro sullo stesso dispositivo: con le estensioni di
   * privacy un telefono ne cambia uno ogni giorno e tiene i precedenti finche'
   * scadono. Per questo l'elenco mostra un dispositivo per riga e non un
   * indirizzo per riga.
   */
  ips6: string[];
  /** dhcp | arp | wifi | neigh6 — da quale elenco e' comparso. */
  source: string;
  /** wifi | ethernet | '' quando non si e' potuto stabilire. */
  via: string;
  /** Interfaccia di sistema: la porta del bridge o quella dell'access point. */
  iface: string;
  /** '2.4' | '5' | '' */
  band: string;
}

/**
 * I dispositivi visti sulla rete locale.
 *
 * Lo stesso elenco serve a due schermate: la scheda LAN lo mostra, la
 * clonazione del MAC ci sceglie dentro. E' un metodo solo anche sul router, per
 * la stessa ragione per cui e' una funzione sola qui.
 */
/** Il client come arriva dall'rpcd, dove `ips6` puo' mancare. */
type RawClient = Omit<LanClient, 'ips6'> & Partial<Pick<LanClient, 'ips6'>>;

/**
 * Riempie `ips6` e gli da' un ordine.
 *
 * Ordinare gli indirizzi di ogni dispositivo non e' cosmetica: `ip neigh` li
 * elenca nell'ordine in cui il kernel se li ritrova, che cambia fra una lettura
 * e l'altra. Senza, il "primo indirizzo v6" mostrato per un dispositivo
 * v6-only ballerebbe a ogni aggiornamento della schermata.
 */
export function withClientDefaults(raw: RawClient): LanClient {
  const ips6 = [...(raw.ips6 ?? [])].sort(compareAddresses);
  return { ...raw, ips6 };
}

/** Confronto fra due indirizzi in forma testuale, per famiglia e valore. */
function compareAddresses(a: string, b: string): number {
  const left = keyOf(a);
  const right = keyOf(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Chiave d'ordinamento di un indirizzo, con i non-indirizzi in fondo.
 *
 * `sortKey` mette tutti gli IPv4 prima di tutti gli IPv6 e confronta il valore
 * e non il testo: `localeCompare` con `numeric` azzeccava
 * "192.168.10.9 < 192.168.10.10" solo perche' li' i numeri sono separati da
 * punti, e su "fd00::9 < fd00::10" sbagliava.
 */
function keyOf(address: string): string {
  const parsed = parseIp(address);
  // '9' viene dopo il '4' e il '6' con cui sortKey prefissa le due famiglie:
  // chi non ha un indirizzo leggibile finisce in fondo senza casi speciali.
  return parsed ? sortKey(parsed) : '9';
}

export async function listClients(): Promise<LanClient[]> {
  const response = await call<{ clients?: RawClient[] }>('travel', 'clients');
  return (response.clients ?? []).map(withClientDefaults).sort((a, b) => {
    // Si ordina sull'indirizzo principale: il v4 se c'e', altrimenti il primo
    // v6. Chi non ne ha nessuno va in fondo - e' una condizione di passaggio,
    // non il caso normale da leggere per primo - e i v6-only stanno fra i due,
    // perche' 'sortKey' mette la famiglia in testa alla chiave.
    return compareAddresses(clientAddress(a), clientAddress(b));
  });
}

/**
 * Come chiamare un dispositivo in un elenco.
 *
 * Il nome se c'e', altrimenti l'indirizzo, altrimenti il MAC: qualcosa da
 * leggere c'e' sempre, e una riga che comincia con uno spazio vuoto sembra un
 * guasto dell'interfaccia invece di un dispositivo senza nome.
 */
/**
 * L'indirizzo principale di un dispositivo: il v4 se c'e', altrimenti il primo
 * v6, altrimenti niente.
 *
 * Su un dispositivo v6-only il primo v6 e' l'unico indirizzo che ha, e non
 * mostrarlo significherebbe scrivere "senza indirizzo" accanto a qualcosa che
 * in rete c'e' e risponde.
 */
export function clientAddress(client: LanClient): string {
  return client.ip || client.ips6[0] || '';
}

export function clientTitle(client: LanClient): string {
  return client.name || clientAddress(client) || client.mac;
}

/**
 * Cosa resta da dire dopo il titolo.
 *
 * `clientTitle` si prende il primo fra nome, indirizzo e MAC: qui compaiono
 * gli altri, senza ripetere quello gia' scritto sopra - una riga che dice due
 * volte lo stesso numero fa sospettare due dispositivi.
 */
export function clientDetail(client: LanClient): string {
  const parts: string[] = [];
  const address = clientAddress(client);

  if (client.name) parts.push(address || lanText().lib.noAddress);
  else if (!address) parts.push(lanText().lib.noAddress);

  // Gli altri indirizzi v6 si contano, non si elencano. Con le estensioni di
  // privacy un telefono ne ha tre o quattro contemporaneamente, e stamparli
  // tutti allunga la riga fino a renderla illeggibile senza aggiungere niente:
  // sapere che ce ne sono altri e' l'informazione, quali siano no.
  //
  // Uno e' gia' scritto se ha fatto da indirizzo principale, cioe' se non c'e'
  // un v4: quello non si conta due volte.
  const rest = client.ips6.length - (address && !client.ip ? 1 : 0);
  if (rest > 0) parts.push(`+${rest} IPv6`);

  if (client.name || address) parts.push(client.mac);
  return parts.join(' · ');
}

/**
 * Da dove entra un dispositivo, detto come lo direbbe chi guarda il router.
 *
 * Per l'ethernet si usa il nome vero della porta - lo stesso che compare nella
 * scheda qui sopra - perche' e' quello scritto accanto alla presa e l'unico che
 * permette di andare a staccare il cavo giusto.
 */
export function clientLink(client: LanClient): string {
  if (client.via === 'wifi') {
    return client.band ? `Access point ${client.band} GHz` : 'Access point';
  }
  if (client.via === 'ethernet') return client.iface || lanText().lib.cable;
  return lanText().lib.unknownLink;
}
