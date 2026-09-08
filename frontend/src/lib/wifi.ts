/**
 * Radio, scansione e connessione a una rete WiFi.
 *
 * La lettura passa da `travel.radios`, che compone la risposta sul router
 * senza far uscire i segreti. La scrittura passa dall'oggetto `uci`, cioe'
 * dallo stesso meccanismo di applica-e-conferma che usa LuCI (decisione D5).
 */

import { call } from './ubus';
import { stageWanHostname } from './hostname';
import type { HostnameChoice } from './hostname';

export type Band = '2.4' | '5';

/** La scansione a 5 GHz arriva a 6 secondi: i canali radar vanno ascoltati in
 *  passivo. Il timeout normale di 10s non basta. */
const SCAN_TIMEOUT_MS = 30_000;

export interface Radio {
  /** Nome della sezione uci, es. "radio0". */
  name: string;
  band: Band | null;
  /** Interfaccia su cui lanciare la scansione, es. "phy0.0-ap0". */
  device: string | null;
  up: boolean;
  /** netifd segnala che hostapd o wpa_supplicant hanno rifiutato la config. */
  setupFailed: boolean;
  channel: number | null;
  /** Sezione uci dell'access point su questa radio, se e' configurato. */
  apSection: string | null;
  apSsid: string | null;
  /** L'access point e' configurato ma puo' essere spento. */
  apEnabled: boolean;
  /** Sezione uci della STA su questa radio, se c'e'. */
  staSection: string | null;
  staEnabled: boolean;
}

export interface ScanResult {
  ssid: string;
  bssid: string;
  channel: number;
  band: Band;
  /** dBm, negativo. */
  signal: number;
  open: boolean;
  /** Etichetta pronta da mostrare: "WPA3", "WPA2/WPA3", "Aperta"... */
  security: string;
  /** Versioni WPA annunciate, servono a scegliere la cifratura giusta. */
  wpa: number[];
  auth: string[];
  /** Vero per gli SSID nascosti, che si annunciano senza nome. */
  hidden: boolean;
  /** La radio da cui e' stato visto. */
  radio: string;
  /** Quanti punti di accesso annunciano questo stesso nome. */
  count: number;
}

/**
 * Un uplink WiFi, cioe' una STA configurata su una radio.
 *
 * Ce n'e' uno per radio, ciascuno con la propria interfaccia logica: due STA
 * agganciate alla stessa si contenderebbero l'indirizzo e una resterebbe senza.
 */
export interface Uplink {
  /** "wifi" oppure "ethernet": la zona firewall wan contiene entrambi. */
  kind?: string;
  /** Sezione uci della radio, es. "radio1". Vuota per gli uplink via cavo. */
  radio: string;
  band: string;
  section: string;
  /** Interfaccia logica di rete, es. "wwan_radio1". */
  network: string;
  device?: string;
  enabled?: boolean;
  /** Vuoto se la radio non e' riuscita ad associarsi. */
  ssid?: string;
  bssid?: string;
  channel?: number;
  signal?: number;
  /** MAC realmente in uso: se e' stato clonato, e' quello clonato. */
  mac?: string;
  /** L'interfaccia di rete e' su, cioe' ha preso un indirizzo. */
  up?: boolean;
  /** Nome inviato nel DHCP, grezzo da uci: `*` nessuno, vuoto quello del router. */
  hostname?: string;
  ipv4?: string;
  netmask?: string;
  gateway?: string;
  dns?: string[];
}

/**
 * Stato di un uplink, in ordine di gravita'.
 *
 * Qui non esiste uno stato "Internet funziona", e non ci sara' mai: averne un
 * indirizzo non lo garantisce, perche' un captive portal risponde al DHCP e
 * blocca tutto il resto. Quella e' una misura a parte, che vive in
 * `lib/portal.ts` e si affianca a questa invece di confondersi con lei.
 */
export type UplinkState = 'disabled' | 'unassociated' | 'no-address' | 'addressed';

export function uplinkState(u: Uplink): UplinkState {
  if (u.enabled === false) return 'disabled';
  if (!u.ssid) return 'unassociated';
  if (!u.up || !u.ipv4) return 'no-address';
  return 'addressed';
}

/** I canali 1-14 sono 2.4 GHz, tutto il resto su questo hardware e' 5 GHz. */
function bandOfChannel(channel: number): Band {
  return channel > 0 && channel <= 14 ? '2.4' : '5';
}

