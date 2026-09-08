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

import { call } from './ubus';
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
  /** DNS annunciati ai client via DHCP. Vuoto = il router stesso. */
  dns_client: string[];
  /** Resolver che usa il router. Vuoto = quelli che arrivano dalla WAN. */
  dns_upstream: string[];
  /** Nome reale della sezione dnsmasq: `@dnsmasq[0]` non e' accettato da ubus. */
  dnsmasq_section: string;
  /** Tutte le dhcp_option, per riscrivere solo la 6 senza perdere le altre. */
  dhcp_options: string[];
}

export async function getLan(): Promise<LanConfig> {
  const lan = await call<LanConfig>('travel', 'lan');
  // Normalizzato al confine: da qui in giu' un indirizzo e' un indirizzo, mai
  // un indirizzo con la maschera attaccata.
  return { ...lan, addresses: (lan.addresses ?? []).map(stripPrefix) };
}

// --- Aritmetica delle sottoreti ----------------------------------------------

export function ipToInt(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = value * 256 + byte;
  }
  return value;
}

export function intToIp(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

export function isValidIp(ip: string): boolean {
  return ipToInt(ip) !== null;
}

/** Vero per le maschere contigue: 255.255.255.0 sì, 255.0.255.0 no. */
export function isValidNetmask(mask: string): boolean {
  const value = ipToInt(mask);
  if (value === null) return false;
  // Una maschera valida e' una sequenza di 1 seguita da una di 0: il
  // complemento piu' uno deve essere una potenza di due.
  const inverted = ~value >>> 0;
  return (inverted & (inverted + 1)) === 0;
}

export interface Subnet {
  network: number;
  mask: number;
}

export function subnetOf(ip: string, mask: string): Subnet | null {
  const address = ipToInt(ip);
  const maskValue = ipToInt(mask);
  if (address === null || maskValue === null) return null;
  return { network: (address & maskValue) >>> 0, mask: maskValue };
}

/** Due sottoreti si sovrappongono se una contiene la rete dell'altra. */
export function overlaps(a: Subnet, b: Subnet): boolean {
  const common = (a.mask & b.mask) >>> 0;
  return ((a.network & common) >>> 0) === ((b.network & common) >>> 0);
}

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
 */
export function findConflicts(
  lanIp: string,
  lanMask: string,
  wans: WanSubnet[],
): Conflict[] {
  const lan = subnetOf(lanIp, lanMask);
  if (!lan) return [];

  const conflicts: Conflict[] = [];
  for (const wan of wans) {
    if (!wan.ipv4) continue;
    const other = subnetOf(wan.ipv4, wan.netmask || '255.255.255.0');
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
 */
export function stripPrefix(address: string): string {
  return address.trim().split('/')[0].trim();
}

/** Prefisso /24 di un indirizzo, per mostrare la rete che ne deriva. */
export function prefix24(address: string): string {
  const parts = stripPrefix(address).split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') : '';
}

/** Ultimo ottetto, oppure null se l'indirizzo non e' valido. */
export function lastOctet(address: string): number | null {
  const value = ipToInt(stripPrefix(address));
  return value === null ? null : value & 255;
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
}

const PROVIDERS: DnsProvider[] = [
  { id: 'google', label: 'Google DNS', servers: ['8.8.8.8', '8.8.4.4'] },
  { id: 'cloudflare', label: 'Cloudflare', servers: ['1.1.1.1', '1.0.0.1'] },
  { id: 'quad9', label: 'Quad9', servers: ['9.9.9.9', '149.112.112.112'] },
  { id: 'adguard', label: 'AdGuard DNS', servers: ['94.140.14.14', '94.140.15.15'] },
];

/** Opzioni per i DNS annunciati ai dispositivi: l'automatico e' il router. */
export const CLIENT_DNS_OPTIONS: DnsProvider[] = [
  { id: 'auto', label: 'Automatico / Router', servers: [] },
  ...PROVIDERS,
  { id: 'custom', label: 'Personalizzato', servers: [] },
];

/** Opzioni per i resolver del router: l'automatico sono quelli della WAN. */
export const ROUTER_DNS_OPTIONS: DnsProvider[] = [
  ...PROVIDERS,
  { id: 'auto', label: 'Automatico / DNS della WAN', servers: [] },
  { id: 'custom', label: 'Personalizzato', servers: [] },
];

/**
 * Quale voce dell'elenco corrisponde a una configurazione esistente.
 *
 * La tendina mostra sempre lo stato reale: far comparire un fornitore che non e'
 * quello in uso farebbe credere di avere una configurazione che non si ha.
 */
export function matchDnsProvider(servers: string[], options: DnsProvider[]): string {
  if (servers.length === 0) return 'auto';

  for (const option of options) {
    if (option.servers.length === 0) continue;
    if (
      option.servers.length === servers.length &&
      option.servers.every((s, i) => s === servers[i])
    ) {
      return option.id;
    }
  }
  return 'custom';
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
  dnsClient: string[];
  dnsUpstream: string[];
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
    return { message: 'I due valori devono essere numeri.' };
  }
  if (from < 2 || from > 254 || to < 2 || to > 254) {
    return { message: 'I valori devono stare fra 2 e 254.' };
  }
  if (from > to) {
    return { message: 'Il primo valore deve essere minore o uguale al secondo.' };
  }

  const octet = lastOctet(address);
  if (octet !== null && octet >= from && octet <= to) {
    return {
      message: `L'indirizzo del router (.${octet}) cadrebbe dentro il pool: il DHCP lo assegnerebbe a un dispositivo.`,
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

  await write('indirizzo della rete locale', {
    config: 'network',
    section: 'lan',
    values: { ipaddr: addresses, netmask: LAN_NETMASK },
  });

  // uci vuole il primo indirizzo e QUANTI, non l'ultimo: la conversione si fa
  // qui una volta sola, cosi' l'interfaccia puo' parlare di "da" e "a".
  await write('intervallo DHCP', {
    config: 'dhcp',
    section: 'lan',
    values: {
      start: String(settings.poolFrom),
      limit: String(settings.poolTo - settings.poolFrom + 1),
    },
  });

  // Si sostituisce solo l'opzione 6, davvero: le altre dhcp_option vengono
  // rimesse com'erano invece di sparire.
  const others = (current.dhcp_options ?? []).filter((o) => !o.startsWith('6,'));
  const options =
    settings.dnsClient.length > 0 ? [...others, `6,${settings.dnsClient.join(',')}`] : others;

  if (options.length > 0) {
    await write('DNS annunciati ai dispositivi', {
      config: 'dhcp',
      section: 'lan',
      values: { dhcp_option: options },
    });
  } else {
    await clear('dhcp', 'lan', 'dhcp_option');
  }

  // La sezione dnsmasq ha un nome anonimo reale: "@dnsmasq[0]" e' comodo da
  // riga di comando ma non e' quello che accetta `uci set` via ubus.
  if (current.dnsmasq_section) {
    if (settings.dnsUpstream.length > 0) {
      await write('DNS usati dal router', {
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
export async function stageEthPort(
  info: EthPorts,
  port: EthPort,
  target: PortMode,
): Promise<void> {
  if (!info.bridge_section) throw new Error('Nessun bridge br-lan trovato nella configurazione.');

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
      // IPv6 disattivato come su tutte le altre WAN: mwan3 lo gestisce a meta'
      // e i captive portal peggio. `hostname: '*'` significa non mandare
      // nessun nome nella richiesta DHCP: e' il default del progetto, e una
      // porta nuova non deve nascere piu' loquace delle altre.
      await call('uci', 'add', {
        config: 'network',
        type: 'interface',
        name: network,
        values: { proto: 'dhcp', device: port.name, ipv6: '0', hostname: '*' },
      });
    }

    if (info.zone_section && !info.zone_networks.includes(network)) {
      await call('uci', 'set', {
        config: 'firewall',
        section: info.zone_section,
        values: { network: [...info.zone_networks, network] },
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

// --- Dispositivi collegati (Fase 7) -------------------------------------------

export interface LanClient {
  mac: string;
  /** Vuoto per chi e' associato ma non ha ancora preso un indirizzo. */
  ip: string;
  /** Nome dichiarato nel DHCP o scritto a mano; vuoto se nessuno dei due. */
  name: string;
  /** dhcp | arp | wifi — da quale elenco e' comparso. */
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
export async function listClients(): Promise<LanClient[]> {
  const response = await call<{ clients?: LanClient[] }>('travel', 'clients');
  return (response.clients ?? []).sort((a, b) =>
    a.ip && b.ip
      ? a.ip.localeCompare(b.ip, undefined, { numeric: true })
      : // Chi non ha ancora un indirizzo va in fondo: e' una condizione di
        // passaggio, non il caso normale da leggere per primo.
        Number(Boolean(b.ip)) - Number(Boolean(a.ip)),
  );
}

/**
 * Come chiamare un dispositivo in un elenco.
 *
 * Il nome se c'e', altrimenti l'indirizzo, altrimenti il MAC: qualcosa da
 * leggere c'e' sempre, e una riga che comincia con uno spazio vuoto sembra un
 * guasto dell'interfaccia invece di un dispositivo senza nome.
 */
export function clientTitle(client: LanClient): string {
  return client.name || client.ip || client.mac;
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
  if (client.name) parts.push(client.ip || 'senza indirizzo');
  else if (!client.ip) parts.push('senza indirizzo');
  if (client.name || client.ip) parts.push(client.mac);
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
  if (client.via === 'ethernet') return client.iface || 'Cavo';
  return 'non determinata';
}
