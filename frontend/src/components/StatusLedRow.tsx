import { useEffect, useRef, useState } from 'preact/hooks';
import { getStatusLed, setStatusLed } from '../lib/led';
import type { StatusLedState } from '../lib/led';
import { commonText } from '../i18n/common';
import { componentsText } from '../i18n/components';

/**
 * Stesso passo della schermata che ospita la riga. Il LED non cambia in fretta,
 * ma da quando la levetta puo' accenderlo non cambia piu' soltanto da qui.
 */
const REREAD_MS = 5000;

/**
 * Il LED di stato sta fra i dati del dispositivo, non in una scheda sua: e'
 * una preferenza da toccare una volta - spegnerlo di notte in albergo - e in
 * una scheda a parte pesava piu' di quanto conti. L'interruttore prende il
 * posto del valore, come le altre righe.
 */
export function StatusLedRow({ refresh = 0, locked = false }: {
  refresh?: number;
  /**
   * Il LED lo comanda la levetta: da qui si guarda e basta.
   *
   * Blocca soltanto la mano dell'utente, non le riletture: la riga deve
   * continuare a dire dove sta il LED, ed e' anzi l'unico modo che ha di
   * seguire una levetta che si muove senza passare da qui.
   */
  locked?: boolean;
}) {
  const [state, setState] = useState<StatusLedState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const reading = useRef(false);
  const queued = useRef(false);
  const writes = useRef(0);
  const era = useRef(0);
  const mounted = useRef(false);

  // Quello che chiede l'utente: primo caricamento, "Riprova", e il comando.
  const run = async (enabled?: boolean) => {
    if (pending.current) return;
    pending.current = true;
    if (enabled !== undefined) writes.current += 1;
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

  /**
   * Riletture di fondo: la levetta fisica accende e spegne il LED senza passare
   * di qui, e una riga che sostiene il contrario e' peggio di una che tace.
   *
   * Non toccano `busy` - nessuno vuole il comando che si disabilita da solo
   * ogni cinque secondi - e si tirano indietro davanti a una scrittura, anche
   * quando e' cominciata mentre la lettura era gia' per strada: e' il caso in
   * cui una risposta vecchia rimetterebbe il segno di spunta dov'era.
   *
   * Una lettura per volta, e chi arriva mentre una e' in corso non se ne va a
   * mani vuote: si mette in coda. Buttare via la richiesta lascerebbe la riga
   * ferma sulla risposta di prima, che e' proprio quella superata.
   */
  const reread = async () => {
    if (pending.current) return;
    if (reading.current) { queued.current = true; return; }
    reading.current = true;
    const seen = writes.current;
    const asked = era.current;
    try {
      const result = await getStatusLed();
      const current = mounted.current && !pending.current &&
        writes.current === seen && era.current === asked;
      if (current) setState(result);
    } catch {
      // Una lettura periodica andata male non cancella l'ultimo valore certo.
    } finally {
      reading.current = false;
      if (queued.current && mounted.current) {
        queued.current = false;
        void reread();
      }
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

  // Qualcun altro ha appena mosso il LED - la funzione data alla levetta lo
  // allinea subito alla sua posizione - e aspettare il giro dopo vorrebbe dire
  // tenere per cinque secondi una riga che dice il falso.
  //
  // Una lettura gia' partita e' stata chiesta prima dell'allineamento, quindi
  // la sua risposta nasce vecchia: si cambia epoca per non lasciargliela
  // scrivere, e la rilettura si accoda dietro di lei.
  useEffect(() => {
    if (refresh === 0) return;
    era.current += 1;
    void reread();
  }, [refresh]);

  // Senza LED non c'e' niente da accendere: la riga dice quello che sa, come fa
  // "Temperatura". Finche' la lettura non e' tornata non si dice ancora niente.
  const t = componentsText();
  const usable = !!state?.supported;
  // Niente da premere: o non c'e' un LED, o non e' piu' questa riga a
  // comandarlo. In tutti e due i casi la riga non deve invitare a cliccarla.
  const interactive = usable && !locked;

  return (
    <>
      <label
        class={interactive ? 'row' : 'row row--readonly'}
        aria-busy={busy}
        title={usable && locked ? t.led.byToggle : undefined}
      >
        <span class="row__label">{t.led.label}</span>
        {usable ? (
          <input
            class="row__toggle"
            type="checkbox"
            checked={state!.enabled}
            disabled={busy || locked}
            onChange={(e) => void run((e.target as HTMLInputElement).checked)}
          />
        ) : (
          <span class="row__value">{state || error ? t.unavailable : t.loading}</span>
        )}
      </label>

      {/* Un errore invece si dice: senza, l'interruttore tornerebbe indietro
          da solo e sembrerebbe rotto. */}
      {error && <p class="alert alert--error" role="alert">{error}</p>}
      {error && !state && (
        <button class="button button--ghost" disabled={busy} onClick={() => void run()}>
          {commonText().actions.retry}
        </button>
      )}
    </>
  );
}
