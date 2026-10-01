/**
 * Nome inviato nella richiesta DHCP, per ogni WAN.
 *
 * E' il campo che in LuCI si chiama "Hostname to send when requesting DHCP" e
 * vive sull'interfaccia logica (`network.<iface>.hostname`), non sulla sezione
 * wireless: vale quindi allo stesso modo per le STA WiFi, per le porte
 * ethernet e per il tethering USB.
 *
 * I tre stati sono quelli che netifd sa distinguere:
 *
 *   `*`      non inviare niente
 *   assente  invia il nome del router (`/proc/sys/kernel/hostname`)
 *   testo    invia quel nome
 *
 * Il default qui e' `*`: su un router da viaggio il nome del dispositivo
 * finisce nella lista dei client di ogni rete a cui ci si aggancia - hotel,
 * aeroporti, casa di altri - e non c'e' nessun motivo per regalarlo. Chi lo
 * vuole (alcune reti aziendali registrano i client per nome) lo accende per
 * quella rete.
 */

import { hostnameText } from '../i18n/hostname';
import { call } from './ubus';

export type HostnameMode = 'none' | 'device' | 'custom';

export interface HostnameChoice {
  mode: HostnameMode;
  /** Usato solo da `custom`, vuoto negli altri due casi. */
  value: string;
}

/** Il default del progetto: niente nome nella richiesta DHCP. */
export const HOSTNAME_OFF: HostnameChoice = { mode: 'none', value: '' };

export const HOSTNAME_MODES: Array<{ mode: HostnameMode; label: string }> = (
  ['none', 'device', 'custom'] as const
).map((mode) => ({
  mode,
  get label() {
    return hostnameText().mode[mode];
  },
}));

/**
 * Nome valido per DNS e DHCP (RFC 1123): lettere, cifre e trattini, non in
 * testa ne' in coda, al massimo 63 caratteri.
 *
 * Un nome con spazi o punti viene accettato da uci e poi rifiutato o troncato
 * dal server DHCP a monte, che e' il modo peggiore di sbagliare: sembra
 * salvato e non arriva.
 */
export function isValidHostname(name: string): boolean {
  return /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(name);
}

/** Come si legge il valore grezzo di uci. */
export function hostnameFromUci(raw: string | undefined): HostnameChoice {
  const value = (raw ?? '').trim();
  if (value === '*') return { mode: 'none', value: '' };
  // Opzione assente: e' il default di OpenWrt, cioe' "manda il nome del
  // router". Non e' il nostro, ma va rappresentato per quello che e'.
  if (value === '') return { mode: 'device', value: '' };
  return { mode: 'custom', value };
}

/** Valore da scrivere in uci, oppure `null` se l'opzione va cancellata. */
export function hostnameToUci(choice: HostnameChoice): string | null {
  if (choice.mode === 'none') return '*';
  if (choice.mode === 'custom') return choice.value.trim();
  return null;
}

/** Etichetta breve per le righe di riepilogo. */
export function hostnameLabel(choice: HostnameChoice, deviceHostname?: string): string {
  switch (choice.mode) {
    case 'none':
      return hostnameText().notSent;
    case 'device':
      return deviceHostname
        ? hostnameText().routerNamed(deviceHostname)
        : hostnameText().routerName;
    default:
      return choice.value || '—';
  }
}

export function sameHostname(a: HostnameChoice, b: HostnameChoice): boolean {
  return a.mode === b.mode && (a.mode !== 'custom' || a.value.trim() === b.value.trim());
}

/**
 * Prepara il nome DHCP di una WAN. Non applica: ci pensa `useApply`.
 *
 * Cancellare l'opzione e scriverla vuota non sono la stessa cosa: uci rifiuta
 * il valore vuoto, e netifd leggerebbe comunque "manda il nome del router".
 * Per tornare al default di OpenWrt l'opzione va tolta.
 */
export async function stageWanHostname(
  network: string,
  choice: HostnameChoice,
): Promise<void> {
  const value = hostnameToUci(choice);

  if (value === null) {
    try {
      await call('uci', 'delete', { config: 'network', section: network, option: 'hostname' });
    } catch {
      // Non c'era: e' gia' lo stato voluto.
    }
    return;
  }

  await call('uci', 'set', { config: 'network', section: network, values: { hostname: value } });
}

// --- Nome del router ---------------------------------------------------------

export interface SystemInfo {
  /** Il nome attivo, letto da /proc: e' quello che il router usa adesso. */
  hostname: string;
  /**
   * Il nome scritto in uci. Puo' differire da quello attivo fino al reload, ed
   * e' quello che va mostrato a chi lo sta per cambiare.
   */
  configured: string;
  /**
   * Nome reale della sezione `system`, quello che `uci set` accetta:
   * `@system[0]` viene rifiutato da ubus, come per dnsmasq.
   */
  section: string;
}

export function getSystem(): Promise<SystemInfo> {
  return call<SystemInfo>('travel', 'system');
}

/**
 * Cambia il nome del router.
 *
 * Non passa da applica-e-conferma: il nome non tocca indirizzi, rotte ne'
 * firewall, quindi non puo' chiudere fuori nessuno. Cambia pero' cio' che
 * vedono le WAN impostate su "nome del router", ed e' il motivo per cui le due
 * cose si spiegano insieme.
 */
export async function setSystemHostname(section: string, hostname: string): Promise<void> {
  await call('uci', 'set', { config: 'system', section, values: { hostname } });
  await call('uci', 'apply', {});
}
