/**
 * Reti salvate (requisito E.2).
 *
 * Vivono in `/etc/config/travel` come sezioni `network`. La lettura passa da
 * `travel.networks`, che non fa uscire le chiavi. La scrittura passa
 * dall'oggetto `uci`, come tutto il resto.
 *
 * Per collegarsi, il router copia la password nelle modifiche in sospeso
 * (`travel.stage_connect_saved`). Solo la condivisione la legge nel browser,
 * su richiesta esplicita e per la sola sezione selezionata.
 *
 * Una rete salvata e' UNA configurazione, valida su una banda o su tutte e
 * due. Non due voci gemelle: password, cifratura e nome DHCP sono la stessa
 * cosa a 2.4 e a 5 GHz, e tenerne due copie significava correggerne una e
 * ritrovarsi con l'altra vecchia. Quello che invece resta per banda - il MAC
 * della stazione - vive in campi separati, perche' e' un parametro della radio
 * e non della rete.
 */

import { networksText } from '../i18n/networks';
import { call } from './ubus';
import { backendError } from './ubus-error';
import type { ShareInput } from './share';
import { HOSTNAME_OFF } from './hostname';
import type { HostnameChoice, HostnameMode } from './hostname';
import { normalizeMac, randomMac, uplinkState } from './wifi';
import type { Band, MacChoice, MacMode, ScanResult, Uplink } from './wifi';

/** Le due bande, nell'ordine in cui si mostrano ovunque. */
export const BANDS: readonly Band[] = ['2.4', '5'];

/** Su quali bande vale una rete salvata. */
export type BandSet = Record<Band, boolean>;

/** Il MAC scelto per ciascuna banda: e' l'unico parametro che resta separato. */
export type MacByBand = Record<Band, MacChoice>;

export interface SavedNetwork {
  /** Nome della sezione uci, es. "net_lx3f9a". */
  section: string;
  ssid: string;
  encryption: string;
  /** Le bande su cui questa configurazione va usata: almeno una. */
  bands: BandSet;
  /**
   * La rete non annuncia il proprio SSID.
   *
   * Si configura a mano, perche' in una scansione non c'e' niente da cui
   * dedurla, e resta scritta nella sezione insieme al resto: serve dopo il
   * salvataggio, non solo durante. E' quello che dice all'elenco di
   * riconoscerla e alla riconnessione automatica di non pretendere di averla
   * vista prima di provarci.
   */
  hidden: boolean;
  /** Un MAC per banda: la stazione e' una per radio, e l'indirizzo e' suo. */
  mac: MacByBand;
  /** Nome da mandare nel DHCP su questa rete: none | device | custom. */
  hostname_mode: string;
  hostname_value: string;
  note: string;
  /**
   * Piu' alta = preferita. Una sola per rete: l'ordine di preferenza non
   * cambia da una banda all'altra, ed e' quello che si legge nell'elenco.
   */
  priority: number;
  disabled: boolean;
  /** Epoch secondi, 0 se mai usata. */
  last_used: number;
  last_result: string;
  has_key: boolean;
}

/**
 * La riga cosi' come arriva da `travel.networks`.
 *
 * I campi per banda sono opzionali di proposito: l'interfaccia e il pacchetto
 * si aggiornano separatamente, e per qualche minuto una UI nuova parla con un
 * router vecchio che quei campi non li conosce. Tutto quello che manca ha una
 * risposta sola, qui sotto in `normalize`, e non nei componenti.
 */
interface SavedRow {
  section?: string;
  ssid?: string;
  encryption?: string;
  band?: string;
  hidden?: boolean;
  mac_mode?: string;
  mac_value?: string;
  mac_mode_24?: string;
  mac_value_24?: string;
  mac_mode_5?: string;
  mac_value_5?: string;
  hostname_mode?: string;
  hostname_value?: string;
  note?: string;
  priority?: number;
  disabled?: boolean;
  last_used?: number;
  last_result?: string;
  has_key?: boolean;
}

/** Il suffisso uci dei campi per banda: `mac_mode_24`, `mac_mode_5`. */
const SUFFIX: Record<Band, string> = { '2.4': '24', '5': '5' };