interface RadioRow {
  name?: string;
  band?: string;
  device?: string;
  up?: boolean;
  setup_failed?: boolean;
  channel?: number;
  ap_section?: string;
  ap_ssid?: string;
  ap_enabled?: boolean;
  sta_section?: string;
  sta_enabled?: boolean;
}

/**
 * L'elenco arriva da `travel.radios`, non da `network.wireless status`.
 *
 * Due motivi, entrambi seri: quella chiamata restituisce la password del WiFi
 * in chiaro, che non deve raggiungere il browser; ed e' dichiarata senza
 * argomenti, mentre uhttpd aggiunge sempre `ubus_rpc_session`, per cui da HTTP
 * fallisce con "invalid argument".
 */
export async function listRadios(): Promise<Radio[]> {
  const response = await call<{ radios?: RadioRow[] }>('travel', 'radios');

  const radios: Radio[] = (response.radios ?? []).map((r) => {
    const channel = r.channel && r.channel > 0 ? r.channel : null;
    const band = r.band === '2.4' || r.band === '5' ? r.band : null;

    return {
      name: r.name ?? '?',
      // Se la configurazione non dichiara la banda, la dice il canale reale.
      band: band ?? (channel !== null ? bandOfChannel(channel) : null),
      device: r.device ? r.device : null,
      up: r.up === true,
      setupFailed: r.setup_failed === true,
      channel,
      apSection: r.ap_section ? r.ap_section : null,
      apSsid: r.ap_ssid ? r.ap_ssid : null,
      apEnabled: r.ap_enabled === true,
      staSection: r.sta_section ? r.sta_section : null,
      staEnabled: r.sta_enabled === true,
    };
  });

  return radios.sort((a, b) => (a.band ?? '').localeCompare(b.band ?? ''));
}

export async function getUplinks(): Promise<Uplink[]> {
  const response = await call<{ uplinks?: Uplink[] }>('travel', 'uplinks');
  return response.uplinks ?? [];
}

interface IwinfoScanEntry {
  ssid?: string;
  bssid?: string;
  channel?: number;
  signal?: number;
  encryption?: {
    enabled?: boolean;
    wpa?: number[];
    authentication?: string[];
  };
}

/** Etichetta leggibile della cifratura, dai campi grezzi di iwinfo. */
function securityLabel(wpa: number[], auth: string[], enabled: boolean): string {
  if (!enabled) return 'Aperta';

  const names: string[] = [];
  if (wpa.includes(1)) names.push('WPA');
  if (wpa.includes(2)) names.push('WPA2');
  // SAE e' WPA3; iwinfo lo riporta fra i metodi di autenticazione.
  if (wpa.includes(3) || auth.includes('sae')) names.push('WPA3');

  if (names.length === 0) return auth.includes('none') ? 'Aperta' : 'Protetta';
  return names.join('/');
}

/**
 * Valore `encryption` da scrivere in uci per la STA.
 *
 * Non si copia quello dell'access point: una rete WPA2/WPA3 in transizione va
 * agganciata con `sae-mixed`, mentre forzare `sae` su una rete solo WPA2
 * fallirebbe in silenzio.
 */
export function encryptionForSta(net: ScanResult): string {
  if (net.open) return 'none';
  const sae = net.wpa.includes(3) || net.auth.includes('sae');
  if (sae) return net.wpa.includes(2) ? 'sae-mixed' : 'sae';
  return 'psk2';
}

/**
 * La scansione passa dal router, non da `iwinfo` diretto.
 *
 * Per scansionare serve un'interfaccia su quella radio: se non c'e' - nessun
 * access point e nessuna rete collegata - il router ne crea una temporanea,
 * scansiona e la cancella. E' l'unico modo per cercare reti su una radio libera,
 * e va fatto li' perche' dal browser non si possono creare interfacce.
 */
