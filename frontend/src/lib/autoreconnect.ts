/**
 * Riconnessione automatica (requisito E.3).
 *
 * La logica vive in travelD, non qui: serve stato che sopravvive fra una
 * richiesta e l'altra - backoff, blacklist, cooldown - e il browser non c'e'
 * quando serve. L'interfaccia legge lo stato e cambia i parametri.
 */

import { call } from './ubus';

export interface AutoSettings {
  autoreconnect: boolean;
  /** Sotto questa soglia una rete non viene considerata. */
  rssi_min: number;
  /** 'stay' resta connesso, 'best' passa alla rete migliore. */
  roam_mode: string;
  /** Quanti dB deve guadagnare una rete per giustificare un cambio. */
  roam_hysteresis: number;
  blacklist_after: number;
  blacklist_ttl: number;
  scan_interval: number;
}

export interface NetworkPenalty {
  fails: number;
  next_try: number;
  blacklisted_until: number;
}

export interface DaemonEvent {
  at: number;
  kind: string;
  message: string;
}

export interface DaemonStatus {
  version: string;
  uptime: number;
  ticks: number;
  enabled: boolean;
  settings: AutoSettings;
  networks: Record<string, NetworkPenalty>;
  events: DaemonEvent[];
  last_error: string;
}

export function getDaemon(): Promise<DaemonStatus> {
  return call<DaemonStatus>('traveld', 'status', { detail: '' });
}

/**
 * I parametri stanno in `/etc/config/travel`, che travelD rilegge a ogni giro:
 * non serve riavviarlo. Nessun applica-e-conferma, perche' il motore non tocca
 * mai gli access point e quindi non puo' chiudere fuori nessuno.
 */
export async function updateSettings(values: Record<string, string>): Promise<void> {
  await call('uci', 'set', { config: 'travel', section: 'globals', values });
  await call('uci', 'apply', {});
}

/** Azzera contatori di fallimento e blacklist (E.3: reset manuale). */
export function resetPenalties(): Promise<unknown> {
  return call('traveld', 'reset', { scope: 'all' });
}
