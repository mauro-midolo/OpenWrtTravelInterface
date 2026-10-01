/**
 * Simulatore del bus ubus.
 *
 * Serve a sviluppare e provare l'interfaccia dal PC senza avere il router
 * acceso o raggiungibile - cioe' per la gran parte del lavoro. Si attiva da
 * solo quando si lancia `npm run dev` senza VITE_ROUTER.
 *
 * I dati rispecchiano il dispositivo vero: due radio su una sola phy, con i
 * nomi di interfaccia dello schema nuovo (phy0.0-ap0, non wlan0).
 *
 * Riproduce anche gli scenari scomodi, che sul dispositivo sono difficili da
 * ottenere a comando:
 *   - il router muto per qualche secondo dopo un apply, mentre il WiFi si
 *     riconfigura: e' li' che si vede se il conto alla rovescia regge;
 *   - la password sbagliata, usando la password "sbagliata";
 *   - le modifiche che restano in sospeso finche' non arriva la conferma.
 */

import { UBUS_NOT_FOUND, UbusError } from './ubus-error';

const bootedAt = Date.now();

function jitter(base: number, spread: number): number {
  return Math.round(base + (Math.random() - 0.5) * spread);
}

/** Quanto resta muto il router dopo un apply, mentre il WiFi si riconfigura. */
const BLACKOUT_MS = 9000;
/** Quanto ci mette la STA a prendere un indirizzo dopo essersi agganciata. */
const DHCP_MS = 5000;
/**
 * Quanto resta associata una STA con la password sbagliata.
 *
 * Non zero, ed e' il punto: con WPA l'associazione riesce comunque, ed e'
 * l'handshake a quattro vie che fallisce subito dopo. Per quei pochi secondi
 * l'uplink mostra l'SSID senza indirizzo - identico a un DHCP lento - e chi
 * guarda una volta sola in quella finestra scambia un rifiuto per un'attesa.
 * Il simulatore la riproduce perche' e' proprio li' che la schermata puo'
 * sbagliare verdetto.
 */
const HANDSHAKE_MS = 3000;

interface MockSta {
  ssid: string;
  key: string;
  mac: string;
  since: number;
}

interface MockRadio {
  band: '2.4' | '5';
  index: number;
  channel: number;
  apEnabled: boolean;
  sta: MockSta | null;
}

const radios: Record<string, MockRadio> = {
  radio0: { band: '2.4', index: 0, channel: 1, apEnabled: true, sta: null },
  radio1: { band: '5', index: 1, channel: 36, apEnabled: true, sta: null },
};

/** L'access point e' uno solo, condiviso dalle due radio. */
const ap = { ssid: 'ciao', encryption: 'sae-mixed', hasKey: true };

interface MockSaved {
  section: string;
  ssid: string;
  encryption: string;
  /** Come su uci: vuoto = tutte e due le bande, altrimenti "2.4" o "5". */
  band: string;
  hidden: boolean;
  /**
   * Il MAC condiviso, per le versioni del pacchetto che non conoscono ancora
   * quelli per banda. Il simulatore lo tiene per riprodurre proprio quel caso:
   * una voce vecchia che ha solo questo, e che l'interfaccia deve leggere
   * ugualmente.
   */
  mac_mode: string;
  mac_value: string;
  /** Il MAC di ciascuna banda: e' della radio, non della rete. */
  mac_mode_24?: string;
  mac_value_24?: string;
  mac_mode_5?: string;
  mac_value_5?: string;
  hostname_mode: string;
  hostname_value: string;
  note: string;
  priority: number;
  disabled: boolean;
  last_used: number;
  last_result: string;
  /**
   * La password, che non esce mai di qui.
   *
   * Sul router sta in `/etc/config/travel` e `travel.networks` non la
   * riporta: dice solo `has_key`. Il simulatore fa lo stesso, e la tiene
   * perche' e' l'unico modo di riprodurre una connessione rifiutata per
   * password sbagliata, che e' un esito che la schermata deve distinguere.
   */
  key: string;
}

const savedNetworks: Record<string, MockSaved> = {
  net_demo: {
    section: 'net_demo',
    ssid: 'Hotel-Guest',
    encryption: 'psk2',
    band: '5',
    hidden: false,
    mac_mode: 'random',
    mac_value: '02:1a:2b:3c:4d:5e',
    mac_mode_5: 'random',
    mac_value_5: '02:1a:2b:3c:4d:5e',
    hostname_mode: 'none',
    hostname_value: '',
    note: 'hotel di Berlino',
    priority: 20,
    disabled: false,
    last_used: Math.floor(Date.now() / 1000) - 86400 * 3,
    last_result: 'ok',
    key: 'hotelguest',
  },
  // La rete di casa su tutte e due le bande: UNA voce, `band` vuoto. Prima
  // erano due sezioni gemelle da tenere allineate a mano; adesso e' la stessa
  // configurazione, con un MAC per radio - qui casuale e diverso, che e' il
  // caso in cui i due valori devono restare separati davvero.
  net_casa: {
    section: 'net_casa',
    ssid: 'Casa Mia',
    encryption: 'psk2',
    band: '',
    hidden: false,
    mac_mode: 'random',
    mac_value: '02:5c:11:aa:01:24',
    mac_mode_24: 'random',
    mac_value_24: '02:5c:11:aa:01:24',
    mac_mode_5: 'random',
    mac_value_5: '02:5c:11:aa:01:50',
    // Rete di casa: qui il nome si manda, e serve a vedere le tre modalita'
    // rappresentate nel simulatore.
    hostname_mode: 'custom',
    hostname_value: 'beryl',
    note: 'a 5 GHz più veloce, a 2.4 arriva in tutta la casa',
    priority: 30,
    disabled: false,
    last_used: Math.floor(Date.now() / 1000) - 3600,
    last_result: 'ok',
    key: 'casacasacasa',
  },
  // Le voci che seguono servono a provare la pagina dedicata quando le reti
  // sono tante: da sole fanno comparire la ricerca, e coprono i casi che la
  // riga deve saper mostrare - aperta, disattivata, nascosta, mai usata.
  net_bar: {
    section: 'net_bar',
    ssid: 'Bar Centrale Free',
    encryption: 'none',
    band: '2.4',
    hidden: false,
    mac_mode: 'random',
    mac_value: '02:9f:0c:11:22:33',
    hostname_mode: 'none',
    hostname_value: '',
    note: 'chiedere il codice alla cassa',
    priority: 10,
    disabled: false,
    last_used: Math.floor(Date.now() / 1000) - 86400 * 6,
    last_result: 'portal',
    key: '',
  },
  net_treno: {
    section: 'net_treno',
    ssid: 'WIFI-Treno',
    encryption: 'psk2',
    band: '2.4',
    hidden: false,
    mac_mode: 'random',
    mac_value: '02:44:55:66:77:88',
    hostname_mode: 'none',
    hostname_value: '',
    note: '',
    priority: 5,
    disabled: true,
    last_used: Math.floor(Date.now() / 1000) - 86400 * 41,
    last_result: 'no-address',
    key: 'trenitalia',
  },
  // Nascosta: non compare in nessuna scansione, quindi nell'elenco e' l'unica
  // che si riconosce solo dall'etichetta.
  net_ufficio: {
    section: 'net_ufficio',
    ssid: 'Uffici-Interni',
    encryption: 'sae-mixed',
    band: '5',
    hidden: true,
    mac_mode: 'device',
    mac_value: '',
    hostname_mode: 'device',
    hostname_value: '',
    note: 'non annuncia il nome',
    priority: 18,
    disabled: false,
    last_used: Math.floor(Date.now() / 1000) - 86400 * 12,
    last_result: 'ok',
    key: 'segretissima',
  },
  net_coworking: {
    section: 'net_coworking',
    ssid: 'Coworking-Guest',
    encryption: 'sae',
    band: '5',
    hidden: false,
    mac_mode: 'device',
    mac_value: '',
    hostname_mode: 'none',
    hostname_value: '',
    note: '',
    priority: 12,
    disabled: false,
    last_used: Math.floor(Date.now() / 1000) - 86400 * 20,
    last_result: 'unassociated',
    key: 'coworking2024',
  },
  net_tim: {
    section: 'net_tim',
    ssid: 'TIM-91824417',
    encryption: 'psk2',
    band: '2.4',
    hidden: false,
    mac_mode: 'device',
    mac_value: '',
    hostname_mode: 'none',
    hostname_value: '',
    note: 'hotspot del telefono',
    priority: 8,
    disabled: false,
    last_used: 0,
    last_result: '',
    key: 'timtimtim',
  },
};

/** Parametri della riconnessione automatica, in /etc/config/travel. */
const autoSettings: Record<string, string> = {
  autoreconnect: '0',
  rssi_min: '-78',
  roam_mode: 'stay',
  blacklist_after: '3',
  blacklist_ttl: '600',
};

/** Reti messe da parte dal motore: qui una gia' penalizzata, per vederla. */
const penalties: Record<string, { fails: number; next_try: number; blacklisted_until: number }> = {
  net_demo: {
    fails: 2,
    next_try: Math.floor(Date.now() / 1000) + 45,
    blacklisted_until: 0,
  },
};

/** Modalita' e sticky della regola generale di mwan3 (`travel_default`). */
const mwanDefault = {
  mode: 'failover' as 'failover' | 'balance',
  sticky: false,
  timeout: 600,
};

/**
 * Rete locale. L'indirizzo iniziale collide con la sottorete simulata a monte
 * (192.168.0.x): serve a vedere il rilevamento del conflitto senza dover
 * ricreare la situazione su un router vero.
 */
const lanState = {
  addresses: ['192.168.0.1/24'],
  netmask: '255.255.255.0',
  start: '100',
  limit: '150',
  dnsClient: [] as string[],
  dnsClient6: [] as string[],
  dnsUpstream: [] as string[],
  dhcpOptions: [] as string[],
  // La LAN ha il solo ULA, come un router senza upstream v6: e' lo stato in
  // cui si trova davvero un router da viaggio in un albergo v4-only.
  addresses6: ['fd66:67c3:698b::1/60'],
  ula: 'fd66:67c3:698b::/48',
  // La riga "Automatico" della tabella, con ra_slaac ASSENTE: e' esattamente
  // come nasce un router OpenWrt, ed e' il caso che matchRaMode deve
  // riconoscere invece di chiamare "Personalizzato".
  ra: 'server',
  dhcpv6: 'server',
  raFlags: ['managed-config', 'other-config'],
  raSlaac: '',
  raDefault: '',
};

/**
 * Porta ethernet commutabile. La sezione del bridge ha un nome anonimo reale
 * (cfgXXXX), come quello che rpcd restituirebbe.
 */
const ethState = {
  bridgeSection: 'cfg030f15',
  bridgePorts: ['eth1'],
  zoneSection: '@zone[1]',
  zoneNetworks: ['wan', 'wwan_radio0', 'wwan_radio1'],
  /**
   * Le due porte 2.5G del dispositivo.
   *
   * `mac` e' l'indirizzo con cui la porta si presenta adesso; `factory`
   * quello scritto nella scheda, che il simulatore tiene per poterci tornare -
   * sul router non lo si legge da nessuna parte, si ritrova togliendo
   * l'opzione. `macConfig` e' l'eventuale indirizzo imposto in
   * configurazione, e `devSection` la sezione `device` che lo porta.
   */
  ports: [
    {
      name: 'eth0',
      network: 'wan',
      disabled: false,
      carrier: 0,
      mac: '94:83:c4:d6:c7:40',
      factory: '94:83:c4:d6:c7:40',
      macConfig: '',
      devSection: '',
    },
    {
      name: 'eth1',
      network: '',
      disabled: false,
      carrier: 1,
      mac: '94:83:c4:d6:c7:41',
      factory: '94:83:c4:d6:c7:41',
      macConfig: '',
      devSection: '',
    },
  ],
};

/**
 * Nome del router e nome inviato nella richiesta DHCP, per interfaccia.
 *
 * `*` significa "non inviarlo" ed e' il default del progetto: setup.sh lo
 * scrive su tutte le WAN, e il simulatore parte dallo stesso stato.
 */
const systemState = { hostname: 'OpenWrt', section: 'cfg01e48a' };

/** LED di stato: hardware presente e acceso, come parte un router di fabbrica. */
const statusLedState = { supported: true, enabled: true };

/**
 * Interruttore fisico: nessuna funzione associata e levetta in basso, cioe' il
 * router appena installato. `TOGGLE_FIXED` e' il registro che sul router sta in
 * `toggle.sh`: il simulatore offre gli stessi id, piu' una voce per ogni
 * configurazione WireGuard salvata - che qui, come sul router, non si possono
 * elencare in anticipo perche' le crea chi usa l'interfaccia.
 */
const TOGGLE_FIXED = ['none', 'led', 'ap24', 'ap5'];
const physicalToggleState = { action: 'none', position: 'off' };

const toggleActions = (): string[] => [
  ...TOGGLE_FIXED,
  ...wgState.profiles.map((p) => `wg:${p.id}`),
];

