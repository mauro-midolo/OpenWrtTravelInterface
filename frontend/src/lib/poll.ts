import { useEffect, useRef, useState } from 'preact/hooks';

export interface PollState<T> {
  data: T | null;
  error: Error | null;
  /** true finche' non e' arrivata la prima risposta. */
  loading: boolean;
  refresh: () => void;
}

/**
 * Interroga il router a intervalli regolari.
 *
 * Applica fin da subito le due regole del budget di polling (decisione D4):
 * si ferma quando la scheda non e' visibile — sul telefono succede in
 * continuazione — e non sovrappone mai due richieste. Il costo per il router
 * resta quindi una richiesta ogni `intervalMs`, e zero mentre non guardi.
 */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      if (document.hidden) {
        schedule();
        return;
      }
      try {
        const result = await fnRef.current();
        if (cancelled) return;
        setData(result);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) {
          setLoading(false);
          schedule();
        }
      }
    };

    // Il timer riparte solo a richiesta conclusa: niente richieste sovrapposte
    // se il router e' lento o irraggiungibile.
    const schedule = () => {
      timer = setTimeout(run, intervalMs);
    };

    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void run();
      }
    };

    void run();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, tick]);

  return { data, error, loading, refresh: () => setTick((n) => n + 1) };
}