export async function scanRadio(radio: Radio): Promise<ScanResult[]> {
  const response = await call<{ results?: IwinfoScanEntry[]; error?: string }>(
    'travel',
    'scan',
    { radio: radio.name },
    SCAN_TIMEOUT_MS,
  );

  if (response.error) throw new Error(`Scansione su ${radio.band ?? radio.name} GHz: ${response.error}`);

  const found = (response.results ?? [])
    // Un'interfaccia temporanea puo' vedere entrambe le bande: qui interessa
    // solo quella della radio che si sta scansionando.
    .filter((entry) => {
      if (!radio.band) return true;
      return bandOfChannel(entry.channel ?? 0) === radio.band;
    })
    .map((entry): ScanResult => {
      const channel = entry.channel ?? 0;
      const ssid = entry.ssid ?? '';
      const enabled = entry.encryption?.enabled === true;
      const wpa = entry.encryption?.wpa ?? [];
      const auth = entry.encryption?.authentication ?? [];

      return {
        ssid,
        bssid: entry.bssid ?? '',
        channel,
        band: bandOfChannel(channel),
        signal: entry.signal ?? -100,
        open: !enabled,
        security: securityLabel(wpa, auth, enabled),
        wpa,
        auth,
        hidden: ssid === '',
        radio: radio.name,
        count: 1,
      };
    });

  return mergeByName(found);
}

/**
 * Accorpa i punti di accesso che annunciano lo stesso nome.
 *
 * Reti mesh e ripetitori compaiono una volta per BSSID: in una hall d'albergo
 * la stessa rete puo' riempire mezzo schermo. Si tiene il segnale piu' forte,
 * che e' anche quello a cui ci si collegherebbe davvero, e si conta quanti
 * sono.
 *
 * Le reti nascoste non si accorpano: SSID vuoto non significa "stessa rete",
 * significa "nome non annunciato".
 */
function mergeByName(results: ScanResult[]): ScanResult[] {
  const strongest = new Map<string, ScanResult>();

  for (const net of results) {
    const key = net.hidden ? `${net.bssid}` : net.ssid;
    const seen = strongest.get(key);

    if (!seen) {
      strongest.set(key, { ...net });
      continue;
    }

    const count = seen.count + net.count;
    if (net.signal > seen.signal) {
      strongest.set(key, { ...net, count });
    } else {
      seen.count = count;
    }
  }

  return [...strongest.values()].sort((a, b) => b.signal - a.signal);
}

/** Da 0 a 4 tacche, per l'indicatore visivo. */
export function signalBars(dbm: number): number {
  if (dbm >= -55) return 4;
  if (dbm >= -65) return 3;
  if (dbm >= -75) return 2;
  if (dbm >= -85) return 1;
  return 0;
}

// --- Indirizzo MAC -----------------------------------------------------------

/**
 * `clone` e' il MAC di un dispositivo gia' visto sulla LAN.
 *
 * Esiste per i portali che autenticano l'indirizzo: fatto l'accesso dal
 * telefono, si fa indossare al router quello stesso MAC e la rete lo riconosce
 * come gia' autorizzato. Per il resto del sistema non e' diverso da `manual` -
 * un valore da scrivere - ma il modo si tiene distinto perche' dice *perche'*
 * quel MAC e' stato scelto, e quella e' l'informazione che serve fra un mese.
 */
export type MacMode = 'device' | 'random' | 'manual' | 'clone';

const MAC_RE = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;

/**
 * MAC casuale valido come indirizzo di stazione.
 *
 * Il primo byte deve avere il bit "amministrato localmente" acceso e quello
 * multicast spento: un MAC casuale che non rispetta le due regole viene
 * rifiutato dal driver o dalla rete a cui ci si collega.
 */
export function randomMac(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  bytes[0] = (bytes[0] & 0xfe) | 0x02;
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(':');
}

export function isValidMac(mac: string): boolean {
  if (!MAC_RE.test(mac)) return false;
  // Bit 0 del primo byte acceso = indirizzo multicast, non usabile da una
  // stazione. E' l'errore piu' facile da fare digitando a mano.
  return (parseInt(mac.slice(0, 2), 16) & 0x01) === 0;
}

/**
 * Un SSID valido secondo 802.11: da 1 a 32 byte.
 *
 * Il limite e' in byte e non in caratteri, e la differenza si vede appena si
 * usa un accento: "Località" sono 9 caratteri ma 10 byte in UTF-8. Contando i
 * caratteri si lascerebbe salvare un nome che il driver poi tronca, e una rete
 * col nome troncato non si aggancia mai senza che si capisca perche'.
 */
export function isValidSsid(ssid: string): boolean {
  const bytes = new TextEncoder().encode(ssid).length;
  return bytes >= 1 && bytes <= 32;
}

/**
 * Una passphrase WPA valida: da 8 a 63 caratteri.
 *
 * Sono i limiti dello standard, non una scelta nostra: sotto gli 8 wpa_supplicant
 * rifiuta la configurazione, e a 64 il valore verrebbe letto come una chiave
 * gia' derivata in esadecimale invece che come una password.
 */