const toggleNames = (): Record<string, string> =>
  Object.fromEntries(wgState.profiles.map((p) => [`wg:${p.id}`, p.name]));

/** La configurazione WireGuard comandata dalla levetta, o niente. */
function toggleWgMock(): MockWgProfile | undefined {
  const action = physicalToggleState.action;
  if (!action.startsWith('wg:')) return undefined;
  return wgState.profiles.find((p) => p.id === action.slice(3));
}

/**
 * La banda dell'access point comandato dalla levetta, o niente.
 *
 * La corrispondenza fra id e banda e' la stessa di `toggle.sh`: due voci fisse,
 * perche' le bande non le crea chi usa il router.
 */
function toggleApMock(): '2.4' | '5' | '' {
  if (physicalToggleState.action === 'ap24') return '2.4';
  if (physicalToggleState.action === 'ap5') return '5';
  return '';
}

/**
 * Porta USB. Parte alla velocita' piena, che e' il default dopo che il limite
 * a USB 2.0 e' tornato a essere un interruttore invece di una regola.
 */
const usbState = { force_usb2: false };

/**
 * Dispositivi sulla porta USB.
 *
 * `netdev` vuoto simula il caso scomodo: telefono attaccato, tethering acceso
 * dal suo lato, e nessun driver di rete che lo aggancia. E' la situazione in cui
 * l'interfaccia prima non mostrava niente, ed e' quella che la scheda nuova
 * deve saper raccontare. Metti `netdev: 'usb0'` per vedere l'altro caso.
 */
const usbDevices = [
  {
    port: '1-1',
    name: 'Pixel 7',
    vendor: '18d1',
    product: '4eeb',
    speed: '480',
    netdev: 'usb0',
    driver: 'cdc_ncm',
    interfaces: [
      {
        label: 'MTP (trasferimento file)',
        class: 'ff.ff.00',
        driver: '',
        network: false,
        module: '',
        module_state: '',
      },
      {
        label: 'NCM (tethering)',
        class: '02.0d.00',
        driver: 'cdc_ncm',
        network: true,
        module: 'cdc_ncm',
        module_state: 'caricato',
      },
    ],
  },
];

/** Una configurazione WireGuard salvata, nel simulatore. */
interface MockWgProfile {
  id: string;
  name: string;
  named: boolean;
  addresses: string;
  dns: string;
  mtu: string;
  peer_key: string;
  has_preshared: boolean;
  endpoint: string;
  port: string;
  allowed_ips: string;
  keepalive: string;
  active: boolean;
}

/**
 * WireGuard, e i vincoli di compatibilita'.
 *
 * Parte senza nessuna configurazione salvata: e' lo stato di un router appena
 * installato, quello che si vede una volta sola e che quindi nessuno prova mai.
 *
 * `next` conta le sezioni come fa il router: il nome della sezione uci e'
 * anche il nome dell'interfaccia, e nel simulatore serve la stessa cosa perche'
 * e' l'identificatore che le schermate si passano.
 */
const wgState = {
  installed: true,
  profiles: [] as MockWgProfile[],
  next: 1,
};

/** La configurazione accesa, o niente. Al massimo una: e' il vincolo. */
function wgActiveMock(): MockWgProfile | undefined {
  return wgState.profiles.find((p) => p.active);
}

/**
 * Chi sta decidendo da dove esce il traffico.
 *
 * Ricalcolata qui perche' il simulatore FA le veci del router, e il router
 * questa regola ce l'ha. Non e' la copia frontend della logica che il progetto
 * evita: quella sarebbe in `lib/vpn.ts`, e li' infatti non c'e' - la UI legge
 * `policy` e basta. Qui siamo dall'altra parte del filo.
 */
const MOCK_REASON: Record<string, string> = {
  balance:
    'il multi-WAN e in bilanciamento: sparpaglia le connessioni su piu WAN, e un tunnel non si puo sparpagliare',
  ts_exit: 'un exit node Tailscale sta gia portando fuori tutto il traffico',
  wireguard: 'il tunnel WireGuard sta gia portando fuori tutto il traffico',
};

function mockHolder(want: string): string {
  if (want !== 'balance' && mwanDefault.mode === 'balance') return 'balance';
  if (want !== 'ts_exit' && vpnState.exitNode !== '') return 'ts_exit';
  if (want !== 'wireguard' && wgActiveMock()) return 'wireguard';
  return '';
}

function mockPolicy() {
  const blocked_by: Record<string, string> = {};
  const reason: Record<string, string> = {};
  for (const want of ['balance', 'ts_exit', 'wireguard']) {
    const holder = mockHolder(want);
    blocked_by[want] = holder;
    reason[want] = holder ? MOCK_REASON[holder] : '';
  }
  return {
    balance: mwanDefault.mode === 'balance',
    ts_exit: vpnState.exitNode !== '',
    wireguard: Boolean(wgActiveMock()),
    blocked_by,
    reason,
  };
}

/** Quanto ci mette il login a Tailscale a concludersi, dopo aver aperto il link. */
const TS_LOGIN_MS = 12000;

/** Quanto ci mette l'approvazione dell'exit node dalla console di Tailscale. */
const TS_APPROVE_MS = 20000;

/**
 * I dispositivi del tailnet simulato.
 *
 * Abbastanza da vedere che l'elenco regge davvero: nomi di lunghezza molto
 * diversa, uno spento, e due che si offrono come uscita. Un elenco di due voci
 * corte non avrebbe mostrato il problema per cui i chip sono stati sostituiti.
 */
const tailnetNodes = [
  { short: 'raspberrypi', name: 'raspberrypi.tail1234.ts.net', id: 'nodeid-rpi', ip: '100.64.0.11', online: true, exit: false },
  { short: 'casa', name: 'casa.tail1234.ts.net', id: 'nodeid-casa', ip: '100.64.0.3', online: true, exit: true },
  { short: 'oracle-proxy-frankfurt', name: 'oracle-proxy-frankfurt.tail1234.ts.net', id: 'nodeid-vps', ip: '100.64.0.9', online: true, exit: true },
  { short: 'pixel-di-mauro', name: 'pixel-di-mauro.tail1234.ts.net', id: 'nodeid-pixel', ip: '100.64.0.22', online: false, exit: false },
  { short: 'nas', name: 'nas.tail1234.ts.net', id: 'nodeid-nas', ip: '100.64.0.5', online: true, exit: false },
];

/**
 * VPN.
 *
 * Parte da zero: servizio spento, nessun accesso fatto, kill switch spento. E'
 * lo stato di un router appena installato, ed e' quello in cui l'interfaccia
 * deve saper spiegare cosa fare - il caso che si vede una volta sola e che
 * quindi nessuno prova mai.
 *
 * Il login interattivo ci mette una decina di secondi, come nella realta':
 * simularlo istantaneo nasconderebbe proprio la schermata di attesa con il link
 * da aprire, che e' il pezzo su cui c'e' qualcosa da sbagliare.
 */
const vpnState = {
  installed: true,
  daemon: false,
  loggedInAt: 0,
  up: false,
  exitNode: '',
  acceptRoutes: false,
  acceptDns: false,
  advertiseLan: false,
  advertiseExit: false,
  /**
   * Quando e' stato acceso l'annuncio come exit node.
   *
   * Nel simulatore l'approvazione dalla console arriva da sola venti secondi
   * dopo: e' il tempo che ci vuole ad accorgersene, aprire la console e
   * spuntare la casella. Serve a vedere entrambi gli stati - "annunciato, da
   * autorizzare" e "autorizzato" - senza avere un tailnet sotto mano.
   */
  advertiseExitAt: 0,
  killswitch: false,
  /** Cosa fa il firewall adesso: diverge da `killswitch` durante una sospensione. */
  killswitchBlocking: false,
  resumeAt: 0,
};

/**
 * Captive portal, lo scenario che il README prometteva di poter simulare.
 *
 * Sul dispositivo vero serve un albergo. Qui basta collegarsi a una rete il cui
 * nome sta in questo elenco: la connessione riesce, l'indirizzo arriva, e la
 * verifica dell'uscita dice che c'e' un portale. E' proprio la combinazione che
 * senza la verifica dell'uscita si presentava come "Collegato" e basta.
 *
 * L'accesso non si simula con un timer ma con la clonazione del MAC: il portale
 * finto autorizza gli indirizzi, e prendendo quello di un dispositivo gia'
 * autenticato il router passa. Cosi' l'intero giro - vedo il portale, clono,
 * riverifico - si prova senza avere niente sotto mano.
 */
const portalSsids = ['Hotel-Guest', 'Hotel-WiFi-Free'];

/**
 * Dispositivi sulla LAN: quelli che la scheda LAN elenca e fra cui si sceglie
 * il MAC da clonare.
 *
 * `on` e' dove sono attaccati - una radio o una porta - e non da dove risultano:
 * l'attribuzione la ricava `travel.clients`, come fa il router leggendo la
 * tabella del bridge. Cosi' spegnere un access point dal simulatore fa quello
 * che farebbe davvero, cioe' lasciare quei dispositivi senza provenienza.
 */
const lanClients = [
  // Un telefono con le estensioni di privacy: tre indirizzi v6 sullo stesso
  // dispositivo, che e' il motivo per cui l'elenco li conta invece di
  // elencarli. Come sul router vero.
  {
    mac: 'b8:27:eb:0a:1f:22',
    ip: '192.168.10.142',
    name: 'pixel-di-mauro',
    source: 'dhcp',
    on: 'radio1',
    ips6: [
      'fd66:67c3:698b:0:c8:188e:f90e:be6c',
      'fd66:67c3:698b:0:58ae:fb70:6821:9805',
      'fd66:67c3:698b:0:c5e4:5c6c:4e69:5684',
    ],
  },
  {
    mac: '3c:22:fb:71:9c:04',
    ip: '192.168.10.108',
    name: 'macbook',
    source: 'dhcp',
    on: 'eth1',
    ips6: ['fd66:67c3:698b:0:8810:e311:c4ce:a9ab'],
  },
  { mac: 'dc:a6:32:5e:11:80', ip: '192.168.10.201', name: '', source: 'arp', on: 'radio0', ips6: [] },
  // Solo IPv6: nessun lease DHCPv4, nessuna voce ARP. Senza la lettura dei
  // vicini v6 questo dispositivo sparirebbe dall'elenco pur essendo in rete.
  {
    mac: '2e:9f:04:b1:77:31',
    ip: '',
    name: 'stampante',
    source: 'neigh6',
    on: 'eth1',
    ips6: ['fd66:67c3:698b:0:2c9f:4ff:feb1:7731'],
  },
  // Associato e senza indirizzo: i primi secondi di ogni collegamento, e lo
  // stato in cui si resta quando il DHCP non risponde.
  { mac: '9a:11:4f:20:c3:7d', ip: '', name: '', source: 'wifi', on: 'radio0', ips6: [] },
];

/** I MAC che il portale finto considera gia' autenticati. */
const portalAuthorized = ['b8:27:eb:0a:1f:22'];

/** Reti su cui il portale e' gia' stato incontrato, con l'ultimo accesso. */
let portalMemory = [
  {
    section: 'portal_9f2c4a10bd',
    key: 'Hotel-Guest',
    label: 'Hotel-Guest',
    network: 'wwan_radio1',
    url: 'http://portal.hotel.example/login',
    last_seen: Math.floor(Date.now() / 1000) - 3600,
    last_login: Math.floor(Date.now() / 1000) - 86400 * 2,
  },
];

/**
 * Profili.
 *
 * Due, perche' uno solo non fa vedere la cosa che conta: quale dei due
 * corrisponde allo stato di adesso. Il simulatore lo decide come il router,
 * confrontando i valori con quelli vivi - se si cambia la modalita' multi-WAN
 * dalla schermata Internet, qui il segno "adesso" si sposta o sparisce.
 */
interface MockProfile {
  section: string;
  name: string;
  saved: number;
  mode: string;
  autoreconnect: boolean;
  portal_check: boolean;
  killswitch: boolean;
  sticky: boolean;
  wans: Array<{ network: string; enabled: boolean; priority: number; weight: number }>;
}

let mockProfiles: MockProfile[] = [
  {
    section: 'prof_hotel',
    name: 'hotel',
    saved: Math.floor(Date.now() / 1000) - 86400 * 12,
    mode: 'failover',
    autoreconnect: true,
    portal_check: true,
    killswitch: true,
    sticky: true,
    wans: [
      { network: 'wwan_radio1', enabled: true, priority: 10, weight: 1 },
      { network: 'wwan_radio0', enabled: true, priority: 20, weight: 1 },
      { network: 'wan', enabled: true, priority: 30, weight: 1 },
      // Il tethering escluso: e' la WAN a consumo, e in albergo non deve
      // partire da sola.
      { network: 'wan_usb', enabled: false, priority: 40, weight: 1 },
    ],
  },
  {
    section: 'prof_casa',
    name: 'casa',
    saved: Math.floor(Date.now() / 1000) - 86400 * 40,
    mode: 'balance',
    autoreconnect: false,
    portal_check: false,
    killswitch: false,
    sticky: false,
    wans: [
      { network: 'wan', enabled: true, priority: 10, weight: 3 },
      { network: 'wwan_radio1', enabled: true, priority: 20, weight: 1 },
      { network: 'wwan_radio0', enabled: true, priority: 30, weight: 1 },
      { network: 'wan_usb', enabled: false, priority: 40, weight: 1 },
    ],
  },
];