/**
 * Le bande di una voce salvata, dal campo `band` di uci.
 *
 * `band` continua a essere il modo in cui la scelta viene scritta, e non e'
 * pigrizia: i suoi tre valori sono esattamente i tre stati ammessi - solo 2.4,
 * solo 5, tutte e due - e vuoto significa "entrambe le radio" da prima che
 * questa schermata esistesse. Vuol dire che le configurazioni gia' sul router
 * si leggono senza riscriverle, e che un router con il pacchetto vecchio
 * continua a capire quello che questa UI scrive.
 *
 * Un valore che non riconosciamo non diventa "entrambe": travelD lo confronta
 * con la banda della radio e non trova mai corrispondenza, quindi quella rete
 * oggi non viene usata da nessuna parte. Restituire "nessuna banda" dice la
 * stessa cosa, e l'elenco la mostra da correggere invece di farla comparire
 * come attiva su due radio su cui non e' mai andata.
 */
export function bandsFromUci(band: string | undefined): BandSet {
  const value = (band ?? '').trim();
  if (value === '') return { '2.4': true, '5': true };
  if (value === '2.4') return { '2.4': true, '5': false };
  if (value === '5') return { '2.4': false, '5': true };
  return { '2.4': false, '5': false };
}

/** Il campo `band` da scrivere in uci per queste bande. */
export function bandsToUci(bands: BandSet): string {
  if (bands['2.4'] && bands['5']) return '';
  if (bands['5']) return '5';
  return '2.4';
}

export function bandList(bands: BandSet): Band[] {
  return BANDS.filter((band) => bands[band]);
}

export function hasAnyBand(bands: BandSet): boolean {
  return bandList(bands).length > 0;
}

export function sameBands(a: BandSet, b: BandSet): boolean {
  return BANDS.every((band) => a[band] === b[band]);
}

/** Etichetta di una singola banda. */
export function bandLabel(band: Band | string): string {
  return `${band} GHz`;
}

/** Le bande di una rete, in una frase: "2.4 e 5 GHz". */
export function bandsLabel(bands: BandSet): string {
  const list = bandList(bands);
  if (list.length === 0) return networksText().noBand;
  if (list.length === BANDS.length) return networksText().bothBands;
  return bandLabel(list[0]);
}

const MAC_MODES: MacMode[] = ['device', 'random', 'manual', 'clone'];

function macFrom(mode: string | undefined, value: string | undefined): MacChoice | null {
  if (!mode || !MAC_MODES.includes(mode as MacMode)) return null;
  return { mode: mode as MacMode, value: normalizeMac(value ?? '') };
}

/**
 * La forma canonica di una rete salvata.
 *
 * Sta qui, al confine, e non nei componenti: ogni campo che il router puo' non
 * mandare - perche' e' nato dopo, o perche' quel router non e' ancora stato
 * aggiornato - ha una risposta sola, decisa una volta. I campi per banda
 * ripiegano su `mac_mode`/`mac_value`, che e' quello che le voci scritte prima
 * hanno e che le versioni vecchie del pacchetto continuano a leggere.
 */
function normalize(row: SavedRow): SavedNetwork {
  const shared = macFrom(row.mac_mode, row.mac_value) ?? { mode: 'device', value: '' };

  return {
    section: row.section ?? '',
    ssid: row.ssid ?? '',
    encryption: row.encryption ?? '',
    bands: bandsFromUci(row.band),
    hidden: row.hidden === true,
    mac: {
      '2.4': macFrom(row.mac_mode_24, row.mac_value_24) ?? shared,
      '5': macFrom(row.mac_mode_5, row.mac_value_5) ?? shared,
    },
    hostname_mode: row.hostname_mode ?? 'none',
    hostname_value: row.hostname_value ?? '',
    note: row.note ?? '',
    priority: row.priority ?? 0,
    disabled: row.disabled === true,
    last_used: row.last_used ?? 0,
    last_result: row.last_result ?? '',
    has_key: row.has_key === true,
  };
}

/**
 * Il nome DHCP di una rete salvata.
 *
 * Le voci salvate prima che l'impostazione esistesse non hanno il campo: valgono
 * come "non inviarlo", che e' il default del progetto ed e' anche cio' che
 * setup.sh ha scritto sulle interfacce al momento dell'aggiornamento.
 */
export function hostnameOf(net: SavedNetwork): HostnameChoice {
  const mode = net.hostname_mode as HostnameMode;
  if (mode !== 'device' && mode !== 'custom') return HOSTNAME_OFF;
  return { mode, value: net.hostname_value ?? '' };
}

