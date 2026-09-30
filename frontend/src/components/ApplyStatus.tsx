import type { Apply } from '../lib/apply';
import { commonText } from '../i18n/common';
import { componentsText } from '../i18n/components';

/**
 * Le fasi comuni a ogni modifica rischiosa: attesa, ritorno indietro, errore.
 * Le usano sia la connessione a una rete sia l'accensione dell'access point,
 * perche' entrambe possono chiudere fuori chi le sta lanciando.
 */
export function ApplyStatus({ apply, onClose }: { apply: Apply; onClose: () => void }) {
  const t = componentsText().apply;
  const close = commonText().actions.close;
  if (apply.phase === 'applying') {
    return <p class="muted">{t.applying}</p>;
  }

  if (apply.phase === 'waiting') {
    return (
      <>
        <p class="countdown">{apply.left}s</p>
        <p class="muted">{t.waiting}</p>
        <div class="sheet__actions">
          <button class="button button--ghost" type="button" onClick={() => void apply.abort()}>
            {t.abort}
          </button>
        </div>
      </>
    );
  }

  if (apply.phase === 'rolledback') {
    return (
      <>
        <p class="alert alert--error">{t.rolledBack}</p>
        <div class="sheet__actions">
          <button class="button button--primary" onClick={onClose}>
            {close}
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
            {close}
          </button>
        </div>
      </>
    );
  }

  return null;
}
