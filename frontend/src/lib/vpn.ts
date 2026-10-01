/**
 * VPN (requisito F).
 *
 * Due meta' che restano distinte per tutta la fase: `travel.vpn` compone quello
 * che Tailscale sta facendo davvero insieme a quello che noi gli abbiamo
 * chiesto, perche' i due possono divergere - un exit node scelto e poi spento,
 * per dire - e la differenza e' esattamente cio' che spiega perche' il traffico
 * non esce da dove dovrebbe.
 *
 * Il kill switch invece non ha un metodo suo: e' una sola opzione `enabled` su
 * una regola di firewall che `vpn-setup.sh` ha gia' creato, quindi la scrive il
 * browser con `uci` e passa da applica-e-conferma come ogni altra modifica del
 * firewall (decisione D5). Un metodo dedicato avrebbe aggiunto una seconda
 * strada per fare la stessa cosa, con un secondo modo di sbagliarla.
 */

import { vpnText } from '../i18n/vpn';
import { call } from './ubus';
import { backendError } from './ubus-error';
import { parseIp } from './ip';

/** Gli stati che il backend di Tailscale riporta, piu' il caso "non c'e'". */
export type TsState =
  | 'NoState'
  | 'NeedsLogin'
  | 'NeedsMachineAuth'
  | 'Stopped'
  | 'Starting'
  | 'Running'
  | '';

/**
 * Un dispositivo del tailnet.
 *
 * `short` e' la prima etichetta del nome DNS ed e' quello che si mostra: il
 * resto e' il suffisso del tailnet, uguale per tutti i nodi, e ripeterlo in
 * ogni riga occupa mezza schermata di telefono per non dire niente. Il nome
 * intero resta a disposizione per i casi in cui serva davvero.
 */
export interface TailNode {
  short: string;
  name: string;
  id: string;
  ip: string;
  /** Lo dice il coordinamento di Tailscale: nessun ping parte da qui. */
  online: boolean;
  /** Si offre come uscita per il traffico. */
  exit: boolean;
}

export interface TailscaleState {
  installed: boolean;
  /** `tailscaled` sta girando adesso. */
  running: boolean;
  /** Riparte da solo dopo un riavvio. Non e' la stessa cosa di `running`, e la
   *  differenza si scopre solo dopo un blackout - cioe' troppo tardi. */
  boot: boolean;
  state: TsState;
  /** Indirizzo da aprire per autenticarsi; c'e' solo mentre il login e' in ballo. */
  auth_url: string;
  version: string;
  /** Nome intero, con il suffisso del tailnet. */
  self_name: string;
  /** Prima etichetta del nome: e' quella che si mostra. */
  self_short: string;
  self_ip: string;
  self_online: boolean;
  exit_node_id: string;
  exit_node_online: boolean;
  /**
   * Il tailnet considera questo router un'uscita utilizzabile.
   *
   * E' cosa diversa dall'averlo chiesto: un exit node annunciato non funziona
   * finche' non viene autorizzato dalla console di Tailscale, ed e' il
   * passaggio che tutti dimenticano.
   */
  self_exit_node: boolean;
  /**
   * L'inoltro IP del kernel: senza, il router non puo' fare da uscita.
   *
   * Puo' mancare - un router aggiornato a meta', un plugin piu' vecchio del
   * frontend - e allora vale "non lo so", che non e' la stessa cosa di
   * "spento". Chi lo legge deve distinguerli: un avviso rosso su un campo
   * assente e' una bugia detta con sicurezza, ed e' gia' successo.
   */
  ip_forward?: boolean;
  /** Il valore letto da /proc, cosi' com'e'. Serve quando i due non combaciano. */
  ip_forward_raw?: string;
  /**
   * Gli anelli della catena che fa funzionare l'exit node, uno per uno.
   *
   * "Annunciato e autorizzato" e' solo l'ultimo. Dall'esterno il sintomo di
   * ogni anello rotto e' identico - il telefono sceglie il router e non passa
   * niente - quindi si mostrano tutti, e si segna quello che manca.
   */
  exit_check?: {
    /** `tailscale0` esiste: tailscaled l'ha creata. */
    iface_present: boolean;
    /** Inoltro acceso sull'interfaccia del tunnel, che e' quella che conta. */
    iface_forward: boolean;
    /** L'inoltro `vpn -> wan` del firewall e' abilitato. */
    fw_out: boolean;
    /** fw4 in esecuzione ha regole che nominano `tailscale0`. */
    fw_loaded: boolean;
    /**
     * La regola di instradamento sopra mwan3 (pref 900) che rimanda nel
     * tunnel le risposte ai nodi del tailnet. Senza, mwan3 le manda fuori
     * dalla WAN ed e' l'anello che mancava quando tutti gli altri erano a
     * posto e non passava niente lo stesso.
     */
    route_rule: boolean;
    /**
     * La rotta `100.64.0.0/10 dev tailscale0` nella tabella di Tailscale.
     * Sul dispositivo mancava del tutto, e senza di lei la regola punta a una
     * tabella vuota: il router non raggiunge nessun peer e le risposte non
     * hanno da dove rientrare nel tunnel.
     */
    route_present: boolean;
    /**
     * Il tunnel WireGuard e' su.
     *
     * Non e' un anello rotto quando manca: e' la condizione che rende
     * interessanti i tre qui sotto. Con il tunnel su, chi ci usa come uscita
     * non esce piu' dalla WAN ma da WireGuard, e l'indirizzo che vede Internet
     * e' quello del fornitore VPN invece di quello dell'albergo.
     */
    wg_up: boolean;
    /**
     * L'inoltro fra i due tunnel e' acceso.
     *
     * Senza, il pacchetto arriva dal tailnet, l'instradamento lo manda verso
     * WireGuard e la zona lo rifiuta: i due tunnel stanno nella stessa zona
     * firewall, e una zona non inoltra su se stessa.
     */
    wg_fw: boolean;
    /** E fw4 l'ha caricata davvero, non solo scritta in uci. */
    wg_fw_loaded: boolean;
    /**
     * La regola di instradamento (pref 901) che manda in WireGuard tutto cio'
     * che sarebbe uscito dalla WAN. Senza, il traffico esce lo stesso - ma
     * dalla WAN, e l'indirizzo finale non e' quello della VPN.
     */
    wg_route_rule: boolean;
  };
  /** Tutti i nodi del tailnet, uscite comprese. */
  nodes: TailNode[];
}

