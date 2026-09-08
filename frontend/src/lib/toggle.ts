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

export type ToggleAction = (typeof TOGGLE_ACTIONS)[number]['id'];

export interface ToggleConfig {
  /** Azione associata adesso. */
  action: ToggleAction;
  /** Quelle che il router accetta davvero: e' lui a tenere il registro. */
  actions: ToggleAction[];
  /** Dove sta la levetta, per quanto ne sa il router: `unknown` finche' non si muove. */
  position: 'on' | 'off' | 'unknown';
}

const ids: readonly string[] = TOGGLE_ACTIONS.map((action) => action.id);
const isAction = (value: unknown): value is ToggleAction =>
  typeof value === 'string' && ids.includes(value);

/**
 * Forma canonica al confine: un router non ancora aggiornato risponde senza
 * `actions` o senza `position`, e un'azione che questa UI non conosce non va
 * mostrata come una voce vuota. Chi legge riceve sempre i tre campi pieni.
 */
export function normalizeToggle(raw: Partial<ToggleConfig> | undefined): ToggleConfig {
  const action = isAction(raw?.action) ? raw.action : 'none';
  const offered = Array.isArray(raw?.actions) ? raw.actions.filter(isAction) : [];
  // Senza elenco si mostra tutto quello che si sa fare: il router e' vecchio,
  // non povero. L'azione in corso resta comunque selezionabile, altrimenti la
  // lista si aprirebbe su una riga vuota.
  const actions = offered.length > 0 ? offered : [...ids as ToggleAction[]];
  if (!actions.includes(action)) actions.unshift(action);
  const position = raw?.position === 'on' || raw?.position === 'off' ? raw.position : 'unknown';
  return { action, actions, position };
}

async function request(method: string, args: Record<string, unknown> = {}): Promise<ToggleConfig> {
  const result = await call<Partial<ToggleConfig> & { error?: string }>('travel', method, args);
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
