/**
 * Multi-WAN (requisiti A e B), sopra mwan3.
 *
 * Due meta' che vanno tenute distinte: la configurazione dice cosa VORREMMO
 * (modalita', priorita', pesi, tracking IP), lo stato dice cosa STA SUCCEDENDO
 * (online, offline, ping persi). `travel.mwan` le compone sul router.
 */

import { mwanText } from '../i18n/mwan';
import { call } from './ubus';
import { parseCidr } from './ip';
import type { IpFamily } from './ip';
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

/** Il nome della modalita', nella lingua dell'interfaccia. */
export function modeLabel(mode: MwanMode): string {
  return mwanText().mode[mode];
}

export function statusLabel(status: string): string {
  const labels = mwanText().status;
  switch (status) {
    case 'online':
    case 'offline':
    case 'disabled':
    case 'notracking':
      return labels[status];
    default:
      return labels.unknown;
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
  const values = {
    sticky: sticky ? '1' : '0',
    // mwan3 ignora `timeout` quando sticky e' spento, ma lasciarlo scritto
    // fa ritrovare il valore precedente se lo sticky viene riacceso.
    timeout: String(timeout),
  };

  await call('uci', 'set', {
    config: 'mwan3',
    section: 'travel_default',
    values: { ...values, use_policy: globalPolicy(mode, 4) },
  });
  // La predefinita IPv6 segue la stessa modalita': lasciarla su una politica
  // diversa manderebbe le due famiglie su WAN diverse, ed e' proprio la cosa
  // che chi cambia modalita' non si aspetta.
  await setIfPresent('mwan3', 'travel_default6', {
    ...values,
    use_policy: globalPolicy(mode, 6),
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
    // Le quattro scritture di una WAN stanno adiacenti, e non in quattro cicli
    // separati. Niente prende effetto finche' `applyMwan()` non viene chiamata,
    // e chi chiama la invoca dopo TUTTE le scritture, dentro lo stesso `try`:
    // se una fallisce l'apply non arriva e non prende effetto niente. E' quel
    // confine a dare il "nella stessa transazione o in nessuna", e priorita'
    // disallineate fra le due famiglie manderebbero v4 e v6 su WAN diverse -
    // meta' del web che carica, molto piu' difficile da diagnosticare di un
    // guasto pulito.
    await call('uci', 'set', { config: 'mwan3', section: `${order[i]}_f`, values: { metric } });
    await call('uci', 'set', { config: 'network', section: order[i], values: { metric } });
    await setIfPresent('mwan3', `${order[i]}6_f`, { metric });
    await setIfPresent('network', `${order[i]}6`, { metric });
  }
}

/**
 * Scrive una sezione solo se esiste.
 *
 * Le gemelle IPv6 possono mancare: un router non ancora aggiornato, o una WAN
 * per cui `setup.sh` non ha potuto creare la `<net>6`. Trattare l'assenza come
 * un errore bloccherebbe una modifica IPv4 perfettamente valida.
 */
async function setIfPresent(
  config: string,
  section: string,
  values: Record<string, string>,
): Promise<void> {
  try {
    await call('uci', 'get', { config, section });
  } catch {
    return;
  }
  await call('uci', 'set', { config, section, values });
}

export async function setWeight(network: string, weight: number): Promise<void> {
  await call('uci', 'set', {
    config: 'mwan3',
    section: `${network}_b`,
    values: { weight: String(weight) },
  });
  await setIfPresent('mwan3', `${network}6_b`, { weight: String(weight) });
}

/** Esclude o riammette una WAN nel multi-WAN, senza spegnere l'interfaccia. */
export async function setEnabled(network: string, enabled: boolean): Promise<void> {
  const value = enabled ? '1' : '0';
  await call('uci', 'set', { config: 'mwan3', section: network, values: { enabled: value } });
  // Escludere una WAN in una famiglia sola non e' una mezza esclusione: e' una
  // WAN che continua a portare meta' del traffico dopo che l'utente ha detto di
  // toglierla.
  await setIfPresent('mwan3', `${network}6`, { enabled: value });
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
export function policyFor(network: string, strict: boolean, family: IpFamily = 4): string {
  // Il `6` va in TESTA e non in coda, ed e' l'unica forma che si puo' rileggere
  // senza ambiguita': con `o_<net>6` non si saprebbe se la WAN e' `<net>` in
  // IPv6 o una WAN che si chiama `<net>6` - e `wan_lan6` e' un nome legittimo,
  // perche' le porte ethernet danno il nome all'interfaccia. `parsePolicy`
  // riporterebbe una WAN che non esiste, e il salvataggio successivo
  // scriverebbe `o_wan_lan66`.
  return `${strict ? 'o' : 'p'}${family === 6 ? '6' : ''}_${network}`;
}

/**
 * Le due politiche globali, per famiglia.
 *
 * `travel_failover6` non esiste e non puo' esistere: fa 16 caratteri e mwan3
 * ne impone 15 ai nomi delle politiche, rifiutandole in silenzio. I nomi v6
 * sono quindi accorciati, e questa funzione e' l'unico posto che lo sa.
 */
export function globalPolicy(mode: MwanMode, family: IpFamily = 4): string {
  if (family === 6) return mode === 'balance' ? 'travel_bal6' : 'travel_fail6';
  return mode === 'balance' ? 'travel_balance' : 'travel_failover';
}

/**
 * Da quale politica si risale alla WAN e al comportamento in caso di caduta.
 *
 * Riconosce anche i prefissi lunghi di prima: una configurazione non ancora
 * migrata deve continuare a leggersi, altrimenti le regole gia' scritte
 * sparirebbero dall'elenco invece di mostrarsi.
 */
export function parsePolicy(
  policy: string,
): { network: string; strict: boolean; family: IpFamily } | null {
  // Le forme IPv6 per prime: `o6_` inizia per `o`, quindi provare `o_` prima
  // non combacerebbe comunque, ma l'ordine rende la lettura ovvia.
  if (policy.startsWith('o6_')) return { network: policy.slice(3), strict: true, family: 6 };
  if (policy.startsWith('p6_')) return { network: policy.slice(3), strict: false, family: 6 };
  if (policy.startsWith('o_')) return { network: policy.slice(2), strict: true, family: 4 };
  if (policy.startsWith('p_')) return { network: policy.slice(2), strict: false, family: 4 };
  if (policy.startsWith('only_')) return { network: policy.slice(5), strict: true, family: 4 };
  if (policy.startsWith('pref_')) return { network: policy.slice(5), strict: false, family: 4 };
  return null;
}

/**
 * La famiglia di una regola, dedotta dai criteri che la definiscono.
 *
 * `null` quando i due criteri appartengono a famiglie diverse: una regola con
 * `src_ip` v4 e `dest_ip` v6 non e' scrivibile, perche' `mwan3.<rule>.family` e'
 * un valore solo. Scriverla comunque significherebbe che uno dei due criteri
 * non combacia mai - cioe' una regola che non si applica, in silenzio.
 */
export function ruleFamily(input: { src_ip?: string; dest_ip?: string }): IpFamily | null {
  const families = [input.src_ip, input.dest_ip]
    .filter((value): value is string => !!value)
    .map((value) => parseCidr(value)?.addr.family)
    .filter((family): family is IpFamily => family !== undefined);

  if (families.length === 0) return 4;
  return families.every((family) => family === families[0]) ? families[0] : null;
}

function ruleValues(input: RuleInput): Record<string, string> {
  const family = ruleFamily(input);
  if (family === null) {
    throw new Error(mwanText().mixedFamilies);
  }

  const values: Record<string, string> = {
    use_policy: policyFor(input.network, input.strict, family),
    family: family === 6 ? 'ipv6' : 'ipv4',
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
  // Le due predefinite si spostano INSIEME in fondo. Ricrearne una sola la
  // lascerebbe dietro all'altra, e la regola che resta davanti prende tutto il
  // traffico della sua famiglia: una regola nuova IPv6 non verrebbe mai
  // raggiunta, in silenzio, mentre la stessa regola in IPv4 funziona.
  const existed6 = await sectionExists('mwan3', 'travel_default6');

  for (const section of ['travel_default', 'travel_default6']) {
    if (section === 'travel_default6' && !existed6) continue;
    try {
      await call('uci', 'delete', { config: 'mwan3', section });
    } catch {
      // Non c'era: la si crea comunque qui sotto.
    }
  }

  await call('uci', 'add', {
    config: 'mwan3',
    type: 'rule',
    name: 'travel_default',
    values: {
      dest_ip: '0.0.0.0/0',
      family: 'ipv4',
      use_policy: globalPolicy(defaults.mode, 4),
      sticky: defaults.sticky ? '1' : '0',
      timeout: String(defaults.timeout),
    },
  });

  // Solo se c'era: su un router non ancora aggiornato la predefinita v6 non
  // esiste, e inventarla qui vorrebbe dire creare una regola che punta a una
  // politica che `mwan3-setup.sh` non ha ancora scritto.
  if (existed6) {
    await call('uci', 'add', {
      config: 'mwan3',
      type: 'rule',
      name: 'travel_default6',
      values: {
        dest_ip: '::/0',
        family: 'ipv6',
        use_policy: globalPolicy(defaults.mode, 6),
        sticky: defaults.sticky ? '1' : '0',
        timeout: String(defaults.timeout),
      },
    });
  }
}

/** Vero se la sezione uci esiste. `uci get` su una che non c'e' e' un errore. */
async function sectionExists(config: string, section: string): Promise<boolean> {
  try {
    await call('uci', 'get', { config, section });
    return true;
  } catch {
    return false;
  }
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

  const timings = {
    interval: String(settings.interval),
    timeout: String(settings.timeout),
    count: String(settings.count),
    up: String(settings.up),
    down: String(settings.down),
    reliability: String(reliability),
  };

  await call('uci', 'set', {
    config: 'mwan3',
    section: network,
    values: { ...timings, track_ip: settings.track_ip },
  });

  // Alla gemella IPv6 vanno i TEMPI ma non gli indirizzi.
  //
  // I tempi sono la stessa decisione - ogni quanto controllare, dopo quanti
  // fallimenti dichiararla caduta - e tenerli diversi farebbe cadere le due
  // famiglie in momenti diversi sulla stessa WAN.
  //
  // Gli indirizzi no: la sezione v6 ha `family=ipv6` e li pinga con `ping6`,
  // quindi un indirizzo v4 li' dentro la terrebbe caduta per sempre. Il suo
  // pool lo scrive `mwan3-setup.sh`, ed e' anche il motivo per cui il campo
  // dell'interfaccia continua a chiedere indirizzi IPv4.
  await setIfPresent('mwan3', `${network}6`, timings);
}