export function isValidPassphrase(key: string): boolean {
  return key.length >= 8 && key.length <= 63;
}

// --- Connessione -------------------------------------------------------------

export interface ConnectionPlan {
  /** La radio che ospitera' la STA: quella della banda della rete scelta. */
  staRadio: Radio;
  /** L'altra radio, che resta com'e'. */
  otherRadio: Radio | null;
  /** L'access point su questa radio condividera' il canale con la rete. */
  sharesRadioWithAp: boolean;
  /** C'e' un access point attivo sull'altra radio, quindi al sicuro. */
  otherApActive: boolean;
  /** Nessun access point attivo da nessuna parte. */
  noApAtAll: boolean;
}

export interface MacChoice {
  mode: MacMode;
  /** Valore da scrivere, vuoto se si usa quello della scheda. */
  value: string;
}

/**
 * Decide quale radio usa la STA. Gli access point non vengono toccati.
 *
 * La radio la sceglie la banda della rete. Gli access point restano dove sono:
 * spegnerne uno come effetto collaterale di una connessione e' il modo piu'
 * rapido per restare chiusi fuori dal router mentre si e' in viaggio.
 *
 * Il prezzo e' che l'access point sulla stessa radio della STA ne eredita il
 * canale e puo' interrompersi quando la rete cade - vincolo dell'hardware, una
 * phy sola con un canale per radio. Per questo l'access point va tenuto acceso
 * su ENTRAMBE le radio: quello sull'altra resta indipendente e fa da rete di
 * sicurezza.
 */
export function planConnection(radios: Radio[], band: Band): ConnectionPlan | null {
  const staRadio = radios.find((r) => r.band === band);
  if (!staRadio) return null;

  const otherRadio = radios.find((r) => r.name !== staRadio.name) ?? null;

  return {
    staRadio,
    otherRadio,
    sharesRadioWithAp: staRadio.apEnabled,
    otherApActive: otherRadio?.apEnabled === true,
    noApAtAll: !radios.some((r) => r.apEnabled),
  };
}

/**
 * Prepara le modifiche per la connessione. Non applica niente: ci pensa
 * `useApply`, che poi arma il ritorno indietro automatico.
 */
export async function stageConnection(
  net: ScanResult,
  password: string,
  plan: ConnectionPlan,
  mac: MacChoice,
  hostname: HostnameChoice,
): Promise<void> {
  const section = `sta_${plan.staRadio.name}`;

  // La sezione viene ricreata da zero: aggiornandola resterebbero i campi di
  // una connessione precedente, per esempio la chiave di una rete protetta
  // quando ci si collega a una aperta, o un MAC clonato che non si vuole piu'.
  try {
    await call('uci', 'delete', { config: 'wireless', section });
  } catch {
    // Non esisteva: e' il caso normale della prima connessione.
  }

  const values: Record<string, string> = {
    device: plan.staRadio.name,
    mode: 'sta',
    network: `wwan_${plan.staRadio.name}`,
    ssid: net.ssid,
    encryption: encryptionForSta(net),
    disabled: '0',
  };
  if (!net.open) values.key = password;
  if (mac.mode !== 'device') values.macaddr = mac.value;

  await call('uci', 'add', { config: 'wireless', type: 'wifi-iface', name: section, values });

  // Il nome DHCP non sta sulla sezione wireless ma sull'interfaccia logica, e
  // va riscritto a ogni connessione: senza, resterebbe quello della rete usata
  // prima su questa radio, cioe' proprio il nome che non si voleva mandare.
  await stageWanHostname(`wwan_${plan.staRadio.name}`, hostname);

  // Nessun access point viene toccato, di proposito: sono indipendenti dalla
  // connessione. Spegnerne uno come effetto collaterale significherebbe poter
  // perdere l'unico modo di rientrare nel router mentre si e' in viaggio.
}

/** Prepara l'accensione o lo spegnimento dell'access point su una radio. */
export async function stageApEnabled(radio: Radio, enabled: boolean): Promise<void> {
  if (!radio.apSection) {
    throw new Error(
      `Nessun access point configurato su ${radio.name}. Rilancia tools\\setup-ap.ps1.`,
    );
  }
  await call('uci', 'set', {
    config: 'wireless',
    section: radio.apSection,
    values: { disabled: enabled ? '0' : '1' },
  });
}

