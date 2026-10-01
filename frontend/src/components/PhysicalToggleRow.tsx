import { useEffect, useRef, useState } from 'preact/hooks';
import { getToggle, positionLabel, setToggle, toggleLabel } from '../lib/toggle';
import type { ToggleAction, ToggleConfig } from '../lib/toggle';
import { commonText } from '../i18n/common';
import { componentsText } from '../i18n/components';

/**
 * Stesso passo della riga del LED, e per lo stesso motivo: la levetta si muove
 * sul fianco del router, non da qui, e una riga che dice OFF mentre sta su e'
 * peggio di una che non dice niente.
 */
const REREAD_MS = 5000;

/**
 * L'ultimo errore, con da dove viene.
 *
 * Serve alle riletture di fondo: quella di una lettura lo smentiscono da sole
 * appena il router torna a rispondere, quella di una scrittura no. Sono due
 * cose diverse - la prima dice che la riga non sa niente, la seconda che la
 * scelta non e' stata salvata - e solo la prima smette di essere vera perche'
 * il giro dopo e' andato bene.
 */
interface Failure {
  message: string;
  /** L'errore e' di un salvataggio, non di una lettura. */
  write: boolean;
}

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
  const [error, setError] = useState<Failure | null>(null);
  const pending = useRef(false);
  const reading = useRef(false);
  const writes = useRef(0);
  const mounted = useRef(false);

  const run = async (action?: ToggleAction) => {
    if (pending.current) return;
    pending.current = true;
    if (action !== undefined) writes.current += 1;
    setBusy(true);
    setError(null);
    try {
      const result = action === undefined ? await getToggle() : await setToggle(action);
      if (mounted.current) setConfig(result);
      onConfig?.(result, action !== undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (mounted.current) setError({ message, write: action !== undefined });
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  /**
   * Riletture di fondo: servono alla posizione, che cambia senza passare di qui.
   *
   * Non toccano `busy` - nessuno vuole il menu che si disabilita da solo ogni
   * cinque secondi - e si tirano indietro davanti a una scrittura, anche quando
   * e' cominciata mentre la lettura era gia' per strada: e' il caso in cui una
   * risposta vecchia rimetterebbe l'elenco sulla funzione di prima.
   *
   * Una lettura per volta, e chi arriva mentre una e' in corso lascia perdere:
   * a differenza del LED qui non c'e' niente da riallineare in fretta, e il giro
   * dopo e' a cinque secondi.
   */
  const reread = async () => {
    if (pending.current || reading.current) return;
    reading.current = true;
    const seen = writes.current;
    try {
      const result = await getToggle();
      if (!mounted.current || pending.current || writes.current !== seen) return;
      setConfig(result);
      // Il router ha risposto: un "non disponibile" di prima adesso e' falso, e
      // lasciarlo acceso sopra una riga che funziona sarebbe peggio che non
      // averlo mai mostrato. Quello di un salvataggio invece resta: dice che la
      // scelta non e' stata scritta, ed e' ancora vero - toglierlo da solo dopo
      // cinque secondi lascerebbe il menu tornato indietro senza un perche'.
      setError((current) => (current?.write ? current : null));
      // Non e' stato riallineato niente: si e' solo guardato. Chi mostra il LED
      // rilegge per conto suo, e va avvisato solo se e' cambiato chi comanda.
      onConfig?.(result, false);
    } catch {
      // Una lettura periodica andata male non cancella l'ultimo valore certo.
    } finally {
      reading.current = false;
    }
  };

  useEffect(() => {
    mounted.current = true;
    void run();
    // Le due regole del budget di polling, come in `usePoll`: ferma a scheda
    // nascosta, e una rilettura appena si torna a guardare.
    const tick = () => { if (!document.hidden) void reread(); };
    const timer = setInterval(tick, REREAD_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);

  // Le voci le decide il router, e adesso non sono piu' solo quelle fisse: fra
  // di esse ci sono le configurazioni WireGuard salvate, una per una. Un'azione
  // che il pacchetto installato non conosce non compare, e il nome di un tunnel
  // lo mette il router perche' l'ha scritto una persona.
  const t = componentsText();
  const options =
    config && config.actions.map((id) => ({ id, label: toggleLabel(id, config.names) }));

  return (
    <>
      <label class="row" aria-busy={busy}>
        {/* La posizione sta dalla parte del nome e non in quella del menu:
            a destra c'e' quello che si sceglie, a sinistra quello che si legge
            e basta. Verde quando la levetta e' su, perche' e' li' che la
            funzione scelta e' in atto; spenta quando e' giu' o quando il router
            non l'ha ancora vista, che sono i due casi in cui non sta facendo
            niente. */}
        <span class="row__label row__label--state">
          {t.toggle.label}
          {config && (
            <span
              class={config.position === 'on' ? 'badge badge--ok' : 'badge badge--muted'}
              title={config.position === 'unknown' ? t.toggle.unknownHint : t.toggle.positionHint}
            >
              {positionLabel(config.position)}
            </span>
          )}
        </span>
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
          <span class="row__value">{error ? t.unavailable : t.loading}</span>
        )}
      </label>

      {error && <p class="alert alert--error" role="alert">{error.message}</p>}
      {error && !config && (
        <button class="button button--ghost" disabled={busy} onClick={() => void run()}>
          {commonText().actions.retry}
        </button>
      )}
    </>
  );
}
