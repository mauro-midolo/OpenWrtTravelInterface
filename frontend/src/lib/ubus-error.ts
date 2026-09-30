/**
 * Errori di ubus, in un modulo loro.
 *
 * Stanno separati dal client perche' servono anche al simulatore: cosi' un
 * errore finto ha lo stesso tipo e lo stesso codice di uno vero, e i rami che
 * distinguono "permesso negato" da "nessun dato" si possono provare senza un
 * router. Dentro `ubus.ts` non potevano stare, perche' il simulatore non puo'
 * importarlo - ne e' importato - e avrebbe potuto lanciare solo errori
 * generici, lasciando quei rami senza prova.
 */

import { commonText } from '../i18n/common';
import { backendMessage } from '../i18n/backend';
import type { BackendParams } from '../i18n/backend';

/** Codici di stato ubus che ci interessa distinguere. */
export const UBUS_OK = 0;
export const UBUS_PERMISSION_DENIED = 6;
/** Quello che risponde `uci get` quando l'opzione non c'e'. */
export const UBUS_NOT_FOUND = 5;


export class UbusError extends Error {
  constructor(
    readonly code: number,
    /** Oggetto e metodo chiamati, per sapere *cosa* e' fallito. */
    readonly where: string,
    detail?: string,
  ) {
    // Il testo dei codici sta nei dizionari: senza, restano numeri senza significato.
    const t = commonText().ubus;
    const text = detail ?? t.codes[code] ?? t.code(code);
    super(`${where}: ${text} (${t.code(code)})`);
    this.name = 'UbusError';
  }

  /** Sessione scaduta o revocata: va rifatto il login. */
  get isAuthError(): boolean {
    return this.code === UBUS_PERMISSION_DENIED;
  }
}

/** Una risposta del router che puo' contenere un errore, con il suo codice. */
export interface BackendFailure {
  error?: string;
  error_code?: string;
  error_params?: BackendParams;
}

/**
 * L'errore da lanciare per una risposta con `error`.
 *
 * Il messaggio e' gia' nella lingua dell'interfaccia (vedi `backendMessage`);
 * il codice resta sull'errore per chi deve distinguere i casi.
 */
export class BackendError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export function backendError(result: BackendFailure): BackendError {
  return new BackendError(
    result.error_code,
    backendMessage(result.error ?? '', result.error_code, result.error_params),
  );
}