export interface TsSettings {
  exit_node: string;
  accept_routes: boolean;
  accept_dns: boolean;
  advertise_lan: boolean;
  /** Il router si offre come uscita agli altri nodi del tailnet. */
  advertise_exit: boolean;
  /** La sottorete che verrebbe annunciata, calcolata dal router. */
  lan_cidr: string;
  /**
   * La sottorete IPv6 annunciata, che e' sempre e solo l'ULA.
   *
   * Mai il prefisso globale delegato dal provider: quello cambia a ogni
   * albergo, e una rotta annunciata al tailnet gli sopravvivrebbe diventando un
   * buco nero. Vuota se il router non ha un ULA sulla LAN.
   */
  lan_cidr6: string;
}

export interface KillSwitch {
  /** Cosa vuole l'utente. */
  on: boolean;
  /** Cosa sta facendo il firewall adesso: durante una sospensione i due divergono. */
  blocking: boolean;
  /** Epoch in cui il daemon lo rimette su, 0 se non c'e' nessuna sospensione. */
  resume_at: number;
  /** La regola di firewall esiste: senza, non c'e' niente da accendere. */
  ready: boolean;
}

/** Le tre cose che possono decidere da dove esce il traffico. */
export type PolicyHolder = 'balance' | 'ts_exit' | 'wireguard';

/**
 * Chi sta decidendo dove esce il traffico, e cosa questo blocca.
 *
 * **Al massimo uno dei tre alla volta.** I quattro vincoli che sembrano
 * distinti - in bilanciamento niente exit node, con WireGuard niente
 * bilanciamento, WireGuard ed exit node incompatibili - sono lo stesso
 * enunciato visto da tre lati: sono tre modi di decidere la stessa cosa, e due
 * decisioni contemporanee sulla stessa cosa non esistono.
 *
 * **La regola sta sul router, non qui.** Questo oggetto arriva gia' risolto:
 * per ogni opzione, chi la blocca e con quale frase. La UI spegne e mostra, non
 * calcola. Una seconda copia della logica nel frontend sarebbe una copia che
 * prima o poi diverge, e divergerebbe nel caso raro - che qui vuol dire: in
 * albergo, di sera, senza SSH.
 */
export interface VpnPolicy {
  balance: boolean;
  ts_exit: boolean;
  wireguard: boolean;
  /** Per ogni opzione: chi la sta bloccando, stringa vuota se e' libera. */
  blocked_by: Record<PolicyHolder, string>;
  /** Per ogni opzione: perche', gia' scritto per esteso. */
  reason: Record<PolicyHolder, string>;
}

export interface VpnState {
  tailscale: TailscaleState;
  settings: TsSettings;
  killswitch: KillSwitch;
  policy?: VpnPolicy;
}

/** Vero se quell'opzione e' bloccata da qualcos'altro. */
export function blocked(policy: VpnPolicy | undefined, what: PolicyHolder): boolean {
  return Boolean(policy?.blocked_by?.[what]);
}

