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

export const PORTAL_LABEL: Record<PortalState, string> = {
  online: 'Internet raggiungibile',
  portal: 'Serve un login',
  blocked: 'Nessuna uscita',
  unknown: 'Non verificata',
};

/**
 * Perche' la verifica non ha potuto dire niente.
 *
 * Uno stato "sconosciuto" senza motivo lascia a indovinare fra un guasto, una
 * dipendenza mancante e una condizione normalissima come una WAN senza
 * indirizzo. Sono situazioni diverse e vanno dette per nome.
 */
export function portalReason(result: PortalResult): string {
  switch (result.reason) {
    case 'no-address':
      return 'La WAN non ha un indirizzo: non c’è ancora niente da verificare.';
    case 'dns':
      return `Il nome ${hostOf(result.probe_url)} non si risolve. È un DNS che non risponde, non un portale: i portali il DNS lo rispondono, è così che portano il browser sulla loro pagina.`;
    case 'no-policy-routing':
      return 'Non è stato possibile instradare la verifica su questa WAN. Serve il pacchetto ip-full, che arriva insieme a mwan3.';
    case 'no-ip':
      return 'Manca il comando ip: senza, la verifica non può uscire dalla WAN giusta.';
    case 'no-http-client':
      return 'Sul router non c’è né nc né uclient-fetch: non c’è modo di fare la richiesta, quindi non è la rete a non rispondere — non le è stato chiesto niente.';
    case 'url-non-http':
      return 'L’indirizzo di verifica deve essere http:// e non https://: un portale fa fallire una connessione cifrata, e un fallimento non si distingue da una rete che non funziona.';
    case 'occupato':
      return 'Un’altra verifica era in corso. Riprova fra qualche secondo.';
    case 'src_validation':
      return 'Il firewall ha la validazione della sorgente accesa: le risposte che rientrano da una WAN diversa da quella predefinita vengono scartate, e ogni verifica fuori da quella attiva risulta bloccata senza esserlo.';
    default:
      return '';
  }
}

function hostOf(url: string): string {
  const match = /^https?:\/\/([^/:]+)/.exec(url);
  return match ? match[1] : url;
}

/** Vero quando c'e' una pagina di accesso da aprire. */
export function needsLogin(result: PortalResult | null | undefined): boolean {
  return result?.state === 'portal';
}

export function portalAt(result: PortalResult): string {
  if (!result.at) return '';
  const seconds = Math.max(0, Math.round(Date.now() / 1000) - result.at);
  if (seconds < 60) return 'adesso';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min fa`;
  return `${Math.round(seconds / 3600)} h fa`;
}

export function portalWhen(epoch: number): string {
  if (!epoch) return 'mai';
  return new Date(epoch * 1000).toLocaleString();
}
