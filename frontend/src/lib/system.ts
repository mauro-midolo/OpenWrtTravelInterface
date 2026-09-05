/**
 * Orologio, backup e riavvio (Fase 8).
 *
 * Tre cose diverse tenute insieme da una sola idea: sono le operazioni sul
 * router in quanto apparecchio, non sulle reti che collega. Vivono tutte nel
 * plugin rpcd e non in travelD, come il resto della scheda Impostazioni:
 * devono funzionare anche quando il daemon non risponde, perche' e' proprio
 * allora che si va a cercare un backup o un riavvio.
 */

import { call } from './ubus';

// --- Orologio e NTP -----------------------------------------------------------

export interface TimeState {
  /** Ora del router, epoch. */
  now: number;
  /** Come la scrive il router, con il suo fuso gia' applicato. */
  local: string;
  section: string;
  zonename: string;
  /** La stringa POSIX, che e' quella che il sistema usa davvero. */
  timezone: string;
  ntp_enabled: boolean;
  ntpd_running: boolean;
  /**
   * L'ora e' un numero possibile.
   *
   * Non e' "sincronizzata": nessuno ha parlato con un server NTP per dirlo.
   * Falso significa che l'orologio e' rimasto a prima dell'accensione, ed e'
   * la causa piu' probabile di un HTTPS che non si apre.
   */
  plausible: boolean;
  /** Vero se c'e' un orologio a batteria. Su questo router non c'e'. */
  rtc: boolean;
  servers: string[];
}

export function getTime(): Promise<TimeState> {
  return call<TimeState>('travel', 'time_get');
}

export async function setTime(values: {
  timezone: string;
  zonename: string;
  servers: string[];
  enabled: boolean;
}): Promise<void> {
  const result = await call<{ error?: string }>('travel', 'time_set', {
    timezone: values.timezone,
    zonename: values.zonename,
    // Una stringa sola separata da spazi, non una lista JSON: il router la
    // spezza e la valida voce per voce. Vale anche al contrario - una lista
    // vuota arrivata per sbaglio si distingue da "non l'ho mandata".
    servers: values.servers.join(' '),
    enabled: values.enabled,
  });
  if (result.error) throw new Error(result.error);
}

/**
 * I fusi che servono davvero, con la loro stringa POSIX.
 *
 * Elenco corto e scritto a mano invece del database completo: il database dei
 * fusi (`zoneinfo`) sono centinaia di KB che su questo router non sono
 * installati, e la stringa POSIX e' quella che il sistema usa comunque. Chi va
 * in un posto che qui non c'e' incolla la sua stringa a mano - e' il caso raro,
 * e ha la sua casella.
 */
export const ZONES: Array<{ name: string; tz: string; label: string }> = [
  { name: 'Europe/Rome', tz: 'CET-1CEST,M3.5.0,M10.5.0/3', label: 'Italia · Europa centrale' },
  { name: 'Europe/London', tz: 'GMT0BST,M3.5.0/1,M10.5.0', label: 'Regno Unito · Irlanda' },
  { name: 'Europe/Lisbon', tz: 'WET0WEST,M3.5.0/1,M10.5.0', label: 'Portogallo' },
  { name: 'Europe/Athens', tz: 'EET-2EEST,M3.5.0/3,M10.5.0/4', label: 'Grecia · Finlandia' },
  { name: 'Europe/Moscow', tz: 'MSK-3', label: 'Mosca' },
  { name: 'UTC', tz: 'UTC0', label: 'UTC · nessun fuso' },
  { name: 'America/New_York', tz: 'EST5EDT,M3.2.0,M11.1.0', label: 'New York · costa est' },
  { name: 'America/Chicago', tz: 'CST6CDT,M3.2.0,M11.1.0', label: 'Chicago' },
  { name: 'America/Denver', tz: 'MST7MDT,M3.2.0,M11.1.0', label: 'Denver' },
  { name: 'America/Los_Angeles', tz: 'PST8PDT,M3.2.0,M11.1.0', label: 'Los Angeles · costa ovest' },
  { name: 'America/Sao_Paulo', tz: '<-03>3', label: 'San Paolo' },
  { name: 'Asia/Dubai', tz: '<+04>-4', label: 'Dubai' },
  { name: 'Asia/Kolkata', tz: 'IST-5:30', label: 'India' },
  { name: 'Asia/Bangkok', tz: '<+07>-7', label: 'Bangkok' },
  { name: 'Asia/Singapore', tz: '<+08>-8', label: 'Singapore' },
  { name: 'Asia/Shanghai', tz: 'CST-8', label: 'Cina' },
  { name: 'Asia/Tokyo', tz: 'JST-9', label: 'Giappone' },
  { name: 'Australia/Sydney', tz: 'AEST-10AEDT,M10.1.0,M4.1.0/3', label: 'Sydney' },
  { name: 'Australia/Perth', tz: 'AWST-8', label: 'Perth' },
];