/** Perche' e' bloccata, gia' pronta da mostrare. Vuota se non lo e'. */
export function blockReason(policy: VpnPolicy | undefined, what: PolicyHolder): string {
  const backend = policy?.reason?.[what] ?? '';
  // La frase la scrive il router, in italiano; qui si riscrive nella lingua
  // dell'interfaccia partendo da chi blocca. Il nome del profilo WireGuard sta
  // solo nella frase, fra virgolette. Un occupante che non conosciamo (un
  // router piu' nuovo del frontend) si mostra com'e'.
  const t = vpnText().lib.policy;
  switch (policy?.blocked_by?.[what]) {
    case 'balance':
      return t.balance;
    case 'ts_exit':
      return t.ts_exit;
    case 'wireguard':
      return t.wireguard(/"([^"]*)"/.exec(backend)?.[1] ?? '');
    default:
      return backend;
  }
}

// --- WireGuard (Fase 6b) -----------------------------------------------------

export interface WgConfig {
  addresses: string;
  mtu: string;
  dns: string;
  /** La chiave privata non esce mai dal router: si sa solo che c'e' (D3). */
  has_private_key: boolean;
  peer_key: string;
  has_preshared: boolean;
  endpoint: string;
  port: string;
  allowed_ips: string;
  keepalive: string;
}

export interface WgStatus {
  device_up: boolean;
  /** Epoch dell'ultimo handshake, 0 se non e' mai avvenuto. */
  last_handshake: number;
  rx: number;
  tx: number;
  peer_endpoint: string;
  /** L'ora del router: i confronti si fanno con la sua, non con quella del telefono. */
  now: number;
}

/**
 * La catena che porta il traffico dei client dentro il tunnel.
 *
 * Esiste perche' ogni anello rotto ha il sintomo identico e ingannevole: il
 * tunnel fa handshake, la scheda dice "attivo", e i client escono lo stesso
 * dalla WAN. Senza questa lista si va a tentativi - ed e' andata cosi' la
 * prima volta.
 */
export interface WgRouting {
  device_up: boolean;
  /** La regola che manda il traffico nella tabella del tunnel (pref 901). */
  rule: boolean;
  /** La rotta predefinita dentro il tunnel, in tabella 53. */
  route: boolean;
  /** L'interfaccia e' nella zona firewall del tunnel. */
  in_zone: boolean;
  /**
   * Le due gemelle IPv6, che esistono solo se il profilo instrada IPv6.
   *
   * Predefinite a `false` e mostrate **soltanto** quando il profilo ha
   * AllowedIPs v6: su un tunnel v4-only sarebbero due righe rosse permanenti, e
   * un elenco con dentro un rosso che non si puo' togliere insegna a ignorare
   * l'elenco - cioe' toglie valore anche alle righe che contano.
   */
  route6?: boolean;
  rule6?: boolean;
  /** Il profilo acceso instrada davvero qualcosa di IPv6. */
  has_v6?: boolean;
}

/**
 * Una configurazione WireGuard salvata.
 *
 * `id` e' il nome della sezione uci, che su OpenWrt e' anche il nome
 * dell'interfaccia: non e' un identificatore inventato dal frontend, ed e' per
 * questo che non puo' divergere da niente. `name` invece lo sceglie chi salva,
 * ed e' l'unica cosa con cui poi distingue due tunnel dello stesso provider.
 */
export interface WgProfile {
  id: string;
  name: string;
  /** Questo profilo e' quello acceso. Al massimo uno lo e'. */
  active: boolean;
  /**
   * Ha un nome vero, dato da una persona.
   *
   * Falso solo per il tunnel unico che arriva da una versione precedente: li'
   * `name` e' l'endpoint, cioe' l'unica cosa che lo distingueva quando i tunnel
   * erano uno. Serve alla UI per invitare a dargliene uno, non per nasconderlo.
   */
  named: boolean;
  config: WgConfig;
}

export interface WgState {
  installed: boolean;
  /** Almeno una configurazione salvata. */
  configured: boolean;
  /** Una configurazione e' accesa. */
  enabled: boolean;
  /** L'id di quella accesa, stringa vuota se non ce n'e' nessuna. */
  active?: string;
  /**
   * L'id di quella comandata dall'interruttore fisico, stringa vuota se la
   * levetta non ne comanda nessuna.
   *
   * Arriva gia' risolto dal router, come `policy`: la UI non sa come sono fatti
   * gli id delle azioni della levetta e non deve chiederli con una seconda
   * chiamata che arriverebbe dopo la prima. Puo' mancare - un pacchetto piu'
   * vecchio di questa interfaccia - e allora vale "nessuna", che e' come si
   * comportava il router prima che l'associazione esistesse.
   */
  toggle?: string;
  profiles?: WgProfile[];
  /** La configurazione accesa, ripetuta fuori dall'elenco per comodita'. */
  config: WgConfig;
  status: WgStatus;
  routing?: WgRouting;
  policy?: VpnPolicy;
}