export async function listSaved(): Promise<SavedNetwork[]> {
  const response = await call<{ networks?: SavedRow[] }>('travel', 'networks');
  // Priorita' decrescente, e a parita' la piu' usata di recente per prima.
  return (response.networks ?? [])
    .map(normalize)
    .sort((a, b) => b.priority - a.priority || b.last_used - a.last_used);
}

/** Nome di sezione uci nuovo e stabile: niente indici che scalano. */
function newSectionName(): string {
  return `net_${Date.now().toString(36)}${Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, '0')}`;
}

/**
 * Il MAC con cui parte una banda che si sta abilitando adesso.
 *
 * Il modo si eredita - e' la scelta di chi ha configurato la rete, non un
 * dettaglio della radio - ma un indirizzo casuale si rigenera: due stazioni con
 * lo stesso MAC casuale agganciate allo stesso punto di accesso sono un
 * conflitto, ed e' esattamente cio' che succederebbe copiandolo. Un indirizzo
 * scritto a mano o clonato da un dispositivo si copia invece com'e': e' stato
 * scelto per farsi riconoscere da quella rete, e cambiarlo vanificherebbe la
 * ragione per cui e' li'.
 */
export function macForNewBand(source: MacChoice): MacChoice {
  if (source.mode === 'random') return { mode: 'random', value: randomMac() };
  return { ...source };
}

/** Lo stesso MAC su tutte e due le bande: il punto di partenza piu' comune. */
export function macOnBothBands(mac: MacChoice): MacByBand {
  return { '2.4': mac, '5': macForNewBand(mac) };
}

/**
 * I campi uci che descrivono bande e MAC.
 *
 * `mac_mode`/`mac_value` restano scritti accanto a quelli per banda: sono
 * quelli che legge un router non ancora aggiornato, e senza di loro la
 * riconnessione automatica userebbe li' un indirizzo vecchio. Ci finisce il
 * valore della prima banda attiva, che e' anche quella che quel router
 * proverebbe per prima.
 */
export function bandValues(bands: BandSet, mac: MacByBand): Record<string, string> {
  const values: Record<string, string> = { band: bandsToUci(bands) };

  for (const band of BANDS) {
    const choice = mac[band];
    values[`mac_mode_${SUFFIX[band]}`] = choice.mode;
    values[`mac_value_${SUFFIX[band]}`] = choice.mode === 'device' ? '' : choice.value;
  }

  const first = bandList(bands)[0] ?? '2.4';
  values.mac_mode = mac[first].mode;
  values.mac_value = mac[first].mode === 'device' ? '' : mac[first].value;

  return values;
}

/**
 * Il MAC che una banda usa davvero, letto dalla sezione invece che dall'elenco.
 *
 * `uci get` risponde con quello che c'e' in configurazione anche quando il
 * pacchetto sul router e' piu' vecchio dell'interfaccia e `travel.networks` non
 * riporta ancora i campi per banda. Fidarsi dell'elenco vorrebbe dire, in quel
 * caso, leggere il valore condiviso al posto di uno per banda che esiste ma non
 * viene mandato - e riscriverlo sopra a quello vero.
 */
async function readMacOnBand(section: string, band: Band): Promise<MacChoice> {
  const { values } = await call<{ values?: Record<string, unknown> }>('uci', 'get', {
    config: 'travel',
    section,
  });
  const raw = values ?? {};
  const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : undefined);

  // Nessun campo leggibile non vuol dire "non so": vuol dire che quella banda
  // sta usando il MAC della radio, che e' come si legge una sezione senza
  // `mac_mode` da tutte le altre parti. Restituire null qui farebbe saltare il
  // fissaggio, e la banda tornerebbe a seguire lo specchio.
  return (
    macFrom(text(`mac_mode_${SUFFIX[band]}`), text(`mac_value_${SUFFIX[band]}`)) ??
    macFrom(text('mac_mode'), text('mac_value')) ?? { mode: 'device', value: '' }
  );
}