/**
 * Prepara il cambio di MAC su una STA gia' configurata.
 *
 * Vale per la clonazione dietro un portale, ma anche per tornare indietro: MAC
 * vuoto significa togliere l'opzione, cioe' riprendere quello della scheda.
 * Cancellare non e' la stessa cosa che scrivere una stringa vuota - `macaddr=`
 * verrebbe passato al driver cosi' com'e' - e questa e' la differenza fra una
 * radio che torna su e una che non si aggancia piu'.
 *
 * Passa da applica-e-conferma come tutto il resto: cambiare il MAC fa cadere
 * l'associazione e rifare il DHCP, e se la rete non torna deve poter tornare
 * indietro da sola.
 */
export async function stageStaMac(section: string, mac: string): Promise<void> {
  if (mac) {
    await call('uci', 'set', { config: 'wireless', section, values: { macaddr: mac } });
  } else {
    await call('uci', 'delete', { config: 'wireless', section, option: 'macaddr' });
  }
}

/** Prepara la disconnessione: la STA sparisce e la radio torna libera. */
export async function stageDisconnect(radio: Radio): Promise<void> {
  if (!radio.staSection) return;
  await call('uci', 'delete', { config: 'wireless', section: radio.staSection });
}

// --- Access point ------------------------------------------------------------

export interface ApSection {
  section: string;
  radio: string;
  band: string;
  enabled: boolean;
  ssid: string;
  encryption: string;
  /** La chiave non esce mai dal router: si sa solo se esiste. */
  has_key: boolean;
  device?: string;
  bssid?: string;
  channel?: number;
  clients?: number;
}

/**
 * Cifrature offerte per l'access point.
 *
 * Solo AES/CCMP: WPA1 e la modalita' mista WPA/WPA2 trascinano dentro TKIP,
 * che e' incompatibile con VHT/HE/EHT. Su questo hardware WiFi 7 hostapd
 * rifiuta di partire, e l'access point resta giu'.
 *
 * Nessuna rete aperta: su un router da viaggio esporrebbe la LAN a chiunque sia
 * nel raggio, ed e' proprio il posto dove non si vuole.
 */
export const AP_ENCRYPTIONS = [
  {
    value: 'sae-mixed',
    label: 'WPA2 + WPA3 (consigliato)',
    note: 'Compatibile con tutto, usa WPA3 dove il dispositivo lo supporta.',
  },
  {
    value: 'sae',
    label: 'WPA3',
    note: "Il piu' sicuro. I dispositivi anteriori al 2019 circa non si collegano.",
  },
  {
    value: 'psk2',
    label: 'WPA2',
    note: 'Lo standard classico, compatibile con qualunque dispositivo recente.',
  },
] as const;

/**
 * Le cifrature fra cui si sceglie configurando una rete a mano.
 *
 * Sono esattamente i quattro valori che `encryptionForSta` deduce da una
 * scansione: configurando a mano non si inventa niente di nuovo, si dice a
 * parole quello che li' si sarebbe capito dai beacon. WEP ed Enterprise restano
 * fuori perche' il resto del pannello non li sa gestire, e offrirli qui vorrebbe
 * dire salvare una rete che poi non si aggancia.
 */
export const STA_ENCRYPTIONS = [
  {
    value: 'psk2',
    label: 'WPA2',
    note: 'Il caso normale: quasi tutte le reti protette di oggi.',
    needsKey: true,
  },
  {
    value: 'sae-mixed',
    label: 'WPA2 / WPA3',
    note: 'Reti che accettano entrambi. Se WPA2 non basta, di solito è questa.',
    needsKey: true,
  },
  {
    value: 'sae',
    label: 'WPA3',
    note: 'Solo WPA3. Una rete così rifiuta i dispositivi più vecchi.',
    needsKey: true,
  },
  {
    value: 'none',
    label: 'Nessuna (rete aperta)',
    note: 'Senza password. Il traffico viaggia in chiaro fino al punto di accesso.',
    needsKey: false,
  },
] as const;

/** Vero se questa cifratura richiede una password. */
export function needsKey(encryption: string): boolean {
  return STA_ENCRYPTIONS.find((e) => e.value === encryption)?.needsKey ?? true;
}