/**
 * I campi di un profilo, come li compila un modulo.
 *
 * I segreti sono stringhe come le altre, ma vuote vogliono dire "lascia quello
 * che c'e'": il browser non li ha mai avuti (D3) e quindi non li puo'
 * rimandare indietro. Togliere una chiave precondivisa e' una richiesta a se',
 * `drop_preshared`, perche' un campo lasciato in bianco non e' una richiesta.
 */
export interface WgFields {
  name: string;
  addresses: string;
  dns: string;
  mtu: string;
  private_key: string;
  peer_key: string;
  preshared_key: string;
  drop_preshared: boolean;
  endpoint: string;
  port: string;
  allowed_ips: string;
  keepalive: string;
}

export function getWg(): Promise<WgState> {
  return call<WgState>('travel', 'wg_get');
}

/**
 * Le configurazioni salvate.
 *
 * Con un plugin piu' vecchio del frontend l'elenco non c'e': allora si mostra
 * il tunnel unico come profilo singolo, invece di una schermata vuota che
 * direbbe "non hai niente" a chi ha un tunnel acceso.
 */
export function wgProfiles(wg: WgState): WgProfile[] {
  if (wg.profiles) return wg.profiles;
  if (!wg.configured) return [];
  return [
    {
      id: 'travel_wg',
      name: wg.config.endpoint || 'WireGuard',
      active: wg.enabled,
      named: false,
      config: wg.config,
    },
  ];
}

/** Quella accesa, o niente. */
export function wgActiveProfile(wg: WgState): WgProfile | null {
  return wgProfiles(wg).find((p) => p.active) ?? null;
}

/**
 * Quella comandata dall'interruttore fisico, o niente.
 *
 * Finche' c'e', accendere e spegnere dall'interfaccia non si puo': la levetta
 * resterebbe dov'e', e schermo, tunnel e levetta direbbero tre cose diverse.
 * Il resto della gestione non e' toccato - si guarda, si modifica, si reimporta
 * come sempre: il divieto riguarda solo chi decide se il tunnel e' su.
 */
export function wgToggleProfile(wg: WgState): WgProfile | null {
  if (!wg.toggle) return null;
  return wgProfiles(wg).find((p) => p.id === wg.toggle) ?? null;
}

/** L'interruttore fisico comanda WireGuard: da qui si guarda e basta. */
export function wgLockedByToggle(wg: WgState): boolean {
  return Boolean(wg.toggle);
}

/**
 * Accende o spegne una configurazione.
 *
 * Il router rifiuta l'accensione quando qualcos'altro sta gia' decidendo dove
 * esce il traffico - un'altra configurazione WireGuard compresa - e l'errore
 * che torna e' gia' la frase da mostrare. La UI spegne il pulsante prima, ma il
 * controllo vero e' li': e' l'unico punto da cui non si passa per sbaglio.
 */
export async function wgToggle(enabled: boolean, id: string): Promise<void> {
  const result = await call<{ error?: string }>(
    'travel',
    'wg_toggle',
    { enabled: enabled ? '1' : '0', id },
    30_000,
  );
  if (result.error) throw backendError(result);
}

/**
 * Importa una configurazione incollata: un profilo nuovo, o uno esistente
 * rifatto da capo.
 *
 * Il nome e' obbligatorio quando il profilo e' nuovo, ed e' il router a
 * rifiutare senza. Un profilo nuovo nasce **spento**: importare non e'
 * accendere, cosi' anche la prima accensione passa dal controllo dei vincoli e
 * non esiste una scorciatoia che li aggira. Reimportare sopra un profilo acceso
 * invece non lo spegne - e' una modifica.
 */
export async function wgImport(
  config: string,
  name: string,
  id = '',
): Promise<{ id: string; endpoint: string }> {
  const result = await call<{ id?: string; endpoint?: string; error?: string }>(
    'travel',
    'wg_import',
    { config, name, id },
    30_000,
  );
  if (result.error) throw backendError(result);
  return { id: result.id ?? '', endpoint: result.endpoint ?? '' };
}

/**
 * Salva i parametri di una configurazione, e solo di quella.
 *
 * Si mandano tutti i campi sempre: il router li prende come lo stato completo
 * del profilo, perche' in shell "campo assente" e "campo vuoto" sono la stessa
 * cosa e indovinare quale sia cancellerebbe in silenzio i DNS di qualcuno.
 */
export async function wgSave(id: string, fields: WgFields): Promise<void> {
  const result = await call<{ error?: string }>(
    'travel',
    'wg_save',
    { id, ...fields, drop_preshared: fields.drop_preshared ? '1' : '0' },
    30_000,
  );
  if (result.error) throw backendError(result);
}

