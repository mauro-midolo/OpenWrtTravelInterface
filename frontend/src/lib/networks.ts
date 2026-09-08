/**
 * Reti salvate (requisito E.2).
 *
 * Vivono in `/etc/config/travel` come sezioni `network`. La lettura passa da
 * `travel.networks`, che non fa uscire le chiavi. La scrittura passa
 * dall'oggetto `uci`, come tutto il resto.
 *
 * Unica eccezione: collegarsi a una rete gia' salvata. La password non puo'
 * passare dal browser, quindi e' il router a copiarla nelle modifiche in
 * sospeso della sessione (`travel.stage_connect_saved`).
 */

import { call } from './ubus';
import { HOSTNAME_OFF } from './hostname';
import type { HostnameChoice, HostnameMode } from './hostname';
import { uplinkState } from './wifi';
import type { MacMode, ScanResult, Uplink } from './wifi';

export interface SavedNetwork {
  /** Nome della sezione uci, es. "net_lx3f9a". */
  section: string;
  ssid: string;
  encryption: string;
  /** Banda preferita, vuota se indifferente. */
  band: string;
  /**
   * La rete non annuncia il proprio SSID.
   *
   * Si legge e basta: nessuna schermata la scrive, perche' una rete nascosta
   * non compare nella scansione e il pannello non ha da dove salvarla. Chi ne
   * ha aggiunta una a mano deve pero' riconoscerla nell'elenco, perche' e'
   * l'unica voce che non si puo' ritrovare confrontandola con le reti viste.
   */
  hidden: boolean;
  mac_mode: string;
  mac_value: string;
  /** Nome da mandare nel DHCP su questa rete: none | device | custom. */
  hostname_mode: string;
  hostname_value: string;
  note: string;
  /** Piu' alta = preferita. */
  priority: number;
  disabled: boolean;
  /** Epoch secondi, 0 se mai usata. */
  last_used: number;
  last_result: string;
  has_key: boolean;
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
  const response = await call<{ networks?: SavedNetwork[] }>('travel', 'networks');
  // Priorita' decrescente, e a parita' la piu' usata di recente per prima.
  return (response.networks ?? []).sort(
    (a, b) => b.priority - a.priority || b.last_used - a.last_used,
  );
}

/** Nome di sezione uci nuovo e stabile: niente indici che scalano. */
function newSectionName(): string {
  return `net_${Date.now().toString(36)}${Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, '0')}`;
}

export interface SaveInput {
  ssid: string;
  password: string;
  encryption: string;
  band: string;
  macMode: MacMode;
  macValue: string;
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
    band: input.band,
    mac_mode: input.macMode,
    mac_value: input.macMode === 'device' ? '' : input.macValue,
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
  if (response.error) throw new Error(response.error);
}

export function markUsed(section: string, result: string): Promise<unknown> {
  return call('travel', 'mark_used', { section, result });
}

/** Dati per salvare la rete che si sta per usare, presi dal risultato di scansione. */
export function fromScan(
  net: ScanResult,
  password: string,
  macMode: MacMode,
  macValue: string,
  encryption: string,
  hostname: HostnameChoice,
): SaveInput {
  return {
    ssid: net.ssid,
    password,
    encryption,
    band: net.band,
    macMode,
    macValue,
    hostname,
    note: '',
  };
}

/**
 * La rete salvata che copre questo SSID su questa banda, se c'e'.
 *
 * La banda fa parte dell'identita', non e' un dettaglio descrittivo: la stessa
 * rete di casa a 2.4 e a 5 GHz sono due uplink diversi, con segnale, portata e
 * velocita' diversi, e vanno salvati separatamente. Guardando il solo SSID il
 * salvataggio della seconda banda veniva soppresso come duplicato, e la radio
 * rimasta senza voce non aveva nessuna candidata per la riconnessione
 * automatica: ci si ritrovava sempre sulla prima banda salvata.
 *
 * Una voce senza banda vale per entrambe le radio, ed e' cosi' che la tratta
 * anche travelD: qui conta come gia' presente, altrimenti si proporrebbe di
 * salvare un doppione di qualcosa che gia' copre questo caso.
 */
export function findSaved(
  saved: SavedNetwork[],
  ssid: string,
  band: string,
): SavedNetwork | undefined {
  return saved.find((n) => n.ssid === ssid && (n.band === band || n.band === ''));
}

/** Etichetta di un gruppo di reti salvate. */
export function bandLabel(band: string): string {
  if (band === '') return 'Qualsiasi banda';
  return `${band} GHz`;
}

export interface BandGroup {
  band: string;
  networks: SavedNetwork[];
}

/**
 * Divide le reti salvate in una lista per banda.
 *
 * Le due bande note ci sono sempre, anche vuote: sono la spiegazione del
 * modello, e una lista assente farebbe pensare che la banda non conti.
 *
 * Le bande che non conosciamo non vengono scartate ma finiscono in un gruppo
 * loro. Una voce che sparisce dall'elenco continuerebbe a essere usata dalla
 * riconnessione automatica senza comparire da nessuna parte, che e' il modo
 * peggiore di sbagliare.
 */
export function groupByBand(saved: SavedNetwork[]): BandGroup[] {
  const known = ['2.4', '5'];
  const others = [...new Set(saved.map((n) => n.band))]
    .filter((band) => !known.includes(band))
    .sort();

  return [...known, ...others].map((band) => ({
    band,
    networks: saved.filter((n) => n.band === band),
  }));
}

/**
 * Le reti che condividono la banda di questa, nell'ordine mostrato.
 *
 * E' l'insieme dentro cui ha senso spostarla su e giu': la priorita' resta un
 * numero unico per tutte, ma il confronto avviene solo fra pari banda, e
 * scambiare due valori non tocca nessun altro. Le liste restano quindi
 * ordinabili in modo indipendente senza aggiungere niente alla
 * configurazione.
 */
export function bandSiblings(saved: SavedNetwork[], net: SavedNetwork): SavedNetwork[] {
  return saved.filter((n) => n.band === net.band);
}

/**
 * L'uplink acceso su questa rete salvata, se c'e'.
 *
 * Serve a dire "collegata" accanto alla voce giusta, e per quello il confronto
 * deve tenere conto della banda: la stessa rete a 2.4 e a 5 GHz sono due voci
 * distinte, e marcarle tutte e due perche' condividono il nome direbbe una cosa
 * falsa su quella su cui la radio non e' agganciata. Una voce senza banda vale
 * per entrambe le radio, quindi si accontenta di qualsiasi uplink.
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
      (net.band === '' || u.band === net.band) &&
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
