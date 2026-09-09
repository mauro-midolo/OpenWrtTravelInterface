import { call } from './ubus';

/**
 * Interruttore fisico del router: quale funzione gli e' associata.
 *
 * Il registro sta qui e in `/usr/share/travel/toggle.sh`: la' cosa fa l'azione,
 * qui come si chiama in italiano. Aggiungerne una vuole una riga in questo
 * elenco e una funzione `toggle_do_<id>` sul router - il rilevamento della
 * levetta non si tocca.
 */
export const TOGGLE_ACTIONS = [
  { id: 'none', label: 'Non fare nulla' },
  { id: 'led', label: 'Controllo LED di stato' },
] as const;

/** Le azioni scritte nel registro: quelle che esistono su ogni router. */
export type FixedAction = (typeof TOGGLE_ACTIONS)[number]['id'];

/**
 * Le azioni che nominano qualcosa creato da chi usa il router.
 *
 * Le configurazioni WireGuard sono tante e ne puo' portare il traffico una
 * sola: "attiva WireGuard" non vorrebbe dire niente, e la voce e' quindi
 * "attiva *questa*". Dopo i due punti c'e' la sezione uci, che e' gia'
 * l'identificatore con cui il resto dell'interfaccia chiama quel profilo.
 */
export type WgAction = `wg:${string}`;

export type ToggleAction = FixedAction | WgAction;

/** Dove sta la levetta: `unknown` finche' il router non la vede muoversi. */
export type TogglePosition = 'on' | 'off' | 'unknown';

const WG = 'wg:';

export interface ToggleConfig {
  /** Azione associata adesso. */
  action: ToggleAction;
  /** Quelle che il router accetta davvero: e' lui a tenere il registro. */
  actions: ToggleAction[];
  /** Dove sta la levetta, per quanto ne sa il router: `unknown` finche' non si muove. */
  position: TogglePosition;
  /**
   * Il nome di ogni configurazione WireGuard associabile, per id di azione.
   *
   * Non sta nell'elenco compilato qui sopra perche' non e' una traduzione: e' il
   * nome che una persona ha dato al suo tunnel, e lo sa solo il router.
   */
  names: Record<string, string>;
}

const fixed: readonly string[] = TOGGLE_ACTIONS.map((action) => action.id);
const isAction = (value: unknown): value is ToggleAction =>
  typeof value === 'string' && (fixed.includes(value) || value.startsWith(WG));

/** L'azione nomina una configurazione WireGuard. */
export const isWgAction = (action: ToggleAction | null): action is WgAction =>
  typeof action === 'string' && action.startsWith(WG);

/**
 * Se il LED lo comanda la levetta, chi lo mostra non lo comanda piu'.
 *
 * Sta qui accanto al registro e non nella schermata: se un domani un'altra
 * azione muovesse il LED, e' questa riga a saperlo, non chi disegna le righe.
 */
export const controlsLed = (action: ToggleAction | null): boolean => action === 'led';

/**
 * La configurazione WireGuard comandata dalla levetta, o stringa vuota.
 *
 * Stessa idea di `controlsLed`, e per la stessa ragione: chi decide se i
 * pulsanti di accensione della scheda WireGuard sono ancora premibili non deve
 * conoscere il formato degli id.
 */
export const controlsWg = (action: ToggleAction | null): string =>
  isWgAction(action) ? action.slice(WG.length) : '';

/**
 * Come si chiama un'azione in elenco.
 *
 * Le fisse hanno l'etichetta qui sopra; una configurazione WireGuard porta il
 * nome che le ha dato chi l'ha salvata, e se il router non lo manda - un
 * pacchetto piu' vecchio di questa interfaccia - resta la sezione, che e'
 * brutta ma vera. Mostrare una riga vuota sarebbe peggio.
 */
export function toggleLabel(action: ToggleAction, names: Record<string, string>): string {
  const known = TOGGLE_ACTIONS.find((entry) => entry.id === action);
  if (known) return known.label;
  return `WireGuard – ${names[action] || action.slice(WG.length)}`;
}

/**
 * Come si dice dove sta la levetta adesso.
 *
 * ON e OFF invece di "alto" e "basso": il verso della levetta cambia da un
 * router all'altro, mentre le due posizioni sono sempre quella che fa la cosa
 * e quella che la disfa - ed e' quella la coppia che serve leggere accanto
 * alla funzione scelta.
 *
 * Finche' il router non la vede muoversi non sa dove sia: la posizione la
 * riporta il primo movimento dopo l'accensione, e fino ad allora dirlo e'
 * meglio che inventare un OFF - una levetta gia' in basso all'accensione non
 * si distingue da una che nessuno ha ancora toccato.
 */
export function positionLabel(position: TogglePosition): string {
  if (position === 'on') return 'ON';
  if (position === 'off') return 'OFF';
  return 'posizione ignota';
}

/**
 * Forma canonica al confine: un router non ancora aggiornato risponde senza
 * `actions`, senza `names` o senza `position`, e un'azione che questa UI non
 * conosce non va mostrata come una voce vuota. Chi legge riceve sempre i
 * quattro campi pieni.
 */
export function normalizeToggle(raw: Partial<ToggleConfig> | undefined): ToggleConfig {
  const action = isAction(raw?.action) ? raw.action : 'none';
  const offered = Array.isArray(raw?.actions) ? raw.actions.filter(isAction) : [];
  // Senza elenco si mostra tutto quello che si sa fare: il router e' vecchio,
  // non povero. Solo le fisse, pero' - le configurazioni WireGuard non si
  // possono indovinare. L'azione in corso resta comunque selezionabile,
  // altrimenti la lista si aprirebbe su una riga vuota.
  const actions = offered.length > 0 ? offered : [...(fixed as ToggleAction[])];
  if (!actions.includes(action)) actions.unshift(action);
  const position = raw?.position === 'on' || raw?.position === 'off' ? raw.position : 'unknown';
  const names: Record<string, string> = {};
  if (raw?.names && typeof raw.names === 'object') {
    for (const [id, name] of Object.entries(raw.names)) {
      if (typeof name === 'string' && name !== '') names[id] = name;
    }
  }
  return { action, actions, position, names };
}

async function request(method: string, args: Record<string, unknown> = {}): Promise<ToggleConfig> {
  const result = await call<Partial<ToggleConfig> & { error?: string }>(
    'travel',
    method,
    args,
    // Associare una configurazione WireGuard alla levetta la accende subito, e
    // alzare un tunnel vuole il suo tempo: netifd risponde prima che
    // l'interfaccia esista, e il router aspetta che compaia prima di
    // instradarla. Lo stesso respiro che ha gia' `wg_toggle`, con il margine
    // dello scambio - una configurazione da spegnere e una da accendere.
    60_000,
  );
  if (result.error) throw new Error(result.error);
  return normalizeToggle(result);
}

export function getToggle(): Promise<ToggleConfig> {
  return request('toggle_get');
}

/** Salva la scelta sul router: resta anche dopo il riavvio. */
export function setToggle(action: ToggleAction): Promise<ToggleConfig> {
  return request('toggle_set', { action });
}
