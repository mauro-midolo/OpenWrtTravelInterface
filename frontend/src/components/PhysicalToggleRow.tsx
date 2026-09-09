import { useEffect, useRef, useState } from 'preact/hooks';
import { getToggle, setToggle, toggleLabel } from '../lib/toggle';
import type { ToggleAction, ToggleConfig } from '../lib/toggle';

/**
 * Cosa fa la levetta sul fianco del router.
 *
 * Sta nella riga sotto il LED perche' e' della stessa specie: una preferenza
 * del dispositivo, non una funzione con una schermata sua. Qui si sceglie e
 * basta - accendere e spegnere il LED lo fa gia' qualcun altro.
 */
export function PhysicalToggleRow({ onConfig }: {
  /**
   * La configurazione appena letta o scritta, per chi mostra un valore che la
   * levetta puo' muovere: `applied` distingue le due cose. Con `true` il router
   * ha gia' riallineato l'uscita alla levetta e quel valore va riletto adesso;
   * con `false` e' solo la lettura di partenza, e non c'e' niente di nuovo da
   * andare a vedere.
   */
  onConfig?: (config: ToggleConfig, applied: boolean) => void;
}) {
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
      onConfig?.(result, action !== undefined);
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

  // Le voci le decide il router, e adesso non sono piu' solo quelle fisse: fra
  // di esse ci sono le configurazioni WireGuard salvate, una per una. Un'azione
  // che il pacchetto installato non conosce non compare, e il nome di un tunnel
  // lo mette il router perche' l'ha scritto una persona.
  const options =
    config && config.actions.map((id) => ({ id, label: toggleLabel(id, config.names) }));

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