/**
 * Cambia il MAC di una rete salvata sulla sola banda indicata.
 *
 * Serve a chi clona un indirizzo per passare un portale: la radio agganciata e'
 * una, e l'indirizzo va scritto per quella. `band` non si tocca - qui nessuno ha
 * chiesto di cambiare su quali radio vale la rete.
 *
 * Lo specchio condiviso prende l'indirizzo appena scelto, e non quello della
 * prima banda attiva come farebbe `bandValues`: e' il solo campo che legga un
 * router non ancora aggiornato, e lasciandolo com'era la prima riconnessione
 * automatica rimetterebbe il MAC di prima, cioe' esattamente il guasto per cui
 * questa scrittura esiste.
 *
 * Ma su una voce che ha solo quello - salvata prima che i MAC si separassero -
 * l'altra banda ci ripiega sopra: cambiarlo le cambierebbe l'indirizzo di
 * riflesso, e nessuno ha chiesto di toccarla. Per questo l'altra banda viene
 * prima fissata nel proprio campo sul valore che sta usando adesso: da li' in
 * poi non dipende piu' dallo specchio, e resta dov'era.
 */
export async function updateMacOnBand(
  section: string,
  band: string,
  mac: MacChoice,
): Promise<void> {
  const value = mac.mode === 'device' ? '' : mac.value;
  const values: Record<string, string> = {};

  // Banda sconosciuta - una WAN via cavo, o una radio che non la dichiara: si
  // scrive su tutte e due, com'era prima che i MAC si separassero.
  const targets: Band[] = band === '2.4' || band === '5' ? [band] : [...BANDS];
  for (const target of targets) {
    values[`mac_mode_${SUFFIX[target]}`] = mac.mode;
    values[`mac_value_${SUFFIX[target]}`] = value;
  }

  const other = BANDS.find((b) => !targets.includes(b));

  if (!other) {
    // Sono state scritte tutte e due di proposito: lo specchio non puo'
    // spostare niente che non sia gia' stato deciso qui.
    values.mac_mode = mac.mode;
    values.mac_value = value;
    await updateNetwork(section, values);
    return;
  }

  try {
    // Prima si fissa l'altra banda dove sta, poi si puo' muovere lo specchio.
    const current = await readMacOnBand(section, other);
    values[`mac_mode_${SUFFIX[other]}`] = current.mode;
    values[`mac_value_${SUFFIX[other]}`] = current.mode === 'device' ? '' : current.value;
    values.mac_mode = mac.mode;
    values.mac_value = value;
  } catch {
    // Non si e' potuto leggere: lo specchio resta com'e'. Muoverlo alla cieca
    // sposterebbe anche l'altra banda, se e' una voce che ci ripiega sopra -
    // cioe' cambierebbe una configurazione che nessuno ha chiesto di toccare.
    // Il prezzo e' che un router non ancora aggiornato non si accorge di
    // questo MAC: si perde una comodita' invece di guastare qualcosa d'altro.
  }

  await updateNetwork(section, values);
}

export interface SaveInput {
  ssid: string;
  password: string;
  encryption: string;
  bands: BandSet;
  hidden: boolean;
  mac: MacByBand;
  hostname: HostnameChoice;
  note: string;
}

/**
 * Salva una rete nuova e la applica subito.
 *
 * Non serve applica-e-conferma: `/etc/config/travel` non influenza la rete in
 * funzione, quindi salvarla non puo' chiudere fuori nessuno.
 */
export async function saveNetwork(input: SaveInput, existing: SavedNetwork[]): Promise<string> {
  const section = newSectionName();
  const top = existing.reduce((max, n) => Math.max(max, n.priority), 0);

  const values: Record<string, string> = {
    ssid: input.ssid,
    encryption: input.encryption,
    ...bandValues(input.bands, input.mac),
    // Si scrive sempre, anche a zero: una sezione senza il campo e' una nata
    // prima che esistesse, e va letta come "non nascosta". Scriverlo solo
    // quando e' vero renderebbe impossibile distinguere le due cose.
    hidden: input.hidden ? '1' : '0',
    // Il nome DHCP viaggia con la rete: e' un'impostazione per rete, non per
    // radio, e la riconnessione automatica lo rimette com'era.
    hostname_mode: input.hostname.mode,
    hostname_value: input.hostname.mode === 'custom' ? input.hostname.value.trim() : '',
    note: input.note,
    // La nuova arriva in cima: e' quella che stai usando adesso.
    priority: String(top + 10),
    disabled: '0',
  };
  if (input.password) values.key = input.password;

  await call('uci', 'add', { config: 'travel', type: 'network', name: section, values });
  await call('uci', 'apply', {});
  return section;
}

