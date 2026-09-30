/**
 * Applica-e-conferma: il meccanismo che impedisce di restare chiusi fuori.
 *
 * Il router applica la modifica e arma un ritorno indietro automatico. Da qui
 * si prova a riparlargli: se ci si riesce, vuol dire che la modifica non ci ha
 * tagliato fuori, e si conferma. Se non ci si riesce, non si fa nulla e ci
 * pensa lui allo scadere del tempo.
 *
 * E' lo stesso meccanismo che usa LuCI (decisione D5): non ne scriviamo uno
 * nostro, chiamiamo quello di sistema.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { call } from './ubus';

/** Quanto tempo c'e' per confermare prima che il router torni indietro. */
export const ROLLBACK_SECONDS = 90;

export type ApplyPhase =
  | 'idle'
  | 'applying'
  /** Applicato: si aspetta di riuscire a riparlare col router. */
  | 'waiting'
  | 'confirmed'
  | 'rolledback'
  | 'error';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ApplyOptions {
  /**
   * Allunga la finestra quando riconnettersi richiede piu' tempo, per esempio
   * dopo un cambio di nome o password dell'access point, dove il dispositivo
   * va riagganciato a mano.
   */
  seconds?: number;

  /**
   * Condizione aggiuntiva da soddisfare prima di confermare.
   *
   * Serve perche' "riesco a parlare col router" non basta come prova che la
   * modifica sia andata bene: da cavo il router risponde sempre, quindi una
   * configurazione che manda giu' l'access point verrebbe confermata lo stesso.
   * Finche' questa non passa, non si conferma e il ritorno indietro resta armato.
   */
  verify?: () => Promise<boolean>;
}

export interface Apply {
  phase: ApplyPhase;
  /** Secondi rimasti prima del ritorno indietro automatico. */
  left: number;
  error: string | null;
  /** Mette in atto le modifiche preparate da `stage`. Vero se confermate. */
  run: (stage: () => Promise<void>, options?: ApplyOptions) => Promise<boolean>;
  abort: () => Promise<void>;
  reset: () => void;
}

export function useApply(): Apply {
  const [phase, setPhase] = useState<ApplyPhase>('idle');
  const [left, setLeft] = useState(ROLLBACK_SECONDS);
  const [error, setError] = useState<string | null>(null);

  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const fail = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
    setPhase('error');
  }, []);

  const run = useCallback(
    async (stage: () => Promise<void>, options: ApplyOptions = {}): Promise<boolean> => {
      const { seconds = ROLLBACK_SECONDS, verify } = options;
      setError(null);
      setPhase('applying');
      setLeft(seconds);

      try {
        // Finche' non si arriva ad apply, le modifiche restano in sospeso: se
        // il browser muore a meta' sequenza, sul router non e' cambiato nulla.
        await stage();
        await call('uci', 'apply', { rollback: true, timeout: seconds });
      } catch (err) {
        fail(err);
        return false;
      }

      setPhase('waiting');
      const deadline = Date.now() + seconds * 1000;

      while (!cancelled.current && Date.now() < deadline) {
        setLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
        await sleep(2000);
        if (cancelled.current) return false;

        try {
          await call('travel', 'status');
        } catch {
          continue; // Non raggiungibile: il WiFi si sta ancora riconfigurando.
        }

        if (verify) {
          try {
            if (!(await verify())) continue;
          } catch {
            continue;
          }
        }

        try {
          await call('uci', 'confirm');
        } catch (err) {
          fail(err);
          return false;
        }
        setPhase('confirmed');
        return true;
      }

      if (!cancelled.current) setPhase('rolledback');
      return false;
    },
    [fail],
  );

  const abort = useCallback(async () => {
    try {
      await call('uci', 'rollback');
    } catch {
      // Se non risponde, il timeout fa la stessa cosa da solo.
    }
    setPhase('idle');
  }, []);

  const reset = useCallback(() => {
    setPhase('idle');
    setError(null);
  }, []);

  return { phase, left, error, run, abort, reset };
}
