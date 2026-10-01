import { useState } from 'preact/hooks';
import { resetPenalties, updateSettings } from '../lib/autoreconnect';
import type { DaemonStatus } from '../lib/autoreconnect';
import type { SavedNetwork } from '../lib/networks';
import { commonText } from '../i18n/common';
import { autoText, daemonMessage } from '../i18n/auto';

function ago(epoch: number): string {
  const t = autoText();
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epoch);
  if (seconds < 60) return t.secondsAgo(seconds);
  if (seconds < 3600) return t.minutesAgo(Math.floor(seconds / 60));
  return t.hoursAgo(Math.floor(seconds / 3600));
}

function inFuture(epoch: number): string {
  const seconds = Math.max(0, epoch - Math.floor(Date.now() / 1000));
  if (seconds < 60) return `${seconds}s`;
  return autoText().minutes(Math.ceil(seconds / 60));
}

export function AutoCard({
  daemon,
  error,
  saved,
  onEdit,
  onChanged,
}: {
  daemon: DaemonStatus | null;
  error: string | null;
  saved: SavedNetwork[];
  onEdit: () => void;
  onChanged: () => void;
}) {
  const t = autoText();
  const [busy, setBusy] = useState(false);

  if (!daemon) {
    return (
      <section class="card">
        <h2 class="uplink__title">{t.title}</h2>
        <p class="muted">{t.noDaemon}</p>
        {/* Il motivo esatto: "permesso negato" e "oggetto non trovato" hanno
            rimedi opposti, e senza il codice si tira a indovinare. */}
        {error && <p class="alert alert--warn alert--code">{error}</p>}
      </section>
    );
  }

  /**
   * Il nome di una rete messa da parte, dalla chiave "sezione@banda".
   *
   * travelD conta i fallimenti per rete E per banda, e la chiave lo porta con
   * se': la stessa rete salvata su tutte e due puo' essere fuori portata a 5
   * GHz e funzionare benissimo a 2.4. Mostrando la sola rete si direbbe che e'
   * stata messa da parte tutta, che e' falso e manda a cercare un guasto che
   * non c'e'.
   */
  const nameOf = (key: string) => {
    const at = key.lastIndexOf('@');
    if (at < 0) return saved.find((n) => n.section === key)?.ssid ?? key;

    const section = key.slice(0, at);
    const band = key.slice(at + 1);
    const ssid = saved.find((n) => n.section === section)?.ssid ?? section;
    // Una radio che non dichiara la banda finisce nella chiave col proprio
    // nome: si riporta com'e' invece di scrivere "radio0 GHz".
    return band === '2.4' || band === '5' ? `${ssid} · ${band} GHz` : `${ssid} · ${band}`;
  };

  const penalised = Object.entries(daemon.networks);
  const now = Math.floor(Date.now() / 1000);

  return (
    <section class={`card uplink uplink--${daemon.enabled ? 'addressed' : 'disabled'}`}>
      <header class="radio__head">
        <h2 class="uplink__title">{t.state(daemon.enabled)}</h2>
        <button class="button button--ghost" onClick={onEdit}>
          {t.settings}
        </button>
      </header>

      {daemon.enabled && (
        <p class="muted">
          {t.minSignal(daemon.settings.rssi_min)} ·{' '}
          {daemon.settings.roam_mode === 'best' ? t.roamBest : t.roamStay}
        </p>
      )}

      {penalised.length > 0 && (
        <>
          <h2>{t.penalised}</h2>
          {penalised.map(([section, penalty]) => (
            <div class="row" key={section}>
              <span class="row__label">{nameOf(section)}</span>
              <span class="row__value">
                {penalty.blacklisted_until > now
                  ? t.blacklisted(inFuture(penalty.blacklisted_until))
                  : penalty.next_try > now
                    ? t.retryIn(inFuture(penalty.next_try))
                    : t.waiting}
                {penalty.fails > 0 ? t.fails(penalty.fails) : ''}
              </span>
            </div>
          ))}
          <button
            class="button button--ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await resetPenalties();
                onChanged();
              } finally {
                setBusy(false);
              }
            }}
          >
            {t.reset}
          </button>
        </>
      )}

      {daemon.events.length > 0 && (
        <>
          <h2>{t.events}</h2>
          <ul class="events">
            {daemon.events.slice(0, 6).map((event, i) => (
              <li key={`${event.at}-${i}`}>
                <span class="events__when">{ago(event.at)}</span> {daemonMessage(event)}
              </li>
            ))}
          </ul>
        </>
      )}

      {daemon.last_error && (
        <p class="alert alert--warn alert--code">
          {daemonMessage({
            message: daemon.last_error,
            code: daemon.last_error_code,
            params: daemon.last_error_params,
          })}
        </p>
      )}
    </section>
  );
}

export function AutoSheet({
  daemon,
  onClose,
}: {
  daemon: DaemonStatus;
  onClose: (changed: boolean) => void;
}) {
  const t = autoText();
  const actions = commonText().actions;
  const s = daemon.settings;
  const [enabled, setEnabled] = useState(s.autoreconnect);
  const [rssi, setRssi] = useState(String(s.rssi_min));
  const [roam, setRoam] = useState(s.roam_mode === 'best' ? 'best' : 'stay');
  const [after, setAfter] = useState(String(s.blacklist_after));
  const [ttl, setTtl] = useState(String(s.blacklist_ttl));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await updateSettings({
        autoreconnect: enabled ? '1' : '0',
        rssi_min: rssi,
        roam_mode: roam,
        blacklist_after: after,
        blacklist_ttl: ttl,
      });
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{t.title}</h2>

        <form onSubmit={save}>
          <label class="check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled((e.target as HTMLInputElement).checked)}
            />
            <span>{t.title}</span>
          </label>

          <label class="field">
            <span>{t.minSignalField}</span>
            <select value={rssi} onChange={(e) => setRssi((e.target as HTMLSelectElement).value)}>
              <option value="-65">{t.rssi65}</option>
              <option value="-72">{t.rssi72}</option>
              <option value="-78">{t.rssi78}</option>
              <option value="-85">{t.rssi85}</option>
            </select>
          </label>

          <label class="field">
            <span>{t.roamField}</span>
            <select value={roam} onChange={(e) => setRoam((e.target as HTMLSelectElement).value)}>
              <option value="stay">{t.stay}</option>
              <option value="best">{t.best}</option>
            </select>
          </label>

          <label class="field">
            <span>{t.afterField}</span>
            <select
              value={after}
              onChange={(e) => setAfter((e.target as HTMLSelectElement).value)}
            >
              <option value="2">{t.failed(2)}</option>
              <option value="3">{t.failed(3)}</option>
              <option value="5">{t.failed(5)}</option>
            </select>
          </label>

          <label class="field">
            <span>{t.ttlField}</span>
            <select value={ttl} onChange={(e) => setTtl((e.target as HTMLSelectElement).value)}>
              <option value="300">{t.ttl5}</option>
              <option value="600">{t.ttl10}</option>
              <option value="1800">{t.ttl30}</option>
              <option value="3600">{t.ttl60}</option>
            </select>
          </label>

          {error && <p class="alert alert--error alert--code">{error}</p>}

          <div class="sheet__actions">
            <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
              {actions.cancel}
            </button>
            <button class="button button--primary" type="submit" disabled={busy}>
              {actions.save}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