export async function updateNetwork(
  section: string,
  values: Record<string, string>,
): Promise<void> {
  await call('uci', 'set', { config: 'travel', section, values });
  await call('uci', 'apply', {});
}

export async function deleteNetwork(section: string): Promise<void> {
  await call('uci', 'delete', { config: 'travel', section });
  await call('uci', 'apply', {});
}

/**
 * Sposta una rete di un posto in su o in giu' nell'ordine di priorita'.
 *
 * Si scambiano i valori invece di rinumerare tutto: due scritture invece di N,
 * e nessun effetto sulle altre righe.
 */
export async function reorder(
  networks: SavedNetwork[],
  section: string,
  direction: -1 | 1,
): Promise<void> {
  const index = networks.findIndex((n) => n.section === section);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= networks.length) return;

  const a = networks[index];
  const b = networks[target];
  // Se le priorita' coincidono lo scambio non sposterebbe niente.
  const priorityA = a.priority === b.priority ? b.priority + (direction < 0 ? 1 : -1) : b.priority;

  await call('uci', 'set', {
    config: 'travel',
    section: a.section,
    values: { priority: String(priorityA) },
  });
  await call('uci', 'set', {
    config: 'travel',
    section: b.section,
    values: { priority: String(a.priority) },
  });
  await call('uci', 'apply', {});
}

/**
 * Prepara la connessione a una rete salvata: la fa il router, perche' la
 * password non deve passare dal browser. Le modifiche restano in sospeso
 * finche' non le applica `useApply`.
 */
export async function stageConnectSaved(section: string, radio: string): Promise<void> {
  const response = await call<{ staged?: boolean; error?: string }>(
    'travel',
    'stage_connect_saved',
    { section, radio },
  );
  if (response.error) throw backendError(response);
}

export function markUsed(section: string, result: string): Promise<unknown> {
  return call('travel', 'mark_used', { section, result });
}

/**
 * I dati di una rete salvata, letti al momento e per quella sola rete.
 *
 * E' l'unica lettura del pannello che fa uscire un segreto dal router, e sta
 * qui da sola apposta. La regola del progetto - le risposte applicative
 * ordinarie non contengono chiavi - resta intatta: `travel.networks` continua
 * a dire soltanto `has_key`, e nessun elenco porta con se' delle password.
 * Si chiede una rete alla volta quando qualcuno apre "Condividi". I dati
 * restano nello stato della schermata fino alla chiusura, senza persistenza.
 *
 * Non allarga i permessi di nessuno: gli ACL concedono gia' la lettura UCI di
 * `travel` a chi ha una sessione, quindi chi puo' aprire questa schermata puo'
 * gia' leggere la stessa chiave da se'. E' la posizione dichiarata
 * nell'architettura - il pannello e' uno strumento di amministrazione, non un
 * confine di isolamento verso un amministratore autenticato.
 *
 * Una sola lettura della sezione aggiorna insieme SSID, cifratura e chiave.
 * Una rete aperta puo' omettere key; una sezione mancante resta un errore.
 */
export async function readShareNetwork(section: string): Promise<ShareInput & { bands: BandSet }> {
  const { values } = await call<{ values?: Record<string, unknown> }>('uci', 'get', {
    config: 'travel',
    section,
  });
  if (values?.['.type'] !== 'network' || typeof values.ssid !== 'string' ||
      typeof values.encryption !== 'string' ||
      (values.key !== undefined && typeof values.key !== 'string')) {
    throw new Error(networksText().unreadableSaved);
  }
  return {
    ssid: values.ssid,
    encryption: values.encryption,
    key: values.encryption === 'none' ? '' : values.key ?? '',
    hidden: values.hidden === '1',
    bands: bandsFromUci(typeof values.band === 'string' ? values.band : ''),
  };
}

/**
 * Dati per salvare la rete che si sta per usare, presi dal risultato di
 * scansione.
 *
 * Le bande arrivano da fuori perche' sono una scelta: quella su cui la rete e'
 * stata vista e' obbligatoria - da li' si sa che c'e' e che la password e'
 * quella - ma l'altra si puo' aggiungere subito, se si sa gia' che la stessa
 * rete c'e' anche li'.
 */