export function encryptionLabel(value: string): string {
  // "none" e' il valore che uci si aspetta per una rete aperta, ed e' quello
  // che `encryptionForSta` salva: mostrarlo com'e' faceva comparire la parola
  // "none" in mezzo a etichette italiane. Non sta in AP_ENCRYPTIONS perche'
  // quell'elenco riempie la scelta della cifratura dell'access point, e un
  // access point aperto non e' un'opzione da offrire.
  if (value === 'none') return 'Aperta';
  return AP_ENCRYPTIONS.find((e) => e.value === value)?.label ?? value ?? '—';
}

export async function getAp(): Promise<ApSection[]> {
  const response = await call<{ aps?: ApSection[] }>('travel', 'ap');
  return response.aps ?? [];
}

/**
 * Vero quando le radio hanno davvero accettato la configurazione.
 *
 * Da usare come verifica prima di confermare una modifica: "il router
 * risponde" non basta come prova, perche' via cavo risponde sempre, anche
 * quando hostapd ha rifiutato la configurazione e l'access point e' rimasto
 * giu'. `retry_setup_failed` e' il segnale che netifd alza in quel caso.
 */
export async function wirelessCameUp(): Promise<boolean> {
  const radios = await listRadios();
  if (radios.some((r) => r.setupFailed)) return false;

  const shouldHaveAp = radios.filter((r) => r.apEnabled);
  if (shouldHaveAp.length === 0) return true;
  return shouldHaveAp.every((r) => r.up && r.device !== null);
}

/**
 * Esito di una connessione, dal punto di vista di chi l'ha chiesta.
 *
 * "Non agganciata" da sola non e' una risposta utile: la password sbagliata e
 * la rete che non c'e' si vedono uguali da fuori - nessuna associazione - ma
 * hanno rimedi opposti, correggere la chiave o avvicinarsi. La differenza la
 * sa solo wpa_supplicant, e infatti la scrive nel log.
 */
export type ConnectOutcome =
  | 'ok'
  | 'no-address'
  | 'wrong-key'
  | 'not-found'
  | 'unassociated'
  /**
   * Non si e' potuto guardare.
   *
   * Non e' un fallimento: e' l'assenza di una misura. Il router non ha
   * risposto per tutta la finestra, quindi non si sa se la rete e' salita o
   * no. Chiamarlo "non agganciata" scriverebbe nella storia della rete un
   * guasto che nessuno ha visto.
   */
  | 'unknown';

export interface StaDiagnosis {
  /** Vuoto quando dal log non si ricava niente di conclusivo. */
  state: '' | 'wrong-key' | 'not-found' | 'rejected';
  /** La riga di log che lo dice, da mostrare cosi' com'e'. */
  detail: string;
  /** Quante righe aveva il log: si ripassa come `after` per leggere solo il seguito. */
  mark: number;
}

/**
 * Perche' la STA di questa radio non si e' agganciata, secondo il log.
 *
 * Senza `after` non si ottiene nessun verdetto, solo il segnalibro: il log e'
 * la storia di tutta la radio, e il nome dell'interfaccia non cambia da una
 * rete all'altra, quindi senza un punto da cui partire si finirebbe a
 * riportare il motivo di un tentativo precedente.
 */
export async function diagnoseSta(radio: string, after = 0): Promise<StaDiagnosis> {
  const response = await call<Partial<StaDiagnosis>>('travel', 'sta_diagnose', { radio, after });
  return {
    state: response.state ?? '',
    detail: response.detail ?? '',
    mark: response.mark ?? 0,
  };
}

