/**
 * Captive portal (requisito E.4).
 *
 * E' la risposta alla domanda che tutto il resto dell'interfaccia si e' finora
 * rifiutata di dare: *Internet funziona davvero?* Avere indirizzo, gateway e
 * DNS non lo garantisce - un portale risponde al DHCP, lascia passare il ping e
 * blocca tutto il resto - quindi fino a qui nessuna schermata lo ha mai
 * affermato. Adesso c'e' una misura vera dietro l'affermazione.
 *
 * La misura la fa il router (`travel.portal_probe`), il daemon decide quando
 * (`traveld.portal`). Da qui si legge il verdetto e si chiede di rifarlo.
 */

import { locale } from '../i18n';
import { portalText } from '../i18n/portal';
import { call } from './ubus';

/**
 * Esito della verifica di una WAN.
 *
 * `blocked` e `portal` non sono la stessa cosa e non hanno lo stesso rimedio:
 * il primo e' una rete che non porta da nessuna parte, il secondo una rete che
 * aspetta un login. Chiamarli entrambi "senza Internet" manda a cercare il
 * guasto invece di aprire una pagina.
 */
export type PortalState = 'online' | 'portal' | 'blocked' | 'unknown';

export interface PortalResult {
  network: string;
  state: PortalState;
  /** Perche' non si e' potuto misurare. Vuoto quando la misura c'e' stata. */
  reason: string;
  /** Pagina di accesso da aprire nel browser. Solo per lo stato `portal`. */
  url: string;
  /** L'indirizzo interrogato per la verifica. */
  probe_url: string;
  ip: string;
  /** `nc` o `uclient-fetch`: il secondo segue i rimandi e sa dire meno. */
  tool: string;
  /** Codice HTTP ricevuto, 0 se nessuna risposta. */
  http: number;
  /** Epoch secondi della misura. */
  at: number;
  took: number;
}

export interface PortalStatus {
  at: number;
  /** La verifica periodica e' accesa (`travel.globals.portal_check`). */
  enabled: boolean;
  results: Record<string, PortalResult>;
}

/** L'ultimo verdetto per ogni WAN, dalla RAM del daemon: non fa partire nulla. */
export function getPortals(): Promise<PortalStatus> {
  return call<PortalStatus>('traveld', 'portal', { detail: '' });
}

/**
 * Rifa' la verifica adesso, su una WAN sola.
 *
 * Passa dal daemon e non direttamente dal router: cosi' il risultato finisce
 * nella stessa cache che alimenta la dashboard, e non esistono due versioni
 * della stessa verita' che si contraddicono a schermo. Puo' richiedere una
 * decina di secondi - risoluzione del nome, connessione, attesa della risposta
 * su una rete che potrebbe non rispondere affatto.
 */
export async function checkPortal(network: string): Promise<PortalResult> {
  const result = await call<PortalResult & { error?: string }>(
    'traveld',
    'portal_check',
    { network },
    30_000,
  );
  if (result.error) throw new Error(result.error);
  return result;
}

export interface PortalMemory {
  section: string;
  /** SSID della rete, o nome dell'interfaccia per le WAN via cavo. */
  key: string;
  label: string;
  network: string;
  url: string;
  /** Epoch dell'ultima volta che il portale e' stato visto, 0 se mai. */
  last_seen: number;
  /** Epoch dell'ultimo accesso riuscito, 0 se non e' mai andato a buon fine. */
  last_login: number;
}

/** Le reti su cui e' gia' stato incontrato un portale. */
export async function listPortalMemory(): Promise<PortalMemory[]> {
  const response = await call<{ portals?: PortalMemory[] }>('travel', 'portal_networks');
  return (response.portals ?? []).sort((a, b) => b.last_seen - a.last_seen);
}

export async function forgetPortal(section: string): Promise<void> {
  const response = await call<{ error?: string }>('travel', 'portal_forget', { section });
  if (response.error) throw new Error(response.error);
}

/** Il verdetto in due parole, nella lingua dell'interfaccia. */
export function portalLabel(state: PortalState): string {
  return portalText().state[state];
}

/**
 * Perche' la verifica non ha potuto dire niente.
 *
 * Uno stato "sconosciuto" senza motivo lascia a indovinare fra un guasto, una
 * dipendenza mancante e una condizione normalissima come una WAN senza
 * indirizzo. Sono situazioni diverse e vanno dette per nome.
 */
export function portalReason(result: PortalResult): string {
  const reasons = portalText().reason;
  if (result.reason === 'dns') return reasons.dns(hostOf(result.probe_url));
  const text = reasons[result.reason as Exclude<keyof typeof reasons, 'dns'>];
  return typeof text === 'string' ? text : '';
}

function hostOf(url: string): string {
  const match = /^https?:\/\/([^/:]+)/.exec(url);
  return match ? match[1] : url;
}

/**
 * Un indirizzo da mettere in un link, solo se e' http o https.
 *
 * L'URL della pagina di accesso arriva dall'header `Location` della rete a cui
 * ci si e' collegati, cioe' da qualcuno di cui non ci si fida: un hotspot che
 * rispondesse `javascript:...` avrebbe il suo codice eseguito nella pagina di
 * amministrazione del router, con la sessione in mano. Preact un `href` cosi'
 * lo scrive senza obiettare, quindi il filtro sta qui. Stringa vuota se
 * l'indirizzo non va bene: chi lo mostra non mette il link.
 */
export function safeHttpUrl(url: string | null | undefined): string {
  const text = (url ?? '').trim();
  if (text === '') return '';
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

/**
 * La pagina di accesso da aprire, gia' filtrata da `safeHttpUrl`.
 *
 * Se quella indicata dal portale non passa il filtro si ripiega sull'endpoint
 * di verifica, che e' nostro: riaprirlo in http fa ricomparire il portale da
 * se'. Vuota se nemmeno quello e' un indirizzo http.
 */
export function portalLoginUrl(result: Pick<PortalResult, 'url' | 'probe_url'>): string {
  return safeHttpUrl(result.url) || safeHttpUrl(result.probe_url);
}

/** Vero quando c'e' una pagina di accesso da aprire. */
export function needsLogin(result: PortalResult | null | undefined): boolean {
  return result?.state === 'portal';
}

export function portalAt(result: PortalResult): string {
  if (!result.at) return '';
  const seconds = Math.max(0, Math.round(Date.now() / 1000) - result.at);
  const t = portalText();
  if (seconds < 60) return t.now;
  if (seconds < 3600) return t.minutesAgo(Math.round(seconds / 60));
  return t.hoursAgo(Math.round(seconds / 3600));
}

export function portalWhen(epoch: number): string {
  if (!epoch) return portalText().never;
  return new Date(epoch * 1000).toLocaleString(locale());
}
