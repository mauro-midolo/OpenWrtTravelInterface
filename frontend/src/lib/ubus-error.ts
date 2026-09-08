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

/** Codici di stato ubus che ci interessa distinguere. */
export const UBUS_OK = 0;
export const UBUS_PERMISSION_DENIED = 6;
/** Quello che risponde `uci get` quando l'opzione non c'e'. */
export const UBUS_NOT_FOUND = 5;

/** Testo dei codici di stato ubus. Senza, restano numeri senza significato. */
const UBUS_MESSAGES: Record<number, string> = {
  1: 'comando non valido',
  2: 'argomento non valido',
  3: 'metodo inesistente',
  4: 'oggetto non trovato',
  5: 'nessun dato',
  6: 'permesso negato',
  7: 'timeout',
  8: 'non supportato',
  9: 'errore sconosciuto',
  10: 'connessione fallita',
};

export class UbusError extends Error {
  constructor(
    readonly code: number,
    /** Oggetto e metodo chiamati, per sapere *cosa* e' fallito. */
    readonly where: string,
    detail?: string,
  ) {
    const text = detail ?? UBUS_MESSAGES[code] ?? `codice ${code}`;
    super(`${where}: ${text} (codice ${code})`);
    this.name = 'UbusError';
  }

  /** Sessione scaduta o revocata: va rifatto il login. */
  get isAuthError(): boolean {
    return this.code === UBUS_PERMISSION_DENIED;
  }
}