/**
 * Elimina una configurazione salvata.
 *
 * Il router rifiuta di eliminare quella accesa: toglierebbe da sotto al
 * traffico l'interfaccia in cui sta passando. Si spegne, poi si elimina.
 */
export async function wgDelete(id: string): Promise<void> {
  const result = await call<{ error?: string }>('travel', 'wg_delete', { id }, 30_000);
  if (result.error) throw backendError(result);
}

/** Byte del tunnel. Sta qui e non in dashboard.ts: e' l'unico posto che li usa. */
export function formatWgBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}

/** Da quanto tempo l'ultimo handshake, secondo l'orologio del router. */
export function handshakeAge(status: WgStatus): string {
  const t = vpnText().lib;
  if (!status.last_handshake) return t.never;
  const seconds = Math.max(0, status.now - status.last_handshake);
  if (seconds < 60) return t.secondsAgo(seconds);
  if (seconds < 3600) return t.minutesAgo(Math.round(seconds / 60));
  return t.hoursAgo(Math.round(seconds / 3600));
}

/**
 * Il tunnel sta davvero passando traffico?
 *
 * Un handshake vecchio di piu' di tre minuti su un tunnel con keepalive
 * significa che il peer non risponde piu': il device e' su, la configurazione
 * sembra a posto, e non passa niente. E' lo stesso genere di distinzione fra
 * "collegato" e "funziona" che regge tutto il resto dell'interfaccia.
 */
export function wgAlive(status: WgStatus): boolean {
  if (!status.device_up || !status.last_handshake) return false;
  return status.now - status.last_handshake < 180;
}

/**
 * Gli anelli fra "il tunnel e' su" e "i client ci passano dentro".
 *
 * L'ordine e' quello del pacchetto: l'interfaccia esiste, una rotta dentro il
 * tunnel, una regola che ce lo manda, e il firewall che lo lascia passare. Ogni
 * anello rotto ha il sintomo identico e ingannevole - handshake a posto, scheda
 * che dice "attivo", client che escono lo stesso dalla WAN - quindi si mostrano
 * tutti e si segna quello che manca.
 *
 * Sta qui e non nella scheda perche' la stessa domanda la fa anche il kill
 * switch: "c'e' un tunnel che porta il traffico?" deve avere una risposta sola.
 */
/**
 * Cosa non va nell'endpoint scritto a mano, stringa vuota se va bene.
 *
 * Rispecchia `valid_wg_host` sul router, dove quel campo fino a ora non veniva
 * controllato affatto: un endpoint sbagliato si scriveva, il tunnel si creava, e
 * il guasto si scopriva solo dal log di netifd - che dice unicamente che
 * l'handshake non arriva.
 *
 * Qui un IPv6 si accetta anche NUDO, al contrario che sul router: e' la forma in
 * cui lo si incolla da un file `.conf`, e le parentesi gliele mette
 * `wg_split_endpoint` quando lo salva.
 */
export function wgEndpointProblem(host: string): string {
  const text = host.trim();
  if (text === '') return '';

  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  if (parseIp(bare)) return '';

  // Due punti e non e' un indirizzo: quasi sempre e' un IPv6 troncato, oppure
  // ci si e' attaccata la porta. Vale la pena dirlo, perche' e' l'errore che
  // questa fase esiste per rendere visibile.
  if (bare.includes(':')) {
    return vpnText().lib.endpointV6;
  }

  const hostname = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
  return hostname.test(bare) ? '' : vpnText().lib.endpointBad;
}

export function wgRoutingSteps(
  wg: WgState,
): Array<{ ok: boolean; label: string; fix: string; advisory?: boolean }> {
  const r = wg.routing;
  if (!r) return [];
  const t = vpnText().lib.steps;
  return [
    {
      ok: r.device_up,
      // Con il nome vero dell'interfaccia: i profili sono tanti, e chi va a
      // guardare in `ip link` deve sapere quale cercare.
      label: t.device(wg.active || 'travel_wg'),
      fix: t.deviceFix,
    },
    {
      ok: r.route,
      label: t.route,
      fix: t.routeFix,
    },
    {
      ok: r.rule,
      label: t.rule,
      fix: t.ruleFix,
    },
    {
      ok: r.in_zone,
      label: t.zone,
      fix: t.zoneFix,
    },
    // Le due righe IPv6 compaiono solo se il profilo instrada IPv6. Un tunnel
    // v4-only non ha niente da instradare in v6, e segnarlo come mancante
    // sarebbe segnalare l'assenza di qualcosa che non deve esserci.
    //
    // Sono `advisory`, e la distinzione e' portante: dicono che una PARTE del
    // traffico non passa dal tunnel, non che il tunnel non porta traffico.
    // Vedi `wgCarrying`.
    ...(r.has_v6
      ? [
          {
            ok: r.route6 === true,
            label: t.route6,
            fix: t.route6Fix,
            advisory: true,
          },
          {
            ok: r.rule6 === true,
            label: t.rule6,
            fix: t.rule6Fix,
            advisory: true,
          },
        ]
      : []),
  ];
}

