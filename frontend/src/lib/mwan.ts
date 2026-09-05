/**
 * Multi-WAN (requisiti A e B), sopra mwan3.
 *
 * Due meta' che vanno tenute distinte: la configurazione dice cosa VORREMMO
 * (modalita', priorita', pesi, tracking IP), lo stato dice cosa STA SUCCEDENDO
 * (online, offline, ping persi). `travel.mwan` le compone sul router.
 */

import { call } from './ubus';
import type { VpnPolicy } from './vpn';

export type MwanMode = 'failover' | 'balance' | 'off';

/** Stati che mwan3 riporta per un'interfaccia, piu' i nostri due. */
export type MwanStatus = 'online' | 'offline' | 'disabled' | 'notracking' | 'unknown';

export interface TrackResult {
  ip: string;
  status: string;
  latency: number;
  packetloss: number;
}

export interface MwanInterface {
  network: string;
  /** Nome fisico della porta: identita' stabile, non cambia col ruolo. */
  device: string;
  enabled: boolean;
  /** Metrica del membro di failover: piu' bassa = preferita. */
  priority: number;
  /** Peso nel bilanciamento. */
  weight: number;
  interval: number;
  timeout: number;
  count: number;
  up: number;
  down: number;
  reliability: number;
  track_ip: string[];
  status: MwanStatus | string;
  /** Secondi da quando e' online. */
  online: number;
  uptime: number;
  score: number;
  lost: number;
  tracking: TrackResult[];
}

export interface MwanRule {
  section: string;
  src_ip: string;
  dest_ip: string;
  dest_port: string;
  proto: string;
  /** `o_<wan>` blocca se la WAN cade, `p_<wan>` ripiega sulle altre. */
  use_policy: string;
  sticky: boolean;
  timeout: number;
}

export interface Mwan {
  installed: boolean;
  running: boolean;
  mode: MwanMode;
  /** Sticky della regola generale: si applica al traffico senza una regola sua. */
  default_sticky: boolean;
  default_timeout: number;
  interfaces: MwanInterface[];
  rules: MwanRule[];
  /**
   * Chi sta decidendo dove esce il traffico (Fase 6b).
   *
   * Serve qui perche' il bilanciamento e' una delle tre cose che si escludono
   * a vicenda: con un exit node Tailscale o un tunnel WireGuard acceso non e'
   * selezionabile, e la schermata deve poterlo dire invece di lasciar salvare
   * qualcosa che il router poi rifiuta. Il tipo vive in `lib/vpn.ts`, dove sta
   * anche la spiegazione: la regola e' una sola, e ha un posto solo.
   */
  policy?: VpnPolicy;
}

export function getMwan(): Promise<Mwan> {
  return call<Mwan>('travel', 'mwan');
}

export const MODE_LABEL: Record<MwanMode, string> = {
  failover: 'Failover',
  balance: 'Bilanciamento',
  off: 'Nessuna politica',
};

export function statusLabel(status: string): string {
  switch (status) {
    case 'online':
      return 'online';
    case 'offline':
      return 'offline';
    case 'disabled':
      return 'esclusa';
    case 'notracking':
      return 'senza controllo';
    default:
      return 'stato ignoto';
  }
}

/** Le WAN che mwan3 sta usando davvero, in ordine di priorita'. */
export function activeInterfaces(mwan: Mwan): MwanInterface[] {
  return mwan.interfaces
    .filter((i) => i.enabled && i.status === 'online')
    .sort((a, b) => a.priority - b.priority);
}

/** Tutte, in ordine di priorita': e' l'ordine in cui vanno mostrate. */
export function byPriority(mwan: Mwan): MwanInterface[] {
  return [...mwan.interfaces].sort((a, b) => a.priority - b.priority);
}

// --- Scrittura ----------------------------------------------------------------
//
// Nessun applica-e-conferma: queste modifiche cambiano il routing dei client,
// non l'accesso al router, che resta raggiungibile al suo indirizzo comunque
// vada. Il rischio e' restare senza Internet, non restare chiusi fuori.

/**
 * Fa prendere effetto alle modifiche.
 *
 * `uci apply` non basta: mwan3 rilegge la configurazione solo al riavvio del
 * servizio, e le metriche delle rotte le riapplica netifd.
 */
export async function applyMwan(): Promise<void> {
  await call('uci', 'apply', {});
  const result = await call<{ applied?: boolean; error?: string }>('travel', 'mwan_apply', {});
  if (result.error) throw new Error(result.error);
}