/** Orologio, fuso e server: quello che risponde `travel.time_get`. */
const timeState = {
  zonename: 'Europe/Rome',
  timezone: 'CET-1CEST,M3.5.0,M10.5.0/3',
  ntp_enabled: true,
  servers: [
    '0.openwrt.pool.ntp.org',
    '1.openwrt.pool.ntp.org',
    '2.openwrt.pool.ntp.org',
    '3.openwrt.pool.ntp.org',
  ],
};

/** Riavvio pianificato: spento, come su un router appena installato. */
const rebootState = { enabled: false, hour: 4, minute: 0, weekday: '*' };

const wanHostnames: Record<string, string> = {
  wwan_radio0: '*',
  wwan_radio1: '*',
  wan: '*',
  wan_usb: '*',
};

/** Modifiche preparate ma non ancora confermate, come le pendenze di uci. */
let pending: Array<() => void> = [];
let unreachableUntil = 0;

const radioOf = (section: string) => section.replace(/^(ap|sta)_/, '');

function deviceOf(radio: MockRadio): string {
  if (radio.sta) return `phy0.${radio.index}-sta0`;
  if (radio.apEnabled) return `phy0.${radio.index}-ap0`;
  // Nessuna interfaccia attiva: la radio non e' scansionabile.
  return '';
}

const scanFixtures = [
  { ssid: 'Hotel-Guest', channel: 44, signal: -48, wpa: [2], auth: ['psk'] },
  // Stesso nome su piu' canali: e' la rete mesh dell'albergo, e serve a
  // verificare che l'elenco la mostri una volta sola.
  { ssid: 'Hotel-Guest', channel: 6, signal: -59, wpa: [2], auth: ['psk'] },
  { ssid: 'Hotel-Guest', channel: 1, signal: -67, wpa: [2], auth: ['psk'] },
  { ssid: 'Hotel-Guest', channel: 11, signal: -80, wpa: [2], auth: ['psk'] },
  { ssid: 'Hotel-WiFi-Free', channel: 11, signal: -63, wpa: [], auth: ['none'] },
  // La rete di casa si annuncia su tutte e due le bande: una voce salvata
  // sola, ma due righe nella scansione, una per radio. E' il caso da cui si
  // salva una rete su entrambe le bande in un colpo.
  { ssid: 'Casa Mia', channel: 3, signal: -55, wpa: [2], auth: ['psk'] },
  { ssid: 'Casa Mia', channel: 40, signal: -61, wpa: [2], auth: ['psk'] },
  { ssid: 'Vodafone-12345', channel: 1, signal: -71, wpa: [2], auth: ['psk'] },
  { ssid: 'FASTWEB-ABCDEF', channel: 36, signal: -74, wpa: [2, 3], auth: ['psk', 'sae'] },
  { ssid: '', channel: 100, signal: -78, wpa: [2], auth: ['psk'] },
  { ssid: 'iPhone di Marco', channel: 9, signal: -82, wpa: [2], auth: ['psk'] },
  { ssid: 'TIM-9988776', channel: 149, signal: -88, wpa: [2], auth: ['psk'] },
];

/**
 * Le reti nascoste che nel simulatore esistono davvero.
 *
 * Non stanno in `scanFixtures` ed e' esattamente il punto: una rete nascosta
 * non compare in nessuna scansione, e il router la trova solo sondando il nome
 * che gli e' stato scritto a mano. Sono la controparte necessaria del modulo
 * "aggiungi rete nascosta": senza, ogni rete aggiunta risulterebbe inesistente
 * e non si potrebbe mai provare il caso che riesce.
 *
 * La banda conta anche qui: una rete nascosta cercata sulla banda sbagliata non
 * si trova. E' il motivo per cui le bande di una rete salvata sono una scelta
 * e non una comodita' - accenderne una su cui la rete non c'e' produce un
 * "rete non trovata", non un tentativo innocuo.
 */
const hiddenAps: Array<{ ssid: string; band: '2.4' | '5' }> = [
  { ssid: 'Uffici-Interni', band: '5' },
];

/**
 * L'indirizzo come lo riporterebbe il kernel dopo averlo applicato.
 *
 * uci conserva quello che ci si scrive - anche in maiuscolo, se qualcuno ha
 * modificato /etc/config/network a mano - mentre `/sys/class/net/*` e' sempre
 * minuscolo. Il simulatore tiene le due forme separate perche' e' proprio la
 * loro differenza che fa sbagliare i confronti fra "scritto" e "in uso".
 */
function appliedMac(written: string): string {
  return written.trim().toLowerCase();
}

/**
 * Il MAC che una rete salvata usa su questa banda.
 *
 * I campi per banda vincono, ma se mancano si ripiega su quello condiviso: e'
 * la stessa regola del router e della UI, e serve perche' una voce salvata
 * prima che i MAC si separassero ha soltanto quello.
 */
function savedMac(entry: MockSaved, band: '2.4' | '5'): string {
  const mode = (band === '2.4' ? entry.mac_mode_24 : entry.mac_mode_5) ?? entry.mac_mode;
  const value = (band === '2.4' ? entry.mac_value_24 : entry.mac_value_5) ?? entry.mac_value;
  return mode === 'device' ? '' : value;
}

/** Se un punto di accesso con questo nome esiste su questa banda. */
function apExists(ssid: string, band: '2.4' | '5'): boolean {
  const visible = scanFixtures.some(
    (n) => n.ssid === ssid && (n.channel <= 14) === (band === '2.4'),
  );
  return visible || hiddenAps.some((n) => n.ssid === ssid && n.band === band);
}

/**
 * Perche' questa STA non si aggancia, se non si aggancia.
 *
 * Due regole sole, dichiarate qui una volta: la password letterale
 * "sbagliata" viene rifiutata, e un nome che su quella banda non esiste non
 * viene trovato. Servono a riprodurre i due esiti che dall'esterno si vedono
 * uguali - nessuna associazione - ma che la schermata deve distinguere perche'
 * hanno rimedi opposti.
 */
function staFailure(sta: MockSta, band: '2.4' | '5'): '' | 'wrong-key' | 'not-found' {
  if (!apExists(sta.ssid, band)) return 'not-found';
  if (sta.key === 'sbagliata') return 'wrong-key';
  return '';
}

/**
 * Il log di sistema, per la parte che riguarda le STA.
 *
 * Si accumula invece di essere generato al momento della domanda, ed e'
 * l'accumulo il punto: sul router il log e' la storia di tutta la radio, il
 * nome dell'interfaccia non cambia da una rete all'altra, e la riga di un
 * tentativo di ieri resta li' a corrispondere anche oggi. E' esattamente la
 * trappola che il segnalibro di `sta_diagnose` deve evitare, e un simulatore
 * che ricostruisse il log ogni volta non la riprodurrebbe.
 */
let staLog: string[] = [];

/** Le righe che wpa_supplicant scriverebbe per il tentativo appena applicato. */
function noteStaAttempt(name: string): void {
  const radio = radios[name];
  if (!radio || !radio.sta) return;

  const iface = `phy${radio.index}-sta0`;
  staLog.push(`daemon.notice netifd: ${name} (1299): Interface setup`);

  switch (staFailure(radio.sta, radio.band)) {
    case 'wrong-key':
      staLog.push(
        `daemon.notice wpa_supplicant[1428]: ${iface}: CTRL-EVENT-SSID-TEMP-DISABLED id=0 ssid="${radio.sta.ssid}" auth_failures=1 duration=10 reason=WRONG_KEY`,
      );
      break;
    case 'not-found':
      staLog.push(`daemon.notice wpa_supplicant[1428]: ${iface}: CTRL-EVENT-SCAN-STARTED`);
      staLog.push(`daemon.notice wpa_supplicant[1428]: ${iface}: CTRL-EVENT-NETWORK-NOT-FOUND`);
      break;
    default:
      staLog.push(
        `daemon.notice wpa_supplicant[1428]: ${iface}: CTRL-EVENT-CONNECTED - Connection to ${fakeBssid(radio.sta.ssid)} completed`,
      );
  }
}

/**
 * Verdetto sull'uscita di una WAN, con la stessa forma di `travel.portal_probe`.
 *
 * Restituisce `null` quando non c'e' niente da verificare - nessun indirizzo -
 * cosi' il chiamante distingue "non misurato" da "misurato e non passa", che e'
 * la distinzione su cui si regge tutta la schermata.
 */
function mockPortal(network: string): Record<string, unknown> | null {
  const now = Math.floor(Date.now() / 1000);
  const base = {
    network,
    reason: '',
    url: '',
    probe_url: 'http://detectportal.firefox.com/success.txt',
    ip: '34.107.221.82',
    tool: 'nc',
    at: now,
    took: 1,
  };

  if (network === 'wan_usb') return { ...base, state: 'online', http: 200 };

  const name = network.replace(/^wwan_/, '');
  const radio = radios[name];
  if (!radio || !radio.sta) return null;
  // Prima del DHCP non c'e' indirizzo, quindi non c'e' niente da misurare.
  if (Date.now() - radio.sta.since <= DHCP_MS) return null;

  const cloned = radio.sta.mac ? radio.sta.mac.toLowerCase() : '';
  if (portalSsids.includes(radio.sta.ssid) && !portalAuthorized.includes(cloned)) {
    return {
      ...base,
      state: 'portal',
      http: 302,
      url: 'http://portal.hotel.example/login?ap=42',
    };
  }

  return { ...base, state: 'online', http: 200 };
}

function fakeBssid(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) & 0xffffff;
  const hex = h.toString(16).padStart(6, '0');
  return `a4:2b:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:0${seed.length % 10}`;
}