/**
 * WireGuard sta portando il traffico dei client, adesso.
 *
 * Acceso, con handshake recente, e con la catena intera: solo allora. "Attivo"
 * da solo non lo garantisce - e' la stessa distinzione fra collegato e
 * funzionante che regge tutta l'interfaccia.
 *
 * Quando il router non sa raccontare la catena (`routing` assente: un plugin
 * piu' vecchio del frontend) restano acceso e handshake. E' una risposta meno
 * precisa, ma "non lo so" qui non puo' valere "no": varrebbe dire a chi ha il
 * tunnel su e Internet che funziona che non e' protetto da niente.
 */
export function wgCarrying(wg: WgState): boolean {
  if (!wg.enabled || !wgAlive(wg.status)) return false;
  // Le righe `advisory` - quelle IPv6 - non entrano nel verdetto, e lasciarcele
  // sarebbe stato un errore serio: una rotta v6 mancante significa che una
  // PARTE del traffico non passa dal tunnel, non che il tunnel non porta
  // traffico. Contandole, un tunnel che porta IPv4 benissimo risulterebbe
  // spento - ed e' lo stato normale di ogni router finche' `vpn-setup.sh
  // runtime` non e' stato rieseguito dopo l'aggiornamento.
  //
  // Conta anche dove finisce questa risposta: `killSwitchHasTunnel` la usa per
  // decidere se un tunnel c'e'. Un "no" li' direbbe a chi ha il tunnel su e
  // Internet che funziona di non essere protetto da niente. E la perdita v6 che
  // le righe segnalano il kill switch la chiude comunque: la sua regola e'
  // dual-family (Fase 0), quindi acceso blocca anche quella.
  return wgRoutingSteps(wg).every((step) => step.ok || step.advisory === true);
}

export async function getVpn(): Promise<VpnState> {
  const vpn = await call<VpnState>('travel', 'vpn');
  // Riempito al confine: un router con il pacchetto vecchio questo campo non lo
  // manda, e la schermata non deve saperlo.
  return { ...vpn, settings: { ...vpn.settings, lan_cidr6: vpn.settings?.lan_cidr6 ?? '' } };
}

/**
 * Avvia il servizio e fa partire l'autenticazione.
 *
 * Senza auth key parte il login interattivo: il router aspetta qualche secondo
 * che compaia l'indirizzo da aprire e lo restituisce, cosi' la schermata ha
 * subito qualcosa da mostrare invece di dire "premi e spera". Con l'auth key
 * non c'e' niente da aprire e si torna gia' collegati.
 *
 * Puo' metterci parecchio: avvio del daemon, attesa dell'indirizzo, e in mezzo
 * una rete che potrebbe non funzionare. Il timeout e' largo di conseguenza.
 */
export async function tsLogin(authkey = ''): Promise<{ auth_url: string; output: string }> {
  const result = await call<{ auth_url?: string; output?: string; error?: string }>(
    'travel',
    'ts_login',
    { authkey },
    60_000,
  );
  if (result.error) throw backendError(result);
  return { auth_url: result.auth_url ?? '', output: result.output ?? '' };
}

/**
 * Scrive le impostazioni e le fa prendere effetto.
 *
 * Stesso schema di mwan3 e della porta USB: la scrittura passa da uci, il
 * comando che la mette in atto sta sul router. `tailscale set` non richiede di
 * rifare il login, quindi cambiare exit node non scollega.
 *
 * Gli inoltri del firewall che accompagnano "annuncia" li sistema `ts_apply`
 * insieme al resto, e non questo codice: offrirsi come uscita e' una cosa sola
 * fatta di due scritture, e separarle fra browser e router lascerebbe che
 * divergano - un router che dice al tailnet "passate da me" e poi butta via il
 * traffico, senza che niente lo spieghi.
 */
export async function saveTailscale(settings: {
  exit_node: string;
  accept_routes: boolean;
  accept_dns: boolean;
  advertise_lan: boolean;
  advertise_exit: boolean;
}): Promise<void> {
  await call('uci', 'set', {
    config: 'travel',
    section: 'tailscale',
    values: {
      exit_node: settings.exit_node,
      accept_routes: settings.accept_routes ? '1' : '0',
      accept_dns: settings.accept_dns ? '1' : '0',
      advertise_lan: settings.advertise_lan ? '1' : '0',
      advertise_exit: settings.advertise_exit ? '1' : '0',
    },
  });
  await call('uci', 'apply', {});

  const result = await call<{ applied?: boolean; error?: string }>(
    'travel',
    'ts_apply',
    {},
    30_000,
  );
  if (result.error) throw backendError(result);
}