/**
 * Modalita' e sticky della regola generale, in un solo punto.
 *
 * `travel_default` e' la regola che raccoglie tutto il traffico che non
 * combacia con nessuna regola specifica: la modalita' (via `use_policy`) e lo
 * sticky sono due opzioni della STESSA sezione, quindi si scrivono insieme.
 * Scriverli separatamente rischierebbe di far scrivere l'uno sopra un valore
 * dell'altro appena letto, o di lasciare lo sticky settato mentre si cambia
 * politica senza che nessuno l'abbia deciso di nuovo.
 *
 * Le due politiche (`travel_failover`, `travel_balance`) esistono sempre
 * entrambe, con i loro membri gia' pronti: mwan3 bilancia solo fra membri di
 * pari metrica e fa failover solo fra metriche diverse, quindi servono due
 * insiemi. Cambiare modalita' e' scegliere quale usare, non una riscrittura.
 */
export async function setDefaultRule(
  mode: MwanMode,
  sticky: boolean,
  timeout: number,
): Promise<void> {
  await call('uci', 'set', {
    config: 'mwan3',
    section: 'travel_default',
    values: {
      use_policy: mode === 'balance' ? 'travel_balance' : 'travel_failover',
      sticky: sticky ? '1' : '0',
      // mwan3 ignora `timeout` quando sticky e' spento, ma lasciarlo scritto
      // fa ritrovare il valore precedente se lo sticky viene riacceso.
      timeout: String(timeout),
    },
  });
}

/**
 * Riscrive l'ordine di priorita'.
 *
 * Le metriche vengono riassegnate a scaglioni di dieci nell'ordine dato, sia
 * sul membro di failover sia sull'interfaccia di rete: la prima governa il
 * traffico dei client via mwan3, la seconda quello che il router genera per
 * conto proprio. Tenerle disallineate vorrebbe dire che il router preferisce
 * una WAN diversa da quella dei suoi client.
 */
export async function setPriorityOrder(order: string[]): Promise<void> {
  for (let i = 0; i < order.length; i++) {
    const metric = String((i + 1) * 10);
    await call('uci', 'set', {
      config: 'mwan3',
      section: `${order[i]}_f`,
      values: { metric },
    });
    await call('uci', 'set', {
      config: 'network',
      section: order[i],
      values: { metric },
    });
  }
}

export async function setWeight(network: string, weight: number): Promise<void> {
  await call('uci', 'set', {
    config: 'mwan3',
    section: `${network}_b`,
    values: { weight: String(weight) },
  });
}

/** Esclude o riammette una WAN nel multi-WAN, senza spegnere l'interfaccia. */
export async function setEnabled(network: string, enabled: boolean): Promise<void> {
  await call('uci', 'set', {
    config: 'mwan3',
    section: network,
    values: { enabled: enabled ? '1' : '0' },
  });
}

// --- Regole di instradamento (requisito B) -----------------------------------

export interface RuleInput {
  /** Vuoto = qualsiasi sorgente. */
  src_ip: string;
  /** Vuoto = qualsiasi destinazione. */
  dest_ip: string;
  /** Vuoto = tutte le porte. Accetta "443" o "5000-5100". */
  dest_port: string;
  proto: string;
  /** Interfaccia logica della WAN a cui inchiodare il traffico. */
  network: string;
  /** Vero: se quella WAN e' giu' il traffico si ferma invece di deviare. */
  strict: boolean;
  sticky: boolean;
  /** Secondi per cui la stessa sorgente resta sulla stessa WAN. */
  timeout: number;
}

/**
 * Nome della politica dedicata a una WAN.
 *
 * I prefissi sono corti per forza: mwan3 rifiuta i nomi di politica oltre i 15
 * caratteri, che e' il limite dei nomi di catena di iptables, e lo fa
 * scrivendolo nel log e basta - la politica non viene applicata e le regole che
 * la usano smettono di funzionare senza che l'interfaccia se ne accorga. Con
 * `o_`/`p_` restano 13 caratteri per il nome della WAN.
 */
export function policyFor(network: string, strict: boolean): string {
  return `${strict ? 'o' : 'p'}_${network}`;
}

/**
 * Da quale politica si risale alla WAN e al comportamento in caso di caduta.
 *
 * Riconosce anche i prefissi lunghi di prima: una configurazione non ancora
 * migrata deve continuare a leggersi, altrimenti le regole gia' scritte
 * sparirebbero dall'elenco invece di mostrarsi.
 */