/** I server NTP di OpenWrt: sono quelli che il router ha di fabbrica. */
export const DEFAULT_NTP = [
  '0.openwrt.pool.ntp.org',
  '1.openwrt.pool.ntp.org',
  '2.openwrt.pool.ntp.org',
  '3.openwrt.pool.ntp.org',
];

// --- Backup -------------------------------------------------------------------

export interface BackupFile {
  name: string;
  size: number;
  /** L'archivio in base64: il canale /ubus parla JSON, non file. */
  data: string;
}

export async function exportBackup(): Promise<BackupFile> {
  const result = await call<{ name?: string; size?: number; data?: string; error?: string }>(
    'travel',
    'backup_export',
  );
  if (result.error) throw new Error(result.error);
  return { name: result.name ?? 'backup.tar.gz', size: result.size ?? 0, data: result.data ?? '' };
}

/**
 * Quanto base64 sta in una richiesta ubus.
 *
 * uhttpd ha un limite sulla dimensione del corpo di una richiesta, e un
 * archivio intero lo supera. Il file sale a pezzi; ogni pezzo e' un multiplo di
 * quattro caratteri, che e' l'unita' del base64 - tagliato altrove, ogni pezzo
 * decodificato da solo perderebbe i bit in mezzo.
 */
const CHUNK = 24 * 1024;

/**
 * Rimette un backup e riavvia.
 *
 * `onProgress` riceve la frazione caricata: senza, una barra ferma per venti
 * secondi su una cosa che riavvia il router sembra un blocco, e chi guarda
 * stacca la corrente proprio nel momento peggiore.
 */
export async function importBackup(
  base64: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const total = base64.length;
  if (total === 0) throw new Error('file vuoto');

  for (let offset = 0; offset < total; offset += CHUNK) {
    const chunk = base64.slice(offset, offset + CHUNK);
    const last = offset + CHUNK >= total;
    const result = await call<{ error?: string }>('travel', 'backup_import', {
      chunk,
      first: offset === 0,
      last,
    });
    if (result.error) throw new Error(result.error);
    onProgress?.(Math.min(offset + CHUNK, total), total);
  }
}

/** Il contenuto di un file scelto dall'utente, in base64 e senza intestazione. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('lettura del file fallita'));
    reader.onload = () => {
      const result = String(reader.result);
      // FileReader restituisce "data:<tipo>;base64,<dati>": al router serve
      // solo la seconda meta'.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Fa scaricare l'archivio al browser.
 *
 * Il file non esiste da nessuna parte finche' non lo si costruisce qui: e'
 * arrivato come testo dentro una risposta JSON, perche' /ubus e' l'unico
 * canale che questa interfaccia ha.
 */
export function downloadBackup(backup: BackupFile): void {
  const bytes = Uint8Array.from(atob(backup.data), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/gzip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = backup.name;
  link.click();
  // Il browser ha gia' copiato il contenuto: tenere l'URL vivo terrebbe in
  // memoria l'intero archivio per tutta la durata della pagina.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Riavvio ------------------------------------------------------------------

export interface RebootSchedule {
  enabled: boolean;
  hour: number;
  minute: number;
  /** '*' ogni giorno, oppure 0-6 con 0 = domenica. */
  weekday: string;
  /** Falso se cron non sta girando: la riga sarebbe scritta e non applicata. */
  cron_running: boolean;
}

export function getReboot(): Promise<RebootSchedule> {
  return call<RebootSchedule>('travel', 'reboot_get');
}

export async function setReboot(values: {
  enabled: boolean;
  hour: number;
  minute: number;
  weekday: string;
}): Promise<void> {
  const result = await call<{ error?: string }>('travel', 'reboot_set', values);
  if (result.error) throw new Error(result.error);
}

export async function rebootNow(): Promise<void> {
  const result = await call<{ error?: string }>('travel', 'reboot_now');
  if (result.error) throw new Error(result.error);
}

export const WEEKDAYS: Array<{ value: string; label: string }> = [
  { value: '*', label: 'ogni giorno' },
  { value: '1', label: 'lunedì' },
  { value: '2', label: 'martedì' },
  { value: '3', label: 'mercoledì' },
  { value: '4', label: 'giovedì' },
  { value: '5', label: 'venerdì' },
  { value: '6', label: 'sabato' },
  { value: '0', label: 'domenica' },
];

export function scheduleLabel(schedule: RebootSchedule): string {
  const day = WEEKDAYS.find((d) => d.value === schedule.weekday)?.label ?? 'ogni giorno';
  const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
  return `${day} alle ${time}`;
}
