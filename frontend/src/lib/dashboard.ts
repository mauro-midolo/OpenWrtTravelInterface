/**
 * Dashboard (requisiti G.1 e G.2).
 *
 * Una chiamata sola, servita da strutture gia' pronte nella RAM di travelD
 * (decisione D4): il polling costa una richiesta per giro, non una raffica di
 * comandi sul router. Le misure care - stato delle WAN e ping - partono solo
 * finche' qualcuno sta guardando questa schermata.
 */

import { settingsText } from '../i18n/settings';
import { call } from './ubus';
import type { PortalResult } from './portal';

/**
 * Stati di una WAN.
 *
 * `unassociated` e `no-carrier` sono la stessa idea in due mondi diversi - una
 * radio che non aggancia e un cavo che non c'e' - ma i rimedi sono opposti,
 * quindi restano nomi distinti.
 */
export type WanState =
  | 'absent'
  | 'disabled'
  | 'unassociated'
  | 'no-carrier'
  | 'no-address'
  | 'addressed';

export interface DashWan {
  network: string;
  kind: string;
  band: string;
  radio: string;
  device: string;
  /** Sezione uci della STA, vuota se la radio non ha nessuna rete configurata. */
  section: string;
  /** Vero per la sola WAN che sta portando il traffico adesso. */
  active: boolean;
  enabled: boolean;
  /** 1 cavo attaccato, 0 scollegato, -1 non applicabile o ignoto. */
  carrier: number;
  /** Driver del tethering USB (cdc_ncm, rndis_host...), vuoto per il resto. */
  driver: string;
  state: WanState;
  /**
   * Esito dell'ultima verifica dell'uscita verso Internet, `null` se non e'
   * mai stata fatta.
   *
   * Sta accanto a `state` e non dentro perche' sono due domande diverse: se il
   * collegamento e' su, e se ci si passa davvero. Un portale risponde alla
   * prima e non alla seconda, ed e' l'intero motivo per cui questo campo esiste.
   */
  portal: PortalResult | null;
  ssid: string;
  bssid: string;
  channel: number;
  signal?: number;
  bitrate?: number;
  ipv4: string;
  gateway: string;
  dns: string[];
  /**
   * Indirizzi IPv6 col prefisso attaccato, gateway, prefisso delegato e DNS v6.
   *
   * Obbligatori come su `Uplink`, e riempiti all'ingresso da
   * `withDashWanDefaults`: un router con il pacchetto vecchio non li manda, e
   * nessuna scheda della dashboard deve saperlo.
   */
  ipv6: string[];
  gateway6: string;
  prefix6: string;
  dns6: string[];
  mac: string;
  metric: number;
  /** Nome inviato nel DHCP, grezzo da uci: `*` nessuno, vuoto quello del router. */
  hostname: string;
  /** Byte al secondo, istantanei. */
  rx_rate: number;
  tx_rate: number;
  /** Byte dall'avvio di travelD. */
  rx_session: number;
  tx_session: number;
}

export interface DashSystem {
  /** Nome del router, quello vero in RAM. */
  hostname: string;
  uptime: number;
  load: [number, number, number];
  temp_mc: number | null;
  mem_total_kb: number;
  mem_available_kb: number;
}

export interface DashEvent {
  at: number;
  kind: string;
  message: string;
}

export interface Dashboard {
  version: string;
  at: number;
  system: DashSystem;
  wans: DashWan[];
  autoreconnect: boolean;
  /** La verifica periodica dei portali e' accesa. */
  portal_check: boolean;
  /**
   * Kill switch della VPN, in due campi perche' sono due cose diverse: cosa
   * l'utente ha chiesto, e fino a quando e' sospeso. Sta anche qui e non solo
   * nella schermata VPN perche' una sospensione in corso e' proprio quello che
   * si vuole ritrovare sotto gli occhi mentre si guarda altro.
   */
  killswitch: { on: boolean; resume_at: number };
  events: DashEvent[];
  last_error: string;
}

/** La WAN come arriva da travelD, dove i campi v6 possono mancare. */
type RawDashWan = Omit<DashWan, 'ipv6' | 'gateway6' | 'prefix6' | 'dns6'> &
  Partial<Pick<DashWan, 'ipv6' | 'gateway6' | 'prefix6' | 'dns6'>>;

/** Stessa regola di `withUplinkDefaults`, sull'altra porta d'ingresso. */
function withDashWanDefaults(raw: RawDashWan): DashWan {
  return {
    ...raw,
    ipv6: raw.ipv6 ?? [],
    gateway6: raw.gateway6 ?? '',
    prefix6: raw.prefix6 ?? '',
    dns6: raw.dns6 ?? [],
  };
}

export async function getDashboard(): Promise<Dashboard> {
  const board = await call<Omit<Dashboard, 'wans'> & { wans?: RawDashWan[] }>(
    'traveld',
    'dashboard',
    { detail: '' },
  );
  return { ...board, wans: (board.wans ?? []).map(withDashWanDefaults) };
}

export type OverallState =
  /** Verificato: una richiesta vera e' uscita ed e' tornata intatta. */
  | 'online'
  /** C'e' una rotta, ma nessuno ha ancora controllato che porti da qualche parte. */
  | 'connected'
  /** Indirizzo si', ma un portale intercetta: serve un login. */
  | 'portal'
  /** Indirizzo si', e non esce niente. */
  | 'no-internet'
  /** Qualche WAN ha un indirizzo ma nessuna sta portando traffico. */
  | 'degraded'
  | 'offline';

/**
 * Stato complessivo in una parola (requisito G.1).
 *
 * Fino alla Fase 5 questa funzione non poteva dire "online" e non lo diceva:
 * avere indirizzo e rotta non garantisce che Internet funzioni, perche' un
 * portale risponde a tutto e blocca il resto. Adesso la verifica c'e', e la
 * distinzione che ne esce e' la ragione dell'intera fase: `connected` significa
 * "non lo so ancora", `online` significa "l'ho misurato".
 *
 * La WAN che conta e' quella che porta il traffico: e' da li' che esce anche il
 * browser del telefono, quindi e' il suo verdetto a descrivere cosa succede a
 * chi sta guardando.
 */
export function overallState(wans: DashWan[]): OverallState {
  const active = wans.find((w) => w.active && w.state === 'addressed');

  if (active) {
    switch (active.portal?.state) {
      case 'online':
        return 'online';
      case 'portal':
        return 'portal';
      case 'blocked':
        return 'no-internet';
      default:
        // Mai verificata, o non verificabile: si dice quello che si sa, cioe'
        // che una rotta c'e'. Affermare Internet su una misura mancante
        // sarebbe esattamente l'errore che questa fase e' venuta a togliere.
        return 'connected';
    }
  }

  if (wans.some((w) => w.state === 'addressed')) return 'degraded';
  return 'offline';
}

export function formatRate(bytesPerSecond: number): string {
  const bits = bytesPerSecond * 8;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbit/s`;
  if (bits >= 1e3) return `${Math.round(bits / 1e3)} kbit/s`;
  return `${Math.round(bits)} bit/s`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}${settingsText().days} ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}