export function parsePolicy(policy: string): { network: string; strict: boolean } | null {
  if (policy.startsWith('o_')) return { network: policy.slice(2), strict: true };
  if (policy.startsWith('p_')) return { network: policy.slice(2), strict: false };
  if (policy.startsWith('only_')) return { network: policy.slice(5), strict: true };
  if (policy.startsWith('pref_')) return { network: policy.slice(5), strict: false };
  return null;
}

function ruleValues(input: RuleInput): Record<string, string> {
  const values: Record<string, string> = {
    use_policy: policyFor(input.network, input.strict),
    family: 'ipv4',
    proto: input.proto,
    sticky: input.sticky ? '1' : '0',
  };
  // I criteri vuoti non si scrivono affatto: `dest_ip` a stringa vuota non
  // significa "qualsiasi" per mwan3, significa un valore da confrontare.
  if (input.src_ip) values.src_ip = input.src_ip;
  if (input.dest_ip) values.dest_ip = input.dest_ip;
  if (input.dest_port) values.dest_port = input.dest_port;
  if (input.sticky) values.timeout = String(input.timeout);
  return values;
}

function newRuleName(): string {
  return `rule_${Date.now().toString(36)}`;
}

/**
 * La regola predefinita va ricreata dopo ogni modifica alle altre.
 *
 * mwan3 valuta le regole nell'ordine in cui compaiono nel file e si ferma alla
 * prima che combacia. La predefinita prende tutto: se restasse davanti a una
 * regola nuova, quella regola non verrebbe mai raggiunta - e fallirebbe in
 * silenzio, che e' il modo peggiore. Cancellarla e riaggiungerla la rimette in
 * fondo, senza dipendere da un riordino esplicito.
 *
 * Prende `defaults` (mode + sticky + timeout) invece di rileggerli dal router:
 * si passa lo stato che l'interfaccia ha gia' in mano, cosi' aggiungere una
 * regola specifica non azzera in silenzio lo sticky della regola generale.
 */
async function moveDefaultRuleLast(defaults: {
  mode: MwanMode;
  sticky: boolean;
  timeout: number;
}): Promise<void> {
  try {
    await call('uci', 'delete', { config: 'mwan3', section: 'travel_default' });
  } catch {
    // Non c'era: la si crea comunque qui sotto.
  }
  await call('uci', 'add', {
    config: 'mwan3',
    type: 'rule',
    name: 'travel_default',
    values: {
      dest_ip: '0.0.0.0/0',
      family: 'ipv4',
      use_policy: defaults.mode === 'balance' ? 'travel_balance' : 'travel_failover',
      sticky: defaults.sticky ? '1' : '0',
      timeout: String(defaults.timeout),
    },
  });
}

export async function addRule(
  input: RuleInput,
  defaults: { mode: MwanMode; sticky: boolean; timeout: number },
): Promise<void> {
  await call('uci', 'add', {
    config: 'mwan3',
    type: 'rule',
    name: newRuleName(),
    values: ruleValues(input),
  });
  await moveDefaultRuleLast(defaults);
}

export async function updateRule(
  section: string,
  input: RuleInput,
  defaults: { mode: MwanMode; sticky: boolean; timeout: number },
): Promise<void> {
  // Ricreata da zero: aggiornandola resterebbero i criteri di prima, e una
  // regola con un filtro fantasma e' peggio di una regola sbagliata.
  await call('uci', 'delete', { config: 'mwan3', section });
  await call('uci', 'add', {
    config: 'mwan3',
    type: 'rule',
    name: section,
    values: ruleValues(input),
  });
  await moveDefaultRuleLast(defaults);
}

export async function deleteRule(section: string): Promise<void> {
  await call('uci', 'delete', { config: 'mwan3', section });
}

export interface HealthSettings {
  track_ip: string[];
  interval: number;
  timeout: number;
  count: number;
  up: number;
  down: number;
  reliability: number;
}

/**
 * Controllo di salute di una WAN (requisito B).
 *
 * `reliability` e' quanti tracking IP devono rispondere perche' la WAN conti
 * come su: non puo' superare il numero di indirizzi configurati, altrimenti
 * mwan3 la considera sempre giu'.
 */
export async function setHealth(network: string, settings: HealthSettings): Promise<void> {
  const reliability = Math.min(
    Math.max(1, settings.reliability),
    Math.max(1, settings.track_ip.length),
  );

  await call('uci', 'set', {
    config: 'mwan3',
    section: network,
    values: {
      track_ip: settings.track_ip,
      interval: String(settings.interval),
      timeout: String(settings.timeout),
      count: String(settings.count),
      up: String(settings.up),
      down: String(settings.down),
      reliability: String(reliability),
    },
  });
}
