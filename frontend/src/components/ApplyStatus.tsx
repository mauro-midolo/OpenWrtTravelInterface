import type { Apply } from '../lib/apply';

/**
 * Le fasi comuni a ogni modifica rischiosa: attesa, ritorno indietro, errore.
 * Le usano sia la connessione a una rete sia l'accensione dell'access point,
 * perche' entrambe possono chiudere fuori chi le sta lanciando.
 */
export function ApplyStatus({ apply, onClose }: { apply: Apply; onClose: () => void }) {
  if (apply.phase === 'applying') {
    return <p class="muted">Applico la configurazione…</p>;
  }

  if (apply.phase === 'waiting') {
    return (
      <>
        <p class="countdown">{apply.left}s</p>
        <p class="muted">
          Se la pagina non risponde, allo scadere il router torna alla configurazione
          precedente.
        </p>
        <div class="sheet__actions">
          <button class="button button--ghost" type="button" onClick={() => void apply.abort()}>
            Annulla subito
          </button>
        </div>
      </>
    );
  }

  if (apply.phase === 'rolledback') {
    return (
      <>
        <p class="alert alert--error">
          Nessuna conferma in tempo: il router è tornato alla configurazione precedente.
        </p>
        <div class="sheet__actions">
          <button class="button button--primary" onClick={onClose}>
            Chiudi
          </button>
        </div>
      </>
    );
  }

  if (apply.phase === 'error') {
    return (
      <>
        <p class="alert alert--error alert--code">{apply.error}</p>
        <div class="sheet__actions">
          <button class="button button--primary" onClick={onClose}>
            Chiudi
          </button>
        </div>
      </>
    );
  }

  return null;
}