export function fromScan(
  net: ScanResult,
  password: string,
  bands: BandSet,
  mac: MacByBand,
  encryption: string,
  hostname: HostnameChoice,
): SaveInput {
  return {
    ssid: net.ssid,
    password,
    encryption,
    bands,
    // Una rete che si e' vista scansionando annuncia il proprio nome: per
    // definizione non e' nascosta.
    hidden: false,
    mac,
    hostname,
    note: '',
  };
}

/** Le bande di partenza salvando da una scansione: solo quella che l'ha vista. */
export function bandsFromScan(band: Band): BandSet {
  return { '2.4': band === '2.4', '5': band === '5' };
}

/**
 * La rete salvata che copre questo SSID su questa banda, se c'e'.
 *
 * E' la domanda che si fa prima di salvare - esiste gia' qualcosa che copre
 * questo caso? - e prima di abilitare una banda nuova, dove diventa il
 * controllo dei conflitti: su una radio ci sta una stazione sola, quindi due
 * configurazioni con lo stesso nome sulla stessa banda sono una copia che non
 * verrebbe mai provata.
 *
 * Una banda che non e' ne' 2.4 ne' 5 - la WAN via cavo, o una radio che non
 * dichiara la propria - non restringe niente: si guarda il solo nome.
 */
export function findSavedOn(
  saved: SavedNetwork[],
  ssid: string,
  band: string,
): SavedNetwork | undefined {
  const known = band === '2.4' || band === '5';
  return saved.find((n) => n.ssid === ssid && (!known || n.bands[band as Band]));
}

/** Qualsiasi rete salvata con questo nome, su qualunque banda. */
export function findSaved(saved: SavedNetwork[], ssid: string): SavedNetwork | undefined {
  return saved.find((n) => n.ssid === ssid);
}

export interface BandConflict {
  band: Band;
  net: SavedNetwork;
}

/**
 * Le reti gia' salvate che occuperebbero le stesse bande con lo stesso nome.
 *
 * Si chiede prima di abilitare una banda, e la risposta non e' un dettaglio
 * estetico: la radio ospita una stazione sola, quindi due voci con lo stesso
 * SSID sulla stessa banda sono un doppione, e la seconda non verrebbe mai
 * usata. Chi chiama lo dice e si ferma, invece di scrivere la copia o di
 * modificare da solo la voce che c'era gia'.
 */
export function bandConflicts(
  saved: SavedNetwork[],
  ssid: string,
  bands: BandSet,
  exclude = '',
): BandConflict[] {
  const conflicts: BandConflict[] = [];

  for (const band of bandList(bands)) {
    const other = saved.find((n) => n.section !== exclude && n.ssid === ssid && n.bands[band]);
    if (other) conflicts.push({ band, net: other });
  }

  return conflicts;
}

/**
 * L'uplink acceso su questa rete salvata, se c'e'.
 *
 * Serve a dire "collegata" accanto alla voce giusta. Il confronto tiene conto
 * della banda perche' due configurazioni diverse possono avere lo stesso nome
 * su radio diverse: si guarda che la banda dell'uplink sia fra quelle per cui
 * questa voce e' abilitata.
 *
 * Uno stato "disabled" e' della configurazione, non dell'aggancio: la STA e'
 * spenta e non sta portando niente, quindi non conta come collegamento.
 */
export function connectedVia(uplinks: Uplink[], net: SavedNetwork): Uplink | undefined {
  return uplinks.find(
    (u) =>
      u.kind === 'wifi' &&
      Boolean(u.ssid) &&
      u.ssid === net.ssid &&
      (u.band === '2.4' || u.band === '5' ? net.bands[u.band as Band] : true) &&
      uplinkState(u) !== 'disabled',
  );
}

/**
 * Filtro per la ricerca nell'elenco delle reti salvate.
 *
 * Confronta senza distinzione fra maiuscole e minuscole e cerca anche nella
 * nota: chi ha scritto "hotel di Berlino" su una rete che si chiama
 * "WLAN-4F2A" la ritrova per come se la ricorda, non per come si chiama.
 */
export function matchesQuery(net: SavedNetwork, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return (
    net.ssid.toLowerCase().includes(needle) || net.note.toLowerCase().includes(needle)
  );
}
