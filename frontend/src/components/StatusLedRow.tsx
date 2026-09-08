import { useEffect, useRef, useState } from 'preact/hooks';
import { getStatusLed, setStatusLed } from '../lib/led';
import type { StatusLedState } from '../lib/led';

/**
 * Il LED di stato sta fra i dati del dispositivo, non in una scheda sua: e'
 * una preferenza da toccare una volta - spegnerlo di notte in albergo - e in
 * una scheda a parte pesava piu' di quanto conti. L'interruttore prende il
 * posto del valore, come le altre righe.
 */
export function StatusLedRow() {
  const [state, setState] = useState<StatusLedState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);

  const run = async (enabled?: boolean) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = enabled === undefined ? await getStatusLed() : await setStatusLed(enabled);
      if (mounted.current) setState(result);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    void run();
    return () => { mounted.current = false; };
  }, []);

  // Senza LED - o finche' la lettura non e' tornata - non c'e' niente da
  // accendere: la riga dice quello che sa, come fa "Temperatura".
  const usable = !!state?.supported;

  return (
    <>
      <label class="row" aria-busy={busy}>
        <span class="row__label">LED di stato</span>
        {usable ? (
          <input
            class="row__toggle"
            type="checkbox"
            checked={state!.enabled}
            disabled={busy}
            onChange={(e) => void run((e.target as HTMLInputElement).checked)}
          />
        ) : (
          <span class="row__value">non disponibile</span>
        )}
      </label>

      {/* Un errore invece si dice: senza, l'interruttore tornerebbe indietro
          da solo e sembrerebbe rotto. */}
      {error && <p class="alert alert--error" role="alert">{error}</p>}
      {error && !state && (
        <button class="button button--ghost" disabled={busy} onClick={() => void run()}>
          Riprova
        </button>
      )}
    </>
  );
}