function scanForBand(band: '2.4' | '5') {
  const wants24 = band === '2.4';
  return {
    results: scanFixtures
      .filter((n) => (n.channel <= 14) === wants24)
      .map((n) => ({
        ssid: n.ssid,
        bssid: fakeBssid(n.ssid + n.channel),
        channel: n.channel,
        // Il segnale oscilla fra una scansione e l'altra, come nella realta'.
        signal: jitter(n.signal, 6),
        encryption: {
          enabled: n.wpa.length > 0,
          wpa: n.wpa,
          authentication: n.auth,
        },
      })),
  };
}

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  'travel.status': () => ({
    version: '0.1.0 (simulato)',
    phase: '6b',
    model: 'GL.iNet GL-MT3600BE',
    release: 'OpenWrt 25.12.5 r33051-f5dae5ece4',
    hostname: systemState.hostname,
    uptime: Math.round((Date.now() - bootedAt) / 1000) + 4231,
    load: [0.08, 0.12, 0.09],
    memory: { total_kb: 498484, available_kb: jitter(359972, 8000) },
    overlay: { total_kb: 416256, available_kb: 411340 },
    temp_mc: jitter(52000, 3000),
  }),

  // Nome del router: quello attivo, quello scritto in uci e la sezione in cui
  // cambiarlo. Nel simulatore i primi due coincidono sempre.
  'travel.system': () => ({
    hostname: systemState.hostname,
    configured: systemState.hostname,
    section: systemState.section,
  }),

  // Nessuna password qui dentro, come nella risposta vera: il metodo esiste
  // proprio per non far uscire i segreti dal router.
  'travel.radios': () => ({
    radios: Object.entries(radios).map(([name, r]) => ({
      name,
      band: r.band,
      device: deviceOf(r),
      // Un SSID che contiene "fail" simula una configurazione rifiutata da
      // hostapd: serve a provare che la conferma NON parte quando la radio
      // resta giu'.
      up: (r.apEnabled || r.sta !== null) && !ap.ssid.includes('fail'),
      setup_failed: r.apEnabled && ap.ssid.includes('fail'),
      channel: r.sta ? 44 : r.channel,
      ap_section: `ap_${name}`,
      ap_ssid: ap.ssid,
      ap_enabled: r.apEnabled,
      ap_toggle: toggleApMock() === r.band,
      sta_section: r.sta ? `sta_${name}` : '',
      sta_enabled: r.sta !== null,
    })),
  }),

  // Un uplink per radio, ciascuno con la propria interfaccia logica: e' il
  // punto della modifica, due STA sulla stessa si contenderebbero l'indirizzo.
  'travel.uplinks': () => ({
    uplinks: Object.entries(radios)
      .filter(([, r]) => r.sta !== null)
      .map(([name, r]) => {
        const sta = r.sta as MockSta;
        const base = {
          kind: 'wifi',
          radio: name,
          band: r.band,
          section: `sta_${name}`,
          network: `wwan_${name}`,
          device: deviceOf(r),
          enabled: true,
          hostname: wanHostnames[`wwan_${name}`] ?? '',
        };

        const failure = staFailure(sta, r.band);
        if (failure !== '') {
          // La password sbagliata passa per un'associazione breve prima di
          // cadere; una rete che non c'e' non si aggancia proprio mai. Dopo la
          // caduta i due casi si vedono uguali, come sul router: a
          // distinguerli e' `travel.sta_diagnose`, che legge il log.
          const associating =
            failure === 'wrong-key' && Date.now() - sta.since < HANDSHAKE_MS;
          return { ...base, ssid: associating ? sta.ssid : '' };
        }

        const hasIp = Date.now() - sta.since > DHCP_MS;
        const octet = r.index === 0 ? '76' : '43';
        return {
          ...base,
          ssid: sta.ssid,
          bssid: fakeBssid(sta.ssid),
          channel: r.index === 0 ? 6 : 44,
          signal: jitter(-52, 8),
          mac: sta.mac || `94:83:c4:d6:c7:4${r.index}`,
          up: hasIp,
          ipv4: hasIp ? `192.168.0.${octet}` : '',
          // Il numero di bit e non la maschera puntata: e' quello che ubus
          // riporta davvero, e il simulatore serve a poco se semplifica proprio
          // la forma che il confine deve normalizzare.
          netmask: hasIp ? '24' : '',
          gateway: hasIp ? '192.168.0.1' : '',
          dns: hasIp ? ['192.168.0.1', '1.1.1.1'] : [],
          // Solo la STA a 5 GHz (index 1) e' dual-stack: quella a 2.4 resta
          // v4-only, cosi' le due righe si possono confrontare a colpo d'occhio.
          ...(hasIp && r.index === 1
            ? {
                ipv6: ['2001:db8:c0ca:1::b1c/64', 'fd42:1:2::b1c/64'],
                gateway6: 'fe80::1',
                prefix6: '2001:db8:c0ca:1::/64',
                dns6: ['2001:4860:4860::8888'],
              }
            : { ipv6: [], gateway6: '', prefix6: '', dns6: [] }),
        };
      }),
  }),

  // La chiave non compare, coerentemente con la risposta vera: si dice solo
  // se esiste.
  'travel.ap': () => ({
    aps: Object.entries(radios).map(([name, r]) => ({
      section: `ap_${name}`,
      radio: name,
      band: r.band,
      enabled: r.apEnabled,
      toggle: toggleApMock() === r.band,
      ssid: ap.ssid,
      encryption: ap.encryption,
      has_key: ap.hasKey,
      device: r.apEnabled ? `phy0.${r.index}-ap0` : '',
      bssid: r.apEnabled ? `94:83:c4:d6:c7:4${r.index}` : '',
      channel: r.apEnabled ? (r.sta ? 44 : r.channel) : 0,
      clients: r.apEnabled ? (r.index === 0 ? 2 : 1) : 0,
    })),
  }),

  'traveld.status': () => ({
    version: '0.3.0 (simulato)',
    uptime: Math.round((Date.now() - bootedAt) / 1000),
    ticks: Math.round((Date.now() - bootedAt) / 10000),
    enabled: autoSettings.autoreconnect === '1',
    settings: {
      autoreconnect: autoSettings.autoreconnect === '1',
      rssi_min: Number(autoSettings.rssi_min),
      roam_mode: autoSettings.roam_mode,
      roam_hysteresis: 8,
      blacklist_after: Number(autoSettings.blacklist_after),
      blacklist_ttl: Number(autoSettings.blacklist_ttl),
      scan_interval: 60,
    },
    networks: penalties,
    events: [
      {
        at: Math.floor(Date.now() / 1000) - 45,
        kind: 'connessione',
        message: 'radio1 -> Hotel-Guest (-52 dBm)',
        code: 'connecting',
        params: { radio: 'radio1', ssid: 'Hotel-Guest', signal: -52 },
      },
      {
        at: Math.floor(Date.now() / 1000) - 320,
        kind: 'fallita',
        message: 'net_demo: nuovo tentativo fra 60s',
        code: 'retry',
        params: { key: 'net_demo', wait: 60 },
      },
    ],
    last_error: '',
  }),

  // Una chiamata sola per tutta la dashboard, come sul router. La latenza
  // include qualche pacchetto perso, cosi' si vede che il grafico li lascia
  // come interruzioni invece di disegnarli a zero.
  'traveld.dashboard': () => {
    const now = Math.floor(Date.now() / 1000);

    const wans: Array<Record<string, unknown>> = Object.entries(radios)
      .filter(([, r]) => r.sta !== null)
      .map(([name, r]) => ({
        network: `wwan_${name}`,
        kind: 'wifi',
        band: r.band as string,
        radio: name,
        device: deviceOf(r),
        section: `sta_${name}`,
        active: r.index === 1,
        enabled: true,
        hostname: wanHostnames[`wwan_${name}`] ?? '',
        carrier: -1,
        driver: '',
        state: 'addressed',
        portal: mockPortal(`wwan_${name}`),
        ssid: r.sta ? r.sta.ssid : '',
        bssid: 'a4:2b:11:22:33:44',
        channel: r.index === 0 ? 6 : 44,
        signal: jitter(-52, 8),
        bitrate: 286000,
        ipv4: `192.168.0.${r.index === 0 ? 76 : 43}`,
        gateway: '192.168.0.1',
        dns: ['192.168.0.1', '1.1.1.1'],
        // Dual-stack solo a 5 GHz, come in travel.uplinks: le due risposte
        // descrivono lo stesso router e non devono raccontarlo in due modi.
        ipv6: r.index === 1 ? ['2001:db8:c0ca:1::b1c/64', 'fd42:1:2::b1c/64'] : [],
        gateway6: r.index === 1 ? 'fe80::1' : '',
        prefix6: r.index === 1 ? '2001:db8:c0ca:1::/64' : '',
        dns6: r.index === 1 ? ['2001:4860:4860::8888'] : [],
        mac: `94:83:c4:d6:c7:4${r.index}`,
        metric: r.index === 0 ? 20 : 10,
        rx_rate: jitter(240000, 180000),
        tx_rate: jitter(40000, 30000),
        rx_session: 184 * 1024 * 1024 + r.index * 1e6,
        tx_session: 23 * 1024 * 1024,
      }));

    wans.push({
      network: 'wan',
      kind: 'ethernet',
      band: '',
      radio: '',
      device: 'eth0',
      section: '',
      active: false,
      enabled: true,
      hostname: wanHostnames.wan ?? '',
      carrier: 0,
      driver: '',
      state: 'no-carrier',
      // Nessun indirizzo, quindi niente da verificare: `null` significa "non
      // misurato", che non e' la stessa cosa di "misurato e non passa".
      portal: null,
      ssid: '',
      bssid: '',
      channel: 0,
      signal: 0,
      bitrate: 0,
      // La WAN via cavo resta v4-only anche quando un cavo c'e': e' il caso
      // dell'albergo, e serve a vedere che una riga senza IPv6 non cambia
      // aspetto rispetto a prima.
      ipv4: '',
      gateway: '',
      dns: [],
      ipv6: [],
      gateway6: '',
      prefix6: '',
      dns6: [],
      mac: '94:83:c4:d6:c7:4f',
      metric: 30,
      rx_rate: 0,
      tx_rate: 0,
      rx_session: 0,
      tx_session: 0,
    });

    // Tethering con un telefono attaccato: il device ha un nome qualsiasi
    // (`usb0`), ed e' il driver a dire di cosa si tratta.
    wans.push({
      network: 'wan_usb',
      kind: 'usb',
      band: '',
      radio: '',
      device: 'usb0',
      section: '',
      active: false,
      enabled: true,
      hostname: wanHostnames.wan_usb ?? '',
      carrier: 1,
      driver: 'cdc_ncm',
      state: 'addressed',
      portal: mockPortal('wan_usb'),
      ssid: '',
      bssid: '',
      channel: 0,
      signal: 0,
      bitrate: 0,
      // Tethering v6-only: e' il caso 464XLAT, comune sulle reti mobili, ed e'
      // l'unico modo di vedere davvero il passaggio no-address -> addressed.
      // Senza una riga cosi' nel simulatore, la regola "basta una delle due
      // famiglie" resterebbe una riga di codice che nessuno guarda.
      ipv4: '',
      gateway: '',
      dns: [],
      ipv6: ['2a00:1450:4001:80f::200e/64'],
      gateway6: 'fe80::dead:beef',
      prefix6: '2a00:1450:4001:80f::/60',
      dns6: ['2606:4700:4700::1111'],
      mac: '9a:2c:11:04:8e:21',
      metric: 40,
      rx_rate: jitter(90000, 60000),
      tx_rate: jitter(20000, 15000),
      rx_session: 12 * 1024 * 1024,
      tx_session: 3 * 1024 * 1024,
    });

    return {
      version: '0.4.0 (simulato)',
      at: now,
      system: {
        hostname: systemState.hostname,
        uptime: Math.round((Date.now() - bootedAt) / 1000) + 4231,
        load: [0.08, 0.12, 0.09],
        temp_mc: jitter(52000, 3000),
        mem_total_kb: 498484,
        mem_available_kb: jitter(359972, 8000),
      },
      wans,
      autoreconnect: autoSettings.autoreconnect === '1',
      portal_check: true,
      killswitch: { on: vpnState.killswitch, resume_at: vpnState.resumeAt },
      events: [],
      last_error: '',
    };
  },

  // --- VPN: Tailscale e kill switch ---
  //
  // Il giro completo si prova senza avere un tailnet: "Accedi" produce un
  // indirizzo finto, e dopo qualche secondo il nodo risulta collegato - che e'
  // il tempo che ci mette davvero, ed e' anche quello che l'interfaccia deve
  // saper riempire con qualcosa di sensato.
  'travel.vpn': () => {
    const running = vpnState.loggedInAt > 0;
    const settled = running && Date.now() - vpnState.loggedInAt > TS_LOGIN_MS;

    return {
      tailscale: {
        installed: vpnState.installed,
        running: vpnState.daemon,
        boot: vpnState.daemon,
        state: !vpnState.daemon
          ? 'NoState'
          : settled
            ? vpnState.up
              ? 'Running'
              : 'Stopped'
            : 'NeedsLogin',
        auth_url: vpnState.daemon && !settled ? 'https://login.tailscale.com/a/simulato' : '',
        version: '1.78.1',
        self_name: settled ? 'gl-mt3600be.tail1234.ts.net' : '',
        self_short: settled ? 'gl-mt3600be' : '',
        self_ip: settled ? '100.94.12.7' : '',
        self_online: settled && vpnState.up,
        // L'exit node risulta in uso solo se e' stato scelto E il tunnel e' su:
        // e' la divergenza fra intenzione e realta' che la schermata deve
        // saper raccontare.
        exit_node_id: settled && vpnState.up && vpnState.exitNode ? 'nodeid-casa' : '',
        exit_node_online: true,
        // Annunciato ma non ancora approvato dalla console: e' lo stato in cui
        // ci si trova subito dopo aver acceso l'interruttore, ed e' quello che
        // l'interfaccia deve saper spiegare.
        self_exit_node:
          settled &&
          vpnState.advertiseExit &&
          Date.now() - vpnState.advertiseExitAt > TS_APPROVE_MS,
        ip_forward: true,
        ip_forward_raw: '1',
        // La catena e' tutta a posto salvo il firewall, che si accende solo
        // salvando le impostazioni con l'annuncio attivo: cosi' si vede
        // l'anello rotto una volta, e poi si vede sparire.
        exit_check: {
          iface_present: vpnState.daemon,
          iface_forward: vpnState.daemon,
          fw_out: vpnState.advertiseExit,
          fw_loaded: vpnState.daemon,
          route_rule: vpnState.daemon,
          route_present: vpnState.daemon,
          // Gli anelli che riguardano l'uscita dentro WireGuard compaiono solo
          // a tunnel acceso: accendendolo dalla schermata WireGuard si vede la
          // catena allungarsi di tre righe, che e' proprio il caso da provare.
          wg_up: Boolean(wgActiveMock()),
          wg_fw: vpnState.advertiseExit,
          wg_fw_loaded: Boolean(wgActiveMock()),
          wg_route_rule: Boolean(wgActiveMock()),
        },
        // Abbastanza nodi da vedere che l'elenco regge: uno spento in mezzo,
        // due che si offrono come uscita, e nomi di lunghezza diversa - e'
        // dove un elenco stretto si rompe.
        nodes: settled ? tailnetNodes : [],
      },
      settings: {
        exit_node: vpnState.exitNode,
        accept_routes: vpnState.acceptRoutes,
        accept_dns: vpnState.acceptDns,
        advertise_lan: vpnState.advertiseLan,
        advertise_exit: vpnState.advertiseExit,
        lan_cidr: `${lanState.addresses[0].split('/')[0].replace(/\.\d+$/, '.0')}/24`,
        // L'ULA e non la GUA, come sul router: e' la sola sottorete v6 che si
        // annuncia, perche' il prefisso delegato cambia a ogni albergo.
        lan_cidr6: lanState.ula.replace(/\/\d+$/, '/60'),
      },
      policy: mockPolicy(),
      killswitch: {
        on: vpnState.killswitch,
        blocking: vpnState.killswitchBlocking,
        resume_at: vpnState.resumeAt,
        ready: true,
      },
    };
  },

  'travel.ts_login': (args) => {
    // Sessione ancora valida: e' il "Accendi" dopo un Disconnetti, non un
    // accesso. Sul router `tailscale up` in questo caso torna su e basta, senza
    // nessun indirizzo da aprire; se qui ricominciassimo il login, il
    // simulatore proverebbe l'unica strada che il dispositivo non prende.
    const already =
      vpnState.daemon &&
      vpnState.loggedInAt > 0 &&
      Date.now() - vpnState.loggedInAt > TS_LOGIN_MS;

    vpnState.daemon = true;
    vpnState.up = true;
    if (already) return { started: true, auth_url: '', output: '' };

    vpnState.loggedInAt = Date.now();

    // Con una auth key non c'e' niente da aprire: si e' gia' dentro. E' la
    // differenza che la schermata deve mostrare fra le due strade.
    if (String(args.authkey ?? '') !== '') {
      vpnState.loggedInAt = Date.now() - TS_LOGIN_MS - 1;
      return { started: true, auth_url: '', output: 'Success.' };
    }
    return { started: true, auth_url: 'https://login.tailscale.com/a/simulato', output: '' };
  },

  'travel.ts_apply': () => ({ applied: true, output: '' }),

  'travel.ts_down': () => {
    vpnState.up = false;
    return { down: true, output: '' };
  },

  'travel.ts_logout': () => {
    vpnState.daemon = false;
    vpnState.up = false;
    vpnState.loggedInAt = 0;
    return { logout: true, output: '' };
  },

  // --- WireGuard e i vincoli di compatibilita' ---
  //
  // Il vincolo si prova qui senza avere niente: accendi il bilanciamento e
  // guarda sparire l'exit node e l'accensione di WireGuard; accendi WireGuard e
  // guarda sparire il bilanciamento. E' l'unico modo di verificare le sei
  // combinazioni senza sei configurazioni vere.
  'travel.wg_get': () => {
    const on = wgActiveMock();
    const config = (p?: MockWgProfile) => ({
      addresses: p?.addresses ?? '',
      mtu: p?.mtu ?? '',
      dns: p?.dns ?? '',
      has_private_key: p != null,
      peer_key: p?.peer_key ?? '',
      has_preshared: p?.has_preshared ?? false,
      endpoint: p?.endpoint ?? '',
      port: p?.port ?? '',
      allowed_ips: p?.allowed_ips ?? '',
      keepalive: p?.keepalive ?? '',
    });

    return {
      installed: wgState.installed,
      configured: wgState.profiles.length > 0,
      enabled: on != null,
      active: on?.id ?? '',
      // Chi comanda l'accensione. Arriva gia' risolto, come sul router: la
      // scheda spegne i pulsanti leggendo questo, non ricalcolandolo.
      toggle: toggleWgMock()?.id ?? '',
      profiles: wgState.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        active: p.active,
        named: p.named,
        config: config(p),
      })),
      config: config(on),
      // Instradamento e stato riguardano il tunnel acceso e nessun altro: sono
      // fatti che vivrebbero nel kernel, e ne esiste una serie sola.
      routing: {
        device_up: on != null,
        rule: on != null,
        route: on != null,
        in_zone: on != null,
      },
      status: {
        device_up: on != null,
        // Un handshake fresco solo se acceso: spento, il tunnel non parla con
        // nessuno e la scheda deve dirlo invece di mostrare numeri vecchi.
        last_handshake: on ? Math.floor(Date.now() / 1000) - 20 : 0,
        rx: on ? 48 * 1024 * 1024 : 0,
        tx: on ? 7 * 1024 * 1024 : 0,
        peer_endpoint: on ? '51.15.44.201:51820' : '',
        now: Math.floor(Date.now() / 1000),
      },
      policy: mockPolicy(),
    };
  },

  'travel.wg_import': (args) => {
    const conf = String(args.config ?? '');
    const name = String(args.name ?? '').trim();
    const id = String(args.id ?? '');

    if (!/PrivateKey/i.test(conf)) return { error: 'manca PrivateKey nella sezione [Interface]', error_code: 'wg_no_private_key' };
    if (!/Endpoint/i.test(conf)) return { error: 'manca Endpoint nella sezione [Peer]', error_code: 'wg_no_endpoint' };

    const existing = id ? wgState.profiles.find((p) => p.id === id) : undefined;
    if (id && !existing) return { error: 'configurazione WireGuard sconosciuta', error_code: 'wg_unknown' };
    if (!existing && name === '') return { error: 'il nome è obbligatorio', error_code: 'wg_bad_name' };
    // Lo stesso cancello del router: due nomi uguali renderebbero l'elenco
    // inutile proprio nel momento in cui serve.
    if (
      name !== '' &&
      wgState.profiles.some(
        (p) => p !== existing && p.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      return {
        error: 'esiste gia’ una configurazione WireGuard con questo nome',
        error_code: 'wg_name_taken',
      };
    }

    // Cio' che il file conterrebbe. Il simulatore non fa il parsing vero - lo
    // fa il router - ma i campi devono esserci, altrimenti il modulo di
    // modifica non avrebbe niente da mostrare.
    const parsed = {
      addresses: '10.66.12.4/32',
      dns: '10.66.0.1',
      mtu: '1420',
      peer_key: 'k8Fj2mQ1vX9pR4sT7wY0zA3bC6dE9fG2hJ5kL8nM0qU=',
      has_preshared: /PresharedKey/i.test(conf),
      endpoint: 'fr-3.vpnprovider.example',
      port: '51820',
      allowed_ips: '0.0.0.0/0',
      keepalive: '25',
    };

    if (existing) {
      Object.assign(existing, parsed);
      if (name !== '') {
        existing.name = name;
        existing.named = true;
      }
      return {
        imported: true,
        id: existing.id,
        endpoint: `${parsed.endpoint}:${parsed.port}`,
        enabled: existing.active,
      };
    }

    const fresh: MockWgProfile = {
      id: `travel_wg${wgState.next++}`,
      name,
      named: true,
      // Importare non e' accendere, qui come sul router.
      active: false,
      ...parsed,
    };
    wgState.profiles.push(fresh);
    return {
      imported: true,
      id: fresh.id,
      endpoint: `${parsed.endpoint}:${parsed.port}`,
      enabled: false,
    };
  },

  'travel.wg_save': (args) => {
    const id = String(args.id ?? '');
    const name = String(args.name ?? '').trim();
    const profile = wgState.profiles.find((p) => p.id === id);
    if (!profile) return { error: 'configurazione WireGuard sconosciuta', error_code: 'wg_unknown' };
    if (name === '') return { error: 'il nome è obbligatorio', error_code: 'wg_bad_name' };
    if (
      wgState.profiles.some((p) => p !== profile && p.name.toLowerCase() === name.toLowerCase())
    ) {
      return {
        error: 'esiste gia’ una configurazione WireGuard con questo nome',
        error_code: 'wg_name_taken',
      };
    }

    // Si scrive solo questa: le altre non vengono nemmeno lette, che e' il
    // punto dell'intera schermata.
    profile.name = name;
    profile.named = true;
    profile.addresses = String(args.addresses ?? '');
    profile.dns = String(args.dns ?? '');
    profile.mtu = String(args.mtu ?? '');
    profile.peer_key = String(args.peer_key ?? '');
    profile.endpoint = String(args.endpoint ?? '');
    profile.port = String(args.port ?? '');
    profile.allowed_ips = String(args.allowed_ips ?? '');
    profile.keepalive = String(args.keepalive ?? '');
    if (String(args.drop_preshared ?? '') === '1') profile.has_preshared = false;
    else if (String(args.preshared_key ?? '') !== '') profile.has_preshared = true;

    return { saved: true, id, name };
  },

  'travel.wg_delete': (args) => {
    const id = String(args.id ?? '');
    const index = wgState.profiles.findIndex((p) => p.id === id);
    if (index < 0) return { error: 'configurazione WireGuard sconosciuta', error_code: 'wg_unknown' };
    if (wgState.profiles[index].active) {
      return {
        error: 'e’ la configurazione attiva: disattivala prima di eliminarla',
        error_code: 'wg_delete_active',
      };
    }
    wgState.profiles.splice(index, 1);
    return { deleted: true };
  },

  'travel.wg_toggle': (args) => {
    const want = String(args.enabled ?? '') === '1';
    const id = String(args.id ?? '');
    const on = wgActiveMock();
    const profile = wgState.profiles.find((p) => p.id === id) ?? (want ? undefined : on);

    if (!profile) {
      return want
        ? { error: 'configurazione WireGuard sconosciuta', error_code: 'wg_unknown' }
        : { error: 'nessuna configurazione WireGuard attiva', error_code: 'wg_none_active' };
    }

    // Lo stesso cancello del router, e viene prima di tutti gli altri: quando
    // la levetta comanda, l'interfaccia non accende e non spegne piu' niente.
    const owner = toggleWgMock();
    if (owner) {
      return {
        error: `la comanda l'interruttore fisico: "${owner.name}" segue la levetta. Cambia la funzione dell'interruttore per tornare a decidere da qui`,
        error_code: 'wg_by_toggle',
        error_params: { name: owner.name },
      };
    }

    if (want) {
      // Accendere non scambia: con un'altra accesa si rifiuta e si dice quale,
      // esattamente come fa il router.
      if (on && on !== profile) {
        return {
          error: `e’ gia’ attiva la configurazione "${on.name}": disattivala prima di attivarne un’altra`,
          error_code: 'wg_busy',
          error_params: { name: on.name },
        };
      }
      // Lo stesso cancello del router: chi prova ad accendere quando qualcosa
      // sta gia' decidendo si prende l'errore, non un successo silenzioso.
      const holder = mockHolder('wireguard');
      if (holder) {
        return {
          error: `non posso accendere WireGuard: ${MOCK_REASON[holder]}`,
          error_code: 'wg_blocked',
          error_params: { holder, name: holder === 'wireguard' ? (wgActiveMock()?.name ?? '') : '' },
        };
      }
    }

    profile.active = want;
    return { active: wgActiveMock()?.id ?? '', enabled: want };
  },

  // --- Captive portal ---
  //
  // Il probe vero esce davvero sulla rete e ci mette qualche secondo. Qui la
  // latenza e' simulata in mockCall: una verifica istantanea nasconderebbe
  // proprio il pezzo di interfaccia che serve, cioe' l'attesa.
  'travel.portal_probe': (args) => {
    const network = String(args.network ?? '');
    return (
      mockPortal(network) ?? {
        network,
        state: 'unknown',
        reason: 'no-address',
        url: '',
        probe_url: 'http://detectportal.firefox.com/success.txt',
        ip: '',
        tool: '',
        http: 0,
        at: Math.floor(Date.now() / 1000),
        took: 0,
      }
    );
  },

  'traveld.portal_check': (args) => handlers['travel.portal_probe'](args),

  'traveld.portal': () => {
    const results: Record<string, unknown> = {};
    for (const network of ['wwan_radio0', 'wwan_radio1', 'wan', 'wan_usb']) {
      const verdict = mockPortal(network);
      if (verdict) results[network] = verdict;
    }
    return { at: Math.floor(Date.now() / 1000), enabled: true, results };
  },

  'travel.portal_networks': () => ({ portals: portalMemory }),

  'travel.portal_forget': (args) => {
    const section = String(args.section ?? '');
    portalMemory = portalMemory.filter((entry) => entry.section !== section);
    return { deleted: true };
  },

  // Un access point spento non ha nessuno associato: chi aveva un lease resta
  // nell'elenco ma senza provenienza, chi si vedeva solo dall'associazione
  // sparisce. E' quello che succede sul router, ed e' anche il modo di provare
  // le tre forme che la colonna di destra puo' prendere.
  'travel.clients': () => ({
    clients: lanClients
      .filter((c) => c.source !== 'wifi' || radios[c.on]?.apEnabled)
      .map(({ on, ...client }) => {
        const radio = radios[on];
        if (!radio) return { ...client, via: 'ethernet', iface: on, band: '' };
        return radio.apEnabled
          ? { ...client, via: 'wifi', iface: `phy0.${radio.index}-ap0`, band: radio.band }
          : { ...client, via: '', iface: '', band: '' };
      }),
  }),

  // --- Profili, backup, orologio, riavvio, velocita' ---

  /**
   * Quale profilo corrisponde allo stato di adesso.
   *
   * Il router lo decide confrontando tutti i valori salvati con quelli veri.
   * Qui il confronto e' sui campi che il simulatore modella davvero - modalita'
   * multi-WAN, riconnessione automatica, kill switch, sticky - e non sulle
   * priorita' per WAN, che nel simulatore sono fisse. Basta a provare quello
   * che conta: applicare un profilo sposta il segno "adesso", e cambiare la
   * modalita' dalla schermata Internet lo fa sparire.
   */
  'travel.profile_list': () => {
    const matches = (p: MockProfile) =>
      p.mode === mwanDefault.mode &&
      p.sticky === mwanDefault.sticky &&
      p.autoreconnect === (autoSettings.autoreconnect === '1') &&
      p.killswitch === vpnState.killswitch;

    return {
      current: mockProfiles.find(matches)?.section ?? '',
      profiles: mockProfiles.map((p) => ({ ...p, wans: p.wans.map((w) => ({ ...w })) })),
    };
  },

  'travel.profile_save': (args) => {
    const name = String(args.name ?? '').trim();
    if (!/^[A-Za-z0-9 _-]{1,24}$/.test(name)) return { error: 'nome non valido', error_code: 'profile_bad_name' };

    const section = String(args.section ?? '') || `prof_${Date.now()}`;
    const snapshot: MockProfile = {
      section,
      name,
      saved: Math.floor(Date.now() / 1000),
      mode: mwanDefault.mode,
      autoreconnect: autoSettings.autoreconnect === '1',
      portal_check: true,
      killswitch: vpnState.killswitch,
      sticky: mwanDefault.sticky,
      wans: [
        { network: 'wwan_radio1', enabled: true, priority: 20, weight: 1 },
        { network: 'wwan_radio0', enabled: true, priority: 30, weight: 1 },
        { network: 'wan', enabled: true, priority: 10, weight: 1 },
      ],
    };

    const existing = mockProfiles.findIndex((p) => p.section === section);
    if (existing >= 0) mockProfiles[existing] = snapshot;
    else mockProfiles.push(snapshot);

    return { saved: true, section, name };
  },

  'travel.profile_delete': (args) => {
    const section = String(args.section ?? '');
    if (!mockProfiles.some((p) => p.section === section)) {
      return { error: 'profilo sconosciuto', error_code: 'profile_unknown' };
    }
    mockProfiles = mockProfiles.filter((p) => p.section !== section);
    return { deleted: true };
  },

  /**
   * Applicare un profilo cambia davvero lo stato del simulatore.
   *
   * Compreso il cancello del bilanciamento: con un tunnel VPN acceso il
   * profilo "casa" viene riportato a failover e la nota lo dice, che e'
   * esattamente cio' che fa il router. Senza questo, la scheda che mostra la
   * nota non si potrebbe provare da nessuna parte.
   */
  'travel.profile_apply': (args) => {
    const section = String(args.section ?? '');
    const profile = mockProfiles.find((p) => p.section === section);
    if (!profile) return { error: 'profilo sconosciuto', error_code: 'profile_unknown' };

    let mode = profile.mode;
    let note = '';
    let noteHolder = '';
    if (mode === 'balance') {
      const holder = mockHolder('balance');
      if (holder) {
        mode = 'failover';
        note = `il profilo chiedeva il bilanciamento: ${MOCK_REASON[holder] ?? holder}`;
        noteHolder = holder;
      }
    }

    mwanDefault.mode = mode === 'balance' ? 'balance' : 'failover';
    mwanDefault.sticky = profile.sticky;
    autoSettings.autoreconnect = profile.autoreconnect ? '1' : '0';
    vpnState.killswitch = profile.killswitch;
    vpnState.resumeAt = 0;

    return {
      applied: true,
      section,
      mode,
      note,
      ...(noteHolder
        ? {
            note_code: 'profile_balance_blocked',
            note_params: {
              holder: noteHolder,
              name: noteHolder === 'wireguard' ? (wgActiveMock()?.name ?? '') : '',
            },
          }
        : {}),
    };
  },

  // Un backup finto ma vero abbastanza: e' un .tar.gz valido e vuoto, cosi' il
  // pulsante scarica un file che il browser apre invece di un blocco di byte a
  // caso che sembrerebbe corrotto.
  'travel.backup_export': () => ({
    ok: true,
    name: `backup-${systemState.hostname}-simulato.tar.gz`,
    size: 32,
    data: 'H4sIAAAAAAAAA+3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAOBtCw+SFAAoAAA=',
  }),

  'travel.backup_import': (args) => {
    const chunk = String(args.chunk ?? '');
    if (chunk.length === 0) return { error: 'pezzo vuoto', error_code: 'chunk_empty' };
    // Lo stesso controllo del router: un pezzo tagliato fuori dai multipli di
    // quattro produrrebbe un archivio corrotto, e va scoperto qui e non dopo.
    if (chunk.length % 4 !== 0) return { error: 'pezzo non allineato', error_code: 'chunk_misaligned' };
    if (args.last !== true) return { received: true, size: chunk.length };
    return { restored: true, size: chunk.length, reboot_in: 2 };
  },

  'travel.time_get': () => ({
    now: Math.floor(Date.now() / 1000),
    local: new Date().toLocaleString('it-IT'),
    section: systemState.section,
    zonename: timeState.zonename,
    timezone: timeState.timezone,
    ntp_enabled: timeState.ntp_enabled,
    ntpd_running: timeState.ntp_enabled,
    plausible: true,
    // Come il dispositivo vero: niente orologio a batteria, ed e' il motivo
    // per cui la scheda esiste.
    rtc: false,
    servers: [...timeState.servers],
  }),

  'travel.time_set': (args) => {
    const servers = String(args.servers ?? '')
      .split(' ')
      .filter((s) => s.length > 0);
    if (servers.length === 0) return { error: 'serve almeno un server NTP', error_code: 'ntp_none' };
    timeState.timezone = String(args.timezone ?? timeState.timezone);
    timeState.zonename = String(args.zonename ?? '');
    timeState.ntp_enabled = args.enabled !== false;
    timeState.servers = servers;
    return { saved: true, servers: servers.length };
  },

  'travel.reboot_get': () => ({ ...rebootState, cron_running: true }),

  'travel.reboot_set': (args) => {
    rebootState.enabled = args.enabled === true;
    rebootState.hour = Number(args.hour ?? 4);
    rebootState.minute = Number(args.minute ?? 0);
    rebootState.weekday = String(args.weekday ?? '*');
    return { saved: true, enabled: rebootState.enabled };
  },

  // Il simulatore non ha niente da riavviare: risponde come il router e resta
  // dov'e'. Il riavvio vero si prova sul dispositivo, ed e' una delle poche
  // cose che qui non si possono fingere.
  'travel.reboot_now': () => ({ rebooting: true, reboot_in: 2 }),

  'traveld.reset': () => {
    for (const key of Object.keys(penalties)) delete penalties[key];
    return { reset: true };
  },

  // La LAN parte in conflitto con la rete simulata a monte (192.168.0.x su
  // /16): e' lo scenario che la schermata deve saper riconoscere.
  'travel.lan': () => ({
    device: 'br-lan',
    up: true,
    addresses: [...lanState.addresses],
    netmask: lanState.netmask,
    dhcp: { start: lanState.start, limit: lanState.limit, leasetime: '12h', ignore: false },
    addresses6: [...lanState.addresses6],
    ula: lanState.ula,
    dns_client: [...lanState.dnsClient],
    dns_client6: [...lanState.dnsClient6],
    dns_upstream: [...lanState.dnsUpstream],
    dnsmasq_section: 'cfg01411c',
    dhcp_options: [...lanState.dhcpOptions],
    ra: lanState.ra,
    dhcpv6: lanState.dhcpv6,
    ra_flags: [...lanState.raFlags],
    ra_slaac: lanState.raSlaac,
    ra_default: lanState.raDefault,
  }),

  // Multi-WAN: la 5 GHz online e preferita, la 2.4 online di riserva, la porta
  // ethernet senza cavo quindi offline. Un tracking IP su due perso sulla 2.4,
  // per vedere come si legge un controllo di salute a meta'.
  'travel.mwan_apply': () => ({ applied: true }),

  // Riavvio del controller USB: sul router stacca e riattacca il driver xhci.
  // Qui non c'e' niente da riavviare, ma la risposta ha la stessa forma.
  'travel.usb_reset': () => ({ reset: true, controller: '11200000.xhci', mode: 'usb2' }),

  'travel.mwan': () => {
    const iface = (
      network: string,
      priority: number,
      status: string,
      tracking: Array<{ ip: string; status: string; latency: number; packetloss: number }>,
    ) => ({
      network,
      // Il nome fisico si ricava dalla porta che usa quell'interfaccia, come
      // fa il router leggendo `network.<net>.device`.
      device: ethState.ports.find((p) => p.network === network)?.name ?? '',
      enabled: true,
      priority,
      weight: 1,
      interval: 5,
      timeout: 2,
      count: 1,
      up: 3,
      down: 3,
      reliability: 1,
      track_ip: tracking.map((t) => t.ip),
      status,
      online: status === 'online' ? 4200 : 0,
      uptime: 4200,
      score: status === 'online' ? 10 : 0,
      lost: tracking.filter((t) => t.status !== 'up').length,
      tracking,
    });

    return {
      installed: true,
      running: true,
      mode: mwanDefault.mode,
      default_sticky: mwanDefault.sticky,
      default_timeout: mwanDefault.timeout,
      policy: mockPolicy(),
      rules: [],
      interfaces: [
        iface('wwan_radio1', 20, radios.radio1.sta ? 'online' : 'offline', [
          { ip: '9.9.9.9', status: 'up', latency: jitter(18, 6), packetloss: 0 },
          { ip: '208.67.222.222', status: 'up', latency: jitter(24, 8), packetloss: 0 },
        ]),
        iface('wwan_radio0', 30, radios.radio0.sta ? 'online' : 'offline', [
          { ip: '1.1.1.1', status: 'up', latency: jitter(31, 10), packetloss: 0 },
          { ip: '8.8.8.8', status: 'down', latency: 0, packetloss: 100 },
        ]),
        // Le porte compaiono solo se sono davvero uplink: una porta dentro il
        // bridge della LAN non e' una WAN, ed e' il caso che va verificato.
        ...ethState.ports
          .filter((p) => p.network && !p.disabled && !ethState.bridgePorts.includes(p.name))
          .map((p) =>
            iface(p.network, 10, p.carrier === 1 ? 'online' : 'offline', [
              { ip: '1.0.0.1', status: 'down', latency: 0, packetloss: 100 },
              { ip: '8.8.4.4', status: 'down', latency: 0, packetloss: 100 },
            ]),
          ),
      ],
    };
  },

  'travel.ethports': () => ({
    bridge_section: ethState.bridgeSection,
    bridge_ports: [...ethState.bridgePorts],
    zone_section: ethState.zoneSection,
    zone_networks: [...ethState.zoneNetworks],
    ports: ethState.ports.map((p) => ({
      name: p.name,
      role: ethState.bridgePorts.includes(p.name)
        ? 'lan'
        : p.network && !p.disabled
          ? 'wan'
          : 'free',
      network: p.network,
      carrier: p.carrier,
      mwan3: false,
      mac: p.mac,
      mac_config: p.macConfig,
      device_section: p.devSection,
    })),
  }),

  'travel.networks': () => ({
    // La chiave non esce, come non esce da `travel.networks` sul router: si
    // dice solo se c'e'.
    networks: Object.values(savedNetworks).map(({ key, ...net }) => ({
      ...net,
      has_key: key !== '',
    })),
  }),

  /**
   * Perche' la STA non si e' agganciata, leggendo il log come fa il router.
   *
   * Senza `after` si risponde solo con il segnalibro e nessun verdetto: e' il
   * contratto del metodo vero, e serve a non attribuire a questo tentativo le
   * righe di quello prima. Le righe sono quelle di wpa_supplicant, perche' la
   * schermata le mostra alla lettera.
   */
  'travel.sta_diagnose': (args) => {
    const name = String(args.radio ?? '');
    const radio = radios[name];
    const mark = staLog.length;

    const raw = Number(args.after ?? 0);
    const after = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    if (!radio || after === 0) return { state: '', detail: '', mark };

    // Come sul router: si salta tutto cio' che precede il segnalibro, e di
    // quel che resta si guardano solo le righe di questa interfaccia.
    const iface = `phy${radio.index}-sta0`;
    const lines = staLog.slice(after).filter((line) => line.includes(`${iface}:`));
    const last = (needle: RegExp) => [...lines].reverse().find((line) => needle.test(line)) ?? '';

    const wrong = last(/reason=WRONG_KEY|pre-shared key may be incorrect/);
    if (wrong) return { state: 'wrong-key', detail: wrong, mark };

    const missing = last(/CTRL-EVENT-NETWORK-NOT-FOUND/);
    if (missing) return { state: 'not-found', detail: missing, mark };

    const rejected = last(/CTRL-EVENT-ASSOC-REJECT/);
    if (rejected) return { state: 'rejected', detail: rejected, mark };

    return { state: '', detail: '', mark };
  },

  'travel.stage_connect_saved': (args) => {
    const entry = savedNetworks[String(args.section ?? '')];
    const name = String(args.radio ?? '');
    if (!entry || !radios[name]) return { error: 'rete salvata o radio sconosciuta', error_code: 'unknown_saved' };
    pending.push(() => {
      const radio = radios[name];
      if (radio) {
        // Il MAC e' quello della banda di questa radio, come sul router: due
        // radio possono avere due indirizzi per la stessa rete salvata.
        radio.sta = {
          ssid: entry.ssid,
          key: entry.key,
          mac: savedMac(entry, radio.band),
          since: Date.now(),
        };
      }
      // Come sul router: il nome DHCP e' salvato con la rete ma vive
      // sull'interfaccia, e viene riscritto a ogni connessione.
      wanHostnames[`wwan_${name}`] =
        entry.hostname_mode === 'device'
          ? ''
          : entry.hostname_mode === 'custom' && entry.hostname_value
            ? entry.hostname_value
            : '*';
      noteStaAttempt(name);
    });
    return { staged: true };
  },

  'travel.usb_devices': () => ({
    devices: usbDevices,
    modules: {
      usbnet: 'installato',
      cdc_ncm: 'caricato',
      rndis_host: 'installato',
      cdc_ether: 'installato',
      cdc_mbim: 'assente',
      cdc_eem: 'assente',
      ipheth: 'assente',
    },
    wan_usb: {
      device: usbDevices[0]?.netdev ?? '',
      // Come sul router: senza un'interfaccia agganciata l'hotplug non e' mai
      // arrivato a riabilitarla.
      disabled: !usbDevices[0]?.netdev,
    },
  }),

  // La levetta non si puo' muovere da un browser, ma la posizione conta lo
  // stesso: come sul router, scegliere una funzione la applica subito a dov'e'
  // la levetta adesso, altrimenti resterebbe da vedere un LED che la smentisce.
  'travel.toggle_get': () => ({
    ...physicalToggleState,
    actions: toggleActions(),
    names: toggleNames(),
  }),
  'travel.toggle_set': (args) => {
    if (typeof args.action !== 'string') return { error: 'action deve essere una stringa.', error_code: 'toggle_bad_action_type' };
    if (!toggleActions().includes(args.action)) return { error: 'Azione non valida.', error_code: 'toggle_bad_action' };
    const previous = physicalToggleState.action;
    physicalToggleState.action = args.action;
    // L'allineamento e' la parte che conta, ed e' la stessa del router: la
    // scelta si applica subito a dov'e' la levetta adesso, altrimenti
    // resterebbe da vedere un LED - o un tunnel - che la smentisce.
    if (physicalToggleState.position !== 'unknown') {
      const on = physicalToggleState.position === 'on';
      if (args.action === 'led') statusLedState.enabled = on;
      // L'access point della banda scelta segue la levetta da subito: sul
      // router lo fa `ap_switch`, che scrive `disabled` e ricarica le radio.
      // Qui il pezzo di stato e' lo stesso che muove il pulsante virtuale, e
      // infatti da adesso quel pulsante non si preme piu'.
      const band = toggleApMock();
      if (band) {
        for (const radio of Object.values(radios)) {
          if (radio.band === band) radio.apEnabled = on;
        }
      }
      const wanted = toggleWgMock();
      if (wanted) {
        // Non si duplica la logica di accensione: si chiede la stessa cosa che
        // chiederebbe la scheda, con lo scambio che la levetta si puo'
        // permettere - a differenza dell'interfaccia, che invece deve dire
        // quale spegnere prima.
        const busy = wgActiveMock();
        const holder = on ? mockHolder('wireguard') : '';
        if (holder) {
          physicalToggleState.action = previous;
          return {
            error: `non posso accendere WireGuard: ${MOCK_REASON[holder]}`,
            error_code: 'wg_blocked',
            error_params: { holder, name: holder === 'wireguard' ? (busy?.name ?? '') : '' },
          };
        }
        // Con la levetta in basso non resta acceso niente: da adesso
        // l'interfaccia non accende e non spegne piu', e un tunnel acceso da
        // prima resterebbe senza interruttore.
        if (busy && busy !== wanted) busy.active = false;
        wanted.active = on;
      }
    }
    return { ...physicalToggleState, actions: toggleActions(), names: toggleNames() };
  },

  'travel.led_get': () => ({ ...statusLedState }),
  'travel.led_set': (args) => {
    if (typeof args.enabled !== 'boolean') return { error: 'enabled deve essere booleano.', error_code: 'led_bad_enabled' };
    statusLedState.enabled = args.enabled;
    return { ...statusLedState };
  },

  'travel.usb': () => ({
    force_usb2: usbState.force_usb2,
    mode: usbState.force_usb2 ? 'usb2' : 'usb3',
  }),

  // Applica quello che `uci set travel.usb.force_usb2` ha gia' scritto: sul
  // router e' cio' che spegne o riaccende le porte del root hub.
  'travel.usb_mode': () => ({
    applied: true,
    mode: usbState.force_usb2 ? 'usb2' : 'usb3',
  }),

  'travel.mark_used': (args) => {
    const entry = savedNetworks[String(args.section ?? '')];
    if (entry) {
      entry.last_used = Math.floor(Date.now() / 1000);
      entry.last_result = String(args.result ?? '');
    }
    return { saved: true };
  },

  // Scansiona anche una radio libera: sul router lo fa creando al volo
  // un'interfaccia temporanea, qui basta guardare la banda della radio.
  'travel.scan': (args) => {
    const name = String(args.radio ?? '');
    const radio = radios[name];
    if (!radio) return { error: 'radio sconosciuta', error_code: 'unknown_radio', results: [] };
    return scanForBand(radio.band);
  },

  // --- uci: le modifiche restano in sospeso fino alla conferma ---

  /**
   * Lettura della sezione selezionata o di una singola opzione, come rpcd.
   *
   * Serve alla condivisione, che chiede la chiave di una rete alla volta. Il
   * simulatore riproduce anche il caso scomodo: un'opzione che non c'e' - una
   * rete aperta non ha `key` - non risponde con una stringa vuota ma con
   * "nessun dato", codice 5. Chi chiama deve distinguere le due cose, e se il
   * simulatore rispondesse vuoto quel ramo non verrebbe mai provato.
   */
  'uci.get': (args) => {
    const config = String(args.config ?? '');
    const section = String(args.section ?? '');
    const option = String(args.option ?? '');

    if (config === 'travel') {
      const entry = savedNetworks[section];
      if (!entry) throw new UbusError(UBUS_NOT_FOUND, 'uci.get');
      const values: Record<string, string> = {
        '.type': 'network',
        '.name': section,
        ssid: entry.ssid,
        encryption: entry.encryption,
        band: entry.band,
        hidden: entry.hidden ? '1' : '0',
        mac_mode: entry.mac_mode,
        mac_value: entry.mac_value,
      };
      // I campi per banda solo se ci sono davvero: chi legge la sezione lo fa
      // proprio per sapere se esistono, e riportarli vuoti quando mancano
      // renderebbe indistinguibile una voce nata prima che si separassero.
      if (entry.mac_mode_24 !== undefined) values.mac_mode_24 = entry.mac_mode_24;
      if (entry.mac_value_24 !== undefined) values.mac_value_24 = entry.mac_value_24;
      if (entry.mac_mode_5 !== undefined) values.mac_mode_5 = entry.mac_mode_5;
      if (entry.mac_value_5 !== undefined) values.mac_value_5 = entry.mac_value_5;
      if (entry.key !== '') values.key = entry.key;
      if (!option) return { values };
      if (!(option in values)) throw new UbusError(UBUS_NOT_FOUND, 'uci.get');
      return { value: values[option] };
    }

    throw new UbusError(UBUS_NOT_FOUND, 'uci.get');
  },

  'uci.delete': (args) => {
    const section = String(args.section ?? '');

    // Cancellazione di una singola opzione: e' cosi' che si svuota una lista,
    // perche' scriverla vuota uci non lo accetta.
    if (args.config === 'dhcp' && args.option) {
      const option = String(args.option);
      pending.push(() => {
        if (option === 'dhcp_option') {
          lanState.dhcpOptions = [];
          lanState.dnsClient = [];
        }
        if (option === 'server') lanState.dnsUpstream = [];
        if (option === 'dns') lanState.dnsClient6 = [];
        // "Spento" cancella i flag invece di scriverli vuoti, ed e' la stessa
        // distinzione di tutte le altre liste qui sopra.
        if (option === 'ra_flags') lanState.raFlags = [];
        if (option === 'ra_slaac') lanState.raSlaac = '';
      });
      return {};
    }

    // MAC tolto da una porta: torna quello di fabbrica. Vale la stessa
    // distinzione del nome DHCP qui sotto - cancellare l'opzione non e'
    // scriverla vuota - e per il MAC e' la differenza fra una porta che torna
    // su e una che non sale piu'.
    if (args.config === 'network' && args.option === 'macaddr') {
      pending.push(() => {
        const port = ethState.ports.find((p) => p.devSection === section);
        if (!port) return;
        port.macConfig = '';
        port.mac = port.factory;
      });
      return {};
    }

    // Nome DHCP tolto: l'interfaccia torna al default di OpenWrt, cioe' manda
    // il nome del router. Cancellare l'opzione e scriverla vuota non sono la
    // stessa cosa, e il simulatore deve distinguerle come il router.
    if (args.config === 'network' && args.option === 'hostname') {
      pending.push(() => {
        wanHostnames[section] = '';
      });
      return {};
    }

    // Ultima porta tolta dal bridge: la rete locale resta sul solo WiFi.
    if (args.config === 'network' && section === ethState.bridgeSection && args.option === 'ports') {
      pending.push(() => {
        ethState.bridgePorts = [];
      });
      return {};
    }

    if (args.config === 'travel') {
      pending.push(() => {
        delete savedNetworks[section];
      });
      return {};
    }
    // Torna al MAC della scheda: si cancella l'opzione, non la si scrive
    // vuota. La STA resta dov'e'.
    if (section.startsWith('sta_') && args.option === 'macaddr') {
      const name = radioOf(section);
      pending.push(() => {
        const radio = radios[name];
        if (!radio || !radio.sta) return;
        radio.sta.mac = '';
        radio.sta.since = Date.now();
      });
      return {};
    }

    if (section.startsWith('sta_')) {
      const name = radioOf(section);
      pending.push(() => {
        const radio = radios[name];
        if (radio) radio.sta = null;
      });
    }
    return {};
  },

  'uci.add': (args) => {
    const values = (args.values ?? {}) as Record<string, string>;

    // Sezione `device`: e' li' che vive il MAC di una porta, non
    // sull'interfaccia. Prima del ramo delle interfacce, che si riconosce da
    // `device` e non da `name`, per non dipendere dall'ordine dei campi.
    if (args.config === 'network' && args.type === 'device') {
      const section = String(args.name ?? '');
      const target = values.name ?? '';
      pending.push(() => {
        const port = ethState.ports.find((p) => p.name === target);
        if (!port) return;
        port.devSection = section;
        if (values.macaddr !== undefined) {
          port.macConfig = values.macaddr;
          port.mac = appliedMac(values.macaddr);
        }
      });
      return {};
    }

    // Nuova interfaccia WAN per una porta che prima non ne aveva una.
    if (args.config === 'network' && values.device) {
      const name = String(args.name ?? '');
      const device = values.device;
      pending.push(() => {
        const port = ethState.ports.find((p) => p.name === device);
        if (port) {
          port.network = name;
          port.disabled = false;
        }
      });
      return {};
    }

    if (args.config === 'travel') {
      const section = String(args.name ?? `net_${Date.now().toString(36)}`);
      pending.push(() => {
        savedNetworks[section] = {
          section,
          ssid: values.ssid ?? '',
          encryption: values.encryption ?? '',
          band: values.band ?? '',
          hidden: values.hidden === '1',
          mac_mode: values.mac_mode ?? 'device',
          mac_value: values.mac_value ?? '',
          mac_mode_24: values.mac_mode_24,
          mac_value_24: values.mac_value_24,
          mac_mode_5: values.mac_mode_5,
          mac_value_5: values.mac_value_5,
          hostname_mode: values.hostname_mode ?? 'none',
          hostname_value: values.hostname_value ?? '',
          note: values.note ?? '',
          priority: Number(values.priority ?? 0),
          disabled: values.disabled === '1',
          last_used: 0,
          last_result: '',
          key: values.key ?? '',
        };
      });
      return {};
    }

    const name = values.device ?? '';
    pending.push(() => {
      const radio = radios[name];
      if (!radio) return;
      radio.sta = {
        ssid: values.ssid ?? '',
        key: values.key ?? '',
        mac: values.macaddr ?? '',
        since: Date.now(),
      };
      noteStaAttempt(name);
    });
    return {};
  },

  'uci.set': (args) => {
    const section = String(args.section ?? '');
    const values = (args.values ?? {}) as Record<string, string>;

    // Il router rifiuta una lista vuota: rpcd cancella l'opzione e poi torna
    // comunque "argomento non valido", perche' non ha scritto nessun elemento.
    // Il simulatore deve rifiutarla allo stesso modo, altrimenti una scrittura
    // che sul dispositivo fallisce qui sembra funzionare.
    for (const [option, value] of Object.entries(args.values ?? {})) {
      if (Array.isArray(value) && value.length === 0) {
        throw new Error(`uci.set: argomento non valido (codice 2) [${option} vuoto]`);
      }
    }

    if (args.config === 'network' && section === ethState.bridgeSection) {
      const raw = (args.values ?? {}) as Record<string, unknown>;
      pending.push(() => {
        if (Array.isArray(raw.ports)) ethState.bridgePorts = raw.ports.map(String);
      });
      return {};
    }

    // MAC riscritto su una porta che ha gia' la sua sezione `device`.
    {
      const port = ethState.ports.find((p) => p.devSection !== '' && p.devSection === section);
      if (args.config === 'network' && port && values.macaddr !== undefined) {
        const mac = values.macaddr;
        pending.push(() => {
          port.macConfig = mac;
          port.mac = appliedMac(mac);
        });
        return {};
      }
    }

    if (args.config === 'firewall' && section === ethState.zoneSection) {
      const raw = (args.values ?? {}) as Record<string, unknown>;
      pending.push(() => {
        if (Array.isArray(raw.network)) ethState.zoneNetworks = raw.network.map(String);
      });
      return {};
    }

    // La regola generale: mwan_apply non passa da `pending`/rollback, quindi
    // qui si applica subito, come fa `uci.apply` senza rollback.
    if (args.config === 'mwan3' && section === 'travel_default') {
      if (values.use_policy) {
        mwanDefault.mode = values.use_policy === 'travel_balance' ? 'balance' : 'failover';
      }
      if (values.sticky !== undefined) mwanDefault.sticky = values.sticky === '1';
      if (values.timeout !== undefined) mwanDefault.timeout = Number(values.timeout);
      return {};
    }

    // Prima del ramo delle porte: la stessa interfaccia logica e' anche una
    // porta, e li' il nome DHCP non verrebbe registrato.
    if (args.config === 'network' && values.hostname !== undefined) {
      const hostname = values.hostname;
      pending.push(() => {
        wanHostnames[section] = hostname;
      });
      return {};
    }

    {
      const port = ethState.ports.find((p) => p.network === section);
      if (args.config === 'network' && port) {
        pending.push(() => {
          if (values.disabled !== undefined) port.disabled = values.disabled === '1';
          if (values.device !== undefined) port.name = values.device;
        });
        return {};
      }
    }

    if (args.config === 'system') {
      // Il nome del router si applica subito: non passa da applica-e-conferma
      // perche' non puo' chiudere fuori nessuno.
      if (typeof values.hostname === 'string') systemState.hostname = values.hostname;
      return {};
    }

    if (args.config === 'network' && section === 'lan') {
      const raw = (args.values ?? {}) as Record<string, unknown>;
      pending.push(() => {
        if (Array.isArray(raw.ipaddr)) lanState.addresses = raw.ipaddr.map(String);
        if (typeof raw.netmask === 'string') lanState.netmask = raw.netmask;
      });
      return {};
    }

    if (args.config === 'dhcp') {
      const raw = (args.values ?? {}) as Record<string, unknown>;
      pending.push(() => {
        if (typeof raw.start === 'string') lanState.start = raw.start;
        if (typeof raw.limit === 'string') lanState.limit = raw.limit;
        if (Array.isArray(raw.dhcp_option)) {
          lanState.dhcpOptions = raw.dhcp_option.map(String);
          const six = lanState.dhcpOptions.find((o) => o.startsWith('6,'));
          lanState.dnsClient = six ? six.slice(2).split(',') : [];
        }
        if (Array.isArray(raw.server)) lanState.dnsUpstream = raw.server.map(String);
        // `dhcp.lan.dns` e' la lista dei DNS v6, quella che legge odhcpd: e'
        // un'opzione diversa da `dhcp_option`, e qui restano diverse.
        if (Array.isArray(raw.dns)) lanState.dnsClient6 = raw.dns.map(String);
        if (typeof raw.ra === 'string') lanState.ra = raw.ra;
        if (typeof raw.dhcpv6 === 'string') lanState.dhcpv6 = raw.dhcpv6;
        if (typeof raw.ra_default === 'string') lanState.raDefault = raw.ra_default;
        if (Array.isArray(raw.ra_flags)) lanState.raFlags = raw.ra_flags.map(String);
        if (typeof raw.ra_slaac === 'string') lanState.raSlaac = raw.ra_slaac;
      });
      return {};
    }

    if (args.config === 'travel' && section === 'usb') {
      // Come sul router: la scrittura e' immediata, l'effetto sull'hardware
      // arriva dopo, con travel.usb_mode.
      if (values.force_usb2 !== undefined) usbState.force_usb2 = values.force_usb2 === '1';
      return {};
    }

    // Il kill switch: la regola di firewall e' l'effetto, la sezione `vpn` di
    // travel e' l'intenzione. Le due si scrivono sempre insieme, e il
    // simulatore le tiene insieme allo stesso modo - altrimenti non
    // riprodurrebbe proprio lo stato che la schermata deve saper distinguere,
    // cioe' la sospensione.
    if (args.config === 'firewall' && section === 'travel_killswitch') {
      const enabled = values.enabled === '1';
      pending.push(() => {
        vpnState.killswitchBlocking = enabled;
      });
      return {};
    }

    if (args.config === 'travel' && section === 'vpn') {
      pending.push(() => {
        if (values.killswitch !== undefined) vpnState.killswitch = values.killswitch === '1';
        if (values.resume_at !== undefined) vpnState.resumeAt = Number(values.resume_at);
      });
      return {};
    }

    if (args.config === 'travel' && section === 'tailscale') {
      pending.push(() => {
        if (values.exit_node !== undefined) vpnState.exitNode = values.exit_node;
        if (values.accept_routes !== undefined) vpnState.acceptRoutes = values.accept_routes === '1';
        if (values.accept_dns !== undefined) vpnState.acceptDns = values.accept_dns === '1';
        if (values.advertise_lan !== undefined) vpnState.advertiseLan = values.advertise_lan === '1';
        if (values.advertise_exit !== undefined) {
          const on = values.advertise_exit === '1';
          // Il cronometro dell'approvazione riparte solo quando si accende, non
          // a ogni salvataggio: altrimenti toccare un'altra impostazione
          // rimetterebbe l'exit node in attesa senza motivo.
          if (on && !vpnState.advertiseExit) vpnState.advertiseExitAt = Date.now();
          vpnState.advertiseExit = on;
        }
      });
      return {};
    }

    if (args.config === 'travel' && section === 'globals') {
      pending.push(() => {
        for (const [k, v] of Object.entries(values)) autoSettings[k] = v;
      });
      return {};
    }

    if (args.config === 'travel') {
      pending.push(() => {
        const entry = savedNetworks[section];
        if (!entry) return;
        // Il nome si riscrive solo sulle reti nascoste, ed e' il rimedio a un
        // refuso: senza, correggerlo dal simulatore non avrebbe nessun effetto
        // e la prova del giro "sbaglia, correggi, riprova" non direbbe niente.
        if (values.ssid !== undefined) entry.ssid = values.ssid;
        if (values.encryption !== undefined) entry.encryption = values.encryption;
        if (values.hidden !== undefined) entry.hidden = values.hidden === '1';
        if (values.band !== undefined) entry.band = values.band;
        if (values.mac_mode !== undefined) entry.mac_mode = values.mac_mode;
        if (values.mac_value !== undefined) entry.mac_value = values.mac_value;
        if (values.mac_mode_24 !== undefined) entry.mac_mode_24 = values.mac_mode_24;
        if (values.mac_value_24 !== undefined) entry.mac_value_24 = values.mac_value_24;
        if (values.mac_mode_5 !== undefined) entry.mac_mode_5 = values.mac_mode_5;
        if (values.mac_value_5 !== undefined) entry.mac_value_5 = values.mac_value_5;
        if (values.note !== undefined) entry.note = values.note;
        if (values.hostname_mode !== undefined) entry.hostname_mode = values.hostname_mode;
        if (values.hostname_value !== undefined) entry.hostname_value = values.hostname_value;
        if (values.disabled !== undefined) entry.disabled = values.disabled === '1';
        if (values.priority !== undefined) entry.priority = Number(values.priority);
        if (values.key !== undefined) entry.key = values.key;
      });
      return {};
    }

    // MAC clonato su una STA gia' collegata. Come sul router, l'associazione
    // riparte: per qualche secondo non c'e' indirizzo, ed e' proprio la
    // finestra in cui la verifica dell'uscita deve dire "non misurata" invece
    // di tirare a indovinare.
    if (section.startsWith('sta_') && values.macaddr !== undefined) {
      const name = radioOf(section);
      const mac = values.macaddr;
      pending.push(() => {
        const radio = radios[name];
        if (!radio || !radio.sta) return;
        radio.sta.mac = mac;
        radio.sta.since = Date.now();
      });
      return {};
    }

    if (!section.startsWith('ap_')) return {};

    if (values.disabled !== undefined) {
      const name = radioOf(section);
      const enabled = values.disabled === '0';
      pending.push(() => {
        const radio = radios[name];
        if (radio) radio.apEnabled = enabled;
      });
    }

    // Le impostazioni arrivano una volta per sezione, ma l'access point
    // simulato e' uno solo: l'ultima scrittura vince, come sul router dove le
    // due sezioni finiscono identiche.
    if (values.ssid !== undefined || values.encryption !== undefined || values.key !== undefined) {
      const { ssid, encryption, key } = values;
      pending.push(() => {
        if (ssid !== undefined) ap.ssid = ssid;
        if (encryption !== undefined) ap.encryption = encryption;
        if (key !== undefined) ap.hasKey = key.length > 0;
      });
    }
    return {};
  },

  'uci.apply': (args) => {
    // Armare il ritorno indietro senza niente in sospeso e' un errore, non un
    // successo silenzioso: il router risponde "nessun dato" (codice 5).
    //
    // Il simulatore lo riproduce perche' e' la spia di uno schema sbagliato -
    // un metodo `travel.*` che fa `uci commit` da se', messo dentro
    // applica-e-conferma, che quindi non trova piu' niente da applicare.
    // Passava di qui senza un lamento e si e' scoperto solo sul dispositivo,
    // accendendo WireGuard.
    //
    // Solo con `rollback`: e' il caso osservato. Un `uci apply` semplice a
    // vuoto non e' stato provato sul router, e il simulatore non deve
    // affermare comportamenti che nessuno ha misurato - ci sono flussi che
    // qui applicano dopo scritture che il simulatore esegue subito, e
    // rifiutarli sarebbe un falso allarme.
    if (args.rollback === true && pending.length === 0) {
      throw new Error('uci.apply: nessun dato (codice 5)');
    }

    if (args.rollback === true) {
      // Il router riconfigura il WiFi: per qualche secondo non risponde. E' la
      // finestra in cui si vede se il conto alla rovescia regge. Le modifiche
      // restano in sospeso fino alla conferma.
      unreachableUntil = Date.now() + BLACKOUT_MS;
      return {};
    }
    // Senza ritorno indietro si applica e basta: e' il caso delle modifiche
    // che non possono chiudere fuori nessuno, come le reti salvate.
    pending.forEach((change) => change());
    pending = [];
    return {};
  },

  'uci.confirm': () => {
    pending.forEach((change) => change());
    pending = [];
    return {};
  },

  'uci.rollback': () => {
    pending = [];
    unreachableUntil = 0;
    return {};
  },
};

export async function mockCall<T>(
  object: string,
  method: string,
  args: Record<string, unknown>,
): Promise<T> {
  const key = `${object}.${method}`;

  // Le scansioni vere durano secondi - 6 sul 5 GHz, misurati sul dispositivo.
  // Simularle veloci nasconderebbe proprio i problemi di UX da risolvere.
  // Un probe vero esce sulla rete e aspetta: risoluzione del nome, connessione,
  // risposta - o l'attesa piena del timeout se non risponde nessuno. Simularlo
  // istantaneo nasconderebbe proprio il pezzo di interfaccia che serve.
  const latency =
    key === 'travel.scan'
      ? args.radio === 'radio1'
        ? 6000
        : 1200
      : key === 'travel.portal_probe' || key === 'traveld.portal_check'
        ? 2500
        : jitter(90, 60);

  await new Promise((resolve) => setTimeout(resolve, latency));

  if (Date.now() < unreachableUntil && !key.startsWith('uci.')) {
    throw new Error('mock: router non raggiungibile (riconfigurazione WiFi in corso)');
  }

  const handler = handlers[key];
  if (!handler) {
    throw new Error(`mock: nessuna risposta definita per ${key}`);
  }
  return handler(args) as T;
}
