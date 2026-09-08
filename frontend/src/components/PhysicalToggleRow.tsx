import { useEffect, useRef, useState } from 'preact/hooks';
import { TOGGLE_ACTIONS, getToggle, setToggle } from '../lib/toggle';
import type { ToggleAction, ToggleConfig } from '../lib/toggle';

/**
 * Cosa fa la levetta sul fianco del router.
 *
 * Sta nella riga sotto il LED perche' e' della stessa specie: una preferenza
 * del dispositivo, non una funzione con una schermata sua. Qui si sceglie e
 * basta - accendere e spegnere il LED lo fa gia' qualcun altro.
 */
export function PhysicalToggleRow({ onApplied }: { onApplied?: () => void }) {
  const [config, setConfig] = useState<ToggleConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);

  const run = async (action?: ToggleAction) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = action === undefined ? await getToggle() : await setToggle(action);
      if (mounted.current) setConfig(result);
      // Il router ha gia' allineato l'uscita alla levetta prima di rispondere:
      // chi mostra quel valore lo deve rileggere adesso, non fra un giro.
      if (action !== undefined) onApplied?.();
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

  // Le voci le decide il router: l'etichetta la mette questa lista, ma un'azione
  // che il pacchetto installato non conosce non deve comparire.
  const options = config && TOGGLE_ACTIONS.filter((action) => config.actions.includes(action.id));

  return (
    <>
      <label class="row" aria-busy={busy}>
        <span class="row__label">Interruttore fisico</span>
        {options ? (
          <select
            class="row__select"
            value={config.action}
            disabled={busy}
            onChange={(e) => void run((e.target as HTMLSelectElement).value as ToggleAction)}
          >
            {options.map((action) => (
              <option key={action.id} value={action.id}>{action.label}</option>
            ))}
          </select>
        ) : (
          <span class="row__value">{error ? 'non disponibile' : 'Caricamento…'}</span>
        )}
      </label>

      {error && <p class="alert alert--error" role="alert">{error}</p>}
      {error && !config && (
        <button class="button button--ghost" disabled={busy} onClick={() => void run()}>
          Riprova
        </button>
      )}
    </>
  );
}