/**
 * Il router e' gia' dentro un tailnet: manca solo rialzare il tunnel.
 *
 * E' la differenza fra "non ho un account" e "ho un account e sono giu'", ed e'
 * l'unica cosa che decide se mostrare un accesso da fare o un interruttore da
 * riaccendere. Chi ha appena premuto *Disconnetti* non ha perso niente, ma un
 * pulsante *Accedi* glielo lascerebbe credere.
 *
 * Lo dice il backend di Tailscale, che i due casi li distingue gia': `NeedsLogin`
 * e `NoState` sono il primo, tutto il resto il secondo. Se `tailscaled` non gira
 * non lo sappiamo, e qui "non lo so" vale come "no": si mostra l'accesso, che
 * funziona in tutti e due i casi, mentre un *Accendi* su un account che non
 * c'e' porterebbe in un vicolo cieco.
 */
export function tsAuthenticated(ts: TailscaleState): boolean {
  if (!ts.installed || !ts.running) return false;
  return ts.state !== '' && ts.state !== 'NeedsLogin' && ts.state !== 'NoState';
}

/**
 * Rialza il tunnel su un account che c'e' gia'.
 *
 * E' lo stesso `tailscale up` del primo accesso, non un secondo comando: con la
 * sessione ancora valida non c'e' nessun indirizzo da aprire e il nodo torna su
 * e basta. Una strada sola per alzare il tunnel vuol dire un posto solo in cui
 * puo' rompersi.
 */
export async function tsUp(): Promise<void> {
  await tsLogin();
}

/** Stacca il tunnel senza perdere l'autenticazione: si torna su con un tocco. */
export async function tsDown(): Promise<void> {
  const result = await call<{ error?: string }>('travel', 'ts_down', {}, 30_000);
  if (result.error) throw backendError(result);
}

/** Esce dall'account e ferma il servizio, anche al boot. */
export async function tsLogout(): Promise<void> {
  const result = await call<{ error?: string }>('travel', 'ts_logout', {}, 30_000);
  if (result.error) throw backendError(result);
}

/**
 * Prepara l'accensione o lo spegnimento del kill switch.
 *
 * Non applica niente: ci pensa `useApply`, che poi arma il ritorno indietro
 * automatico. Serve perche' e' una modifica del firewall, ed e' il caso che la
 * decisione D5 elenca per nome.
 *
 * Le due scritture stanno insieme di proposito: la regola di firewall e'
 * l'effetto, `travel.vpn.killswitch` e' l'intenzione, e uno stato in cui una
 * dice si' e l'altra no non deve poter esistere - e' proprio quello che
 * l'interfaccia userebbe per decidere cosa mostrare.
 */
export async function stageKillSwitch(on: boolean): Promise<void> {
  await call('uci', 'set', {
    config: 'firewall',
    section: 'travel_killswitch',
    values: { enabled: on ? '1' : '0' },
  });
  await call('uci', 'set', {
    config: 'travel',
    section: 'vpn',
    // Spegnendolo si annulla anche una sospensione in corso: altrimenti il
    // daemon lo riaccenderebbe da solo qualche minuto dopo, contraddicendo
    // l'ultima cosa che gli e' stata chiesta.
    values: { killswitch: on ? '1' : '0', resume_at: '0' },
  });
}

/**
 * Apre un varco a tempo, per fare il login a un captive portal.
 *
 * Attraverso un kill switch il login a un portale non si puo' fare: la pagina
 * non si carica, e un'eccezione mirata su un indirizzo solo non basterebbe
 * comunque, perche' quelle pagine tirano risorse da mezzo mondo. Quindi si apre
 * davvero, ma per un tempo dichiarato e con il riarmo affidato al router.
 *
 * Non passa da applica-e-conferma: questa modifica *apre* soltanto, quindi non
 * puo' chiudere fuori nessuno, e un conto alla rovescia sopra un altro conto
 * alla rovescia sarebbe solo confusione.
 */
export async function suspendKillSwitch(minutes: number): Promise<void> {
  const resumeAt = Math.floor(Date.now() / 1000) + minutes * 60;

  await call('uci', 'set', {
    config: 'firewall',
    section: 'travel_killswitch',
    values: { enabled: '0' },
  });
  await call('uci', 'set', {
    config: 'travel',
    section: 'vpn',
    values: { resume_at: String(resumeAt) },
  });
  await call('uci', 'apply', {});
}