/** Segnalibro nel log, da prendere prima di provare a connettersi. */
export async function logMark(radio: string): Promise<number> {
  return (await diagnoseSta(radio)).mark;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ogni quanto si guarda l'uplink mentre si aspetta l'esito. */
const POLL_MS = 2000;

/**
 * Quanto puo' essere vecchia l'ultima lettura riuscita e valere ancora come
 * "com'e' finita": circa tre giri a vuoto.
 *
 * Oltre, il router se n'e' andato prima della fine e quello che si e' visto
 * descrive un momento intermedio, non l'esito. Meglio dire che non si sa.
 */
const STALE_AFTER_MS = 8000;

/**
 * Aspetta l'esito di una connessione appena applicata su una radio.
 *
 * Si ferma appena c'e' un indirizzo, perche' quello e' il caso buono e non ha
 * senso far aspettare oltre. Scaduto il tempo si guarda com'e' finita, e solo
 * se non si e' agganciata si va a leggere il log: e' una chiamata in piu' che
 * ha senso fare solo quando c'e' davvero qualcosa da spiegare.
 *
 * L'SSID atteso e' un parametro e non un dettaglio: cambiando rete sulla
 * stessa radio, l'associazione precedente puo' essere ancora in piedi e con
 * indirizzo nei primi secondi. Un controllo sul solo stato direbbe "connessa"
 * guardando la rete di prima, cioe' darebbe per riuscita una connessione che
 * non e' ancora nemmeno cominciata.
 *
 * Non tocca niente: qualunque sia l'esito, la configurazione salvata resta
 * dov'e' e resta modificabile.
 */
export async function awaitConnection(
  radioName: string,
  ssid: string,
  seconds: number,
  /** Segnalibro nel log preso prima di applicare, da `logMark`. */
  mark: number,
): Promise<{ outcome: ConnectOutcome; uplink: Uplink | null; detail: string }> {
  const deadline = Date.now() + seconds * 1000;
  /**
   * L'ultima lettura, non la migliore vista.
   *
   * La differenza non e' una sfumatura. Con una password sbagliata la stazione
   * si associa lo stesso e cade subito dopo, quando fallisce l'handshake a
   * quattro vie: per un paio di secondi l'uplink mostra l'SSID senza
   * indirizzo. Tenendo la prima lettura buona invece dell'ultima, quel momento
   * resterebbe li' a rappresentare tutto il tentativo, e l'esito sarebbe
   * "agganciata, manca solo l'indirizzo" - cioe' "la password e' giusta, non
   * risponde il DHCP" - proprio nel caso in cui la password e' l'unico
   * problema. Si riscrive a ogni giro, cosi' quello che resta alla fine
   * descrive la fine.
   */
  let last: Uplink | null = null;
  /** Quando risale l'ultima lettura riuscita. Zero se non se n'e' fatta nessuna. */
  let lastAt = 0;

  while (Date.now() < deadline) {
    try {
      const found = (await getUplinks()).find((u) => u.radio === radioName) ?? null;
      lastAt = Date.now();
      // Solo l'uplink sulla rete che si e' chiesta. Finche' la radio riporta
      // ancora quella di prima, la riconfigurazione non e' arrivata; e se
      // l'aggancio cade, torna a non esserci nulla da tenere.
      last = found && found.ssid === ssid ? found : null;
      if (last && uplinkState(last) === 'addressed') {
        return { outcome: 'ok', uplink: last, detail: '' };
      }
    } catch {
      // Il router puo' non rispondere per qualche secondo mentre la radio si
      // riconfigura: non e' un esito, e' l'attesa. La lettura di prima resta
      // valida ancora per un po', ed e' `lastAt` a dire per quanto.
    }
    await sleep(POLL_MS);
  }

  // Niente che si sia visto abbastanza di recente da raccontare come sia
  // finita: nessuna lettura riuscita, oppure l'ultima e' troppo vecchia.
  // Inventare un esito lo scriverebbe nella storia della rete.
  if (lastAt === 0 || Date.now() - lastAt > STALE_AFTER_MS) {
    return { outcome: 'unknown', uplink: null, detail: '' };
  }

  if (last && uplinkState(last) === 'no-address') {
    return { outcome: 'no-address', uplink: last, detail: '' };
  }

  const why = await diagnoseSta(radioName, mark).catch<StaDiagnosis>(() => ({
    state: '',
    detail: '',
    mark: 0,
  }));
  const outcome: ConnectOutcome =
    why.state === 'wrong-key' ? 'wrong-key' : why.state === 'not-found' ? 'not-found' : 'unassociated';

  return { outcome, uplink: last, detail: why.detail };
}

export interface ApSettings {
  ssid: string;
  encryption: string;
  /** Vuoto significa "non cambiare la password". */
  password: string;
}

/**
 * Prepara le impostazioni dell'access point su TUTTE le sue sezioni.
 *
 * L'access point vive su entrambe le radio per potersi spostare su quella
 * libera: se le due sezioni divergessero, lo spostamento cambierebbe nome o
 * password sotto i piedi di chi e' collegato.
 */
export async function stageApSettings(aps: ApSection[], settings: ApSettings): Promise<void> {
  for (const ap of aps) {
    const values: Record<string, string> = {
      ssid: settings.ssid,
      encryption: settings.encryption,
    };
    if (settings.password) values.key = settings.password;

    await call('uci', 'set', { config: 'wireless', section: ap.section, values });
  }
}