/** Rimette subito il kill switch, senza aspettare la scadenza. */
export async function resumeKillSwitch(): Promise<void> {
  await call('uci', 'set', {
    config: 'firewall',
    section: 'travel_killswitch',
    values: { enabled: '1' },
  });
  await call('uci', 'set', {
    config: 'travel',
    section: 'vpn',
    values: { resume_at: '0' },
  });
  await call('uci', 'apply', {});
}

export function tsStateLabel(state: string): string {
  return vpnText().lib.tsState[state] ?? (state || vpnText().lib.unknown);
}

/**
 * Il kill switch morde davvero?
 *
 * La domanda e' una sola - c'e' un tunnel che porta fuori il traffico dei
 * client? - ma i tunnel sono due, e vanno guardati tutti e due. Con Tailscale la
 * risposta e' "solo con un exit node": senza, Tailscale e' una rete verso i
 * propri dispositivi e il traffico normale continua a uscire dalla WAN. Con
 * WireGuard basta che il tunnel porti il traffico, perche' e' il suo mestiere.
 *
 * Guardarne uno solo e' gia' costato un avviso rosso su un router che stava
 * lavorando benissimo: tunnel WireGuard su, Internet funzionante, e la schermata
 * che diceva "i client non hanno Internet". Un interruttore acceso che non
 * protegge niente e' peggio di uno spento, ma un allarme che grida al vuoto lo
 * e' altrettanto - dopo il primo non lo si legge piu'.
 *
 * `wg` puo' mancare mentre la sua chiamata e' ancora in volo: in quel momento
 * si sa solo di Tailscale, e chi chiama deve trattare quel "non lo so" per
 * quello che e' invece di leggerlo come un no.
 */
export function killSwitchHasTunnel(vpn: VpnState, wg?: WgState | null): boolean {
  const viaTailscale =
    vpn.tailscale.state === 'Running' &&
    vpn.settings.exit_node !== '' &&
    vpn.tailscale.exit_node_id !== '';

  return viaTailscale || (wg != null && wgCarrying(wg));
}

/**
 * I nodi che si offrono come uscita, in linea per primi.
 *
 * L'ordine conta piu' di quanto sembri: un exit node offline non serve a
 * niente, e in un tailnet con parecchi dispositivi finirebbe comunque in mezzo
 * a quelli buoni facendoli cercare.
 */
export function exitNodes(vpn: VpnState): TailNode[] {
  return byPresence(vpn.tailscale.nodes.filter((node) => node.exit));
}

/** Tutti i nodi, con lo stesso criterio: chi c'e' adesso viene prima. */
export function allNodes(vpn: VpnState): TailNode[] {
  return byPresence(vpn.tailscale.nodes);
}

function byPresence(nodes: TailNode[]): TailNode[] {
  return [...nodes].sort(
    (a, b) => Number(b.online) - Number(a.online) || a.short.localeCompare(b.short),
  );
}

/**
 * Il nodo scelto come uscita, se lo riconosciamo.
 *
 * Il valore salvato puo' essere un indirizzo o un nome - `tailscale` accetta
 * entrambi, e le configurazioni scritte prima di questa versione hanno il nome
 * intero - quindi si confronta con tutte e tre le forme invece di pretenderne
 * una. Una impostazione che smette di essere riconosciuta dopo un aggiornamento
 * e' il modo piu' silenzioso di rompere qualcosa che funzionava.
 */
export function exitNodeOf(vpn: VpnState): TailNode | null {
  const chosen = vpn.settings.exit_node;
  if (!chosen) return null;
  return (
    vpn.tailscale.nodes.find(
      (node) => node.ip === chosen || node.name === chosen || node.short === chosen,
    ) ?? null
  );
}

/** Come chiamare l'uscita scelta: il nome corto se lo conosciamo, altrimenti il valore grezzo. */
export function exitNodeLabel(vpn: VpnState): string {
  if (!vpn.settings.exit_node) return vpnText().lib.none;
  return exitNodeOf(vpn)?.short ?? vpn.settings.exit_node;
}

/**
 * Cosa scrivere in `exit_node` scegliendo un nodo.
 *
 * L'indirizzo e non il nome: `--exit-node` accetta entrambi, ma il nome dipende
 * da MagicDNS e cambia se il dispositivo viene rinominato, mentre l'indirizzo
 * del tailnet resta quello. Se mancasse si ripiega sul nome, che e' comunque
 * meglio di un'impostazione vuota.
 */
export function exitNodeValue(node: TailNode): string {
  return node.ip || node.name;
}

/** Quanto manca al riarmo, in minuti arrotondati per eccesso. */
export function minutesLeft(resumeAt: number): number {
  if (!resumeAt) return 0;
  return Math.max(0, Math.ceil((resumeAt - Date.now() / 1000) / 60));
}
