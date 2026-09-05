import { useState } from 'preact/hooks';
import { resetPenalties, updateSettings } from '../lib/autoreconnect';
import type { DaemonStatus } from '../lib/autoreconnect';
import type { SavedNetwork } from '../lib/networks';

function ago(epoch: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epoch);
  if (seconds < 60) return `${seconds}s fa`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m fa`;
  return `${Math.floor(seconds / 3600)}h fa`;
}

function inFuture(epoch: number): string {
  const seconds = Math.max(0, epoch - Math.floor(Date.now() / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)} min`;
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
  const [busy, setBusy] = useState(false);

  if (!daemon) {
    return (
      <section class="card">
        <h2 class="uplink__title">Riconnessione automatica</h2>
        <p class="muted">
          travelD non risponde. Le connessioni manuali funzionano lo stesso: il servizio
          serve solo alla riconnessione automatica.
        </p>
        {/* Il motivo esatto: "permesso negato" e "oggetto non trovato" hanno
            rimedi opposti, e senza il codice si tira a indovinare. */}
        {error && <p class="alert alert--warn alert--code">{error}</p>}
        <p class="muted">
          Dal terminale: <code>/etc/init.d/travel restart</code> e poi{' '}
          <code>logread | grep traveld</code>.
        </p>
      </section>
    );
  }

  const nameOf = (section: string) =>
    saved.find((n) => n.section === section)?.ssid ?? section;

  const penalised = Object.entries(daemon.networks);
  const now = Math.floor(Date.now() / 1000);

  return (
    <section class={`card uplink uplink--${daemon.enabled ? 'addressed' : 'disabled'}`}>
      <header class="radio__head">
        <h2 class="uplink__title">
          Riconnessione automatica {daemon.enabled ? 'attiva' : 'spenta'}
        </h2>
        <button class="button button--ghost" onClick={onEdit}>
          Impostazioni
        </button>
      </header>

      {daemon.enabled ? (
        <p class="muted">
          Sceglie fra le reti salvate quella con priorità più alta fra le visibili sopra i{' '}
          {daemon.settings.rssi_min} dBm.{' '}
          {daemon.settings.roam_mode === 'best'
            ? 'Passa a una rete migliore se ne compare una.'
            : 'Una volta connessa non cambia rete da sola.'}
        </p>
      ) : (
        <p class="muted">
          Nessuna connessione viene fatta o cambiata da sola. Accendila dalle impostazioni.
        </p>
      )}

      {penalised.length > 0 && (
        <>
          <h2>Reti messe da parte</h2>
          {penalised.map(([section, penalty]) => (
            <div class="row" key={section}>
              <span class="row__label">{nameOf(section)}</span>
              <span class="row__value">
                {penalty.blacklisted_until > now
                  ? `in blacklist ancora ${inFuture(penalty.blacklisted_until)}`
                  : penalty.next_try > now
                    ? `riprova fra ${inFuture(penalty.next_try)}`
                    : 'in attesa'}
                {penalty.fails > 0 ? ` · ${penalty.fails} tentativi falliti` : ''}
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
            Azzera contatori e blacklist
          </button>
        </>
      )}

      {daemon.events.length > 0 && (
        <>
          <h2>Ultimi eventi</h2>
          <ul class="events">
            {daemon.events.slice(0, 6).map((event, i) => (
              <li key={`${event.at}-${i}`}>
                <span class="events__when">{ago(event.at)}</span> {event.message}
              </li>
            ))}
          </ul>
        </>
      )}

      {daemon.last_error && (
        <p class="alert alert--warn alert--code">{daemon.last_error}</p>
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
        <h2>Riconnessione automatica</h2>

        <form onSubmit={save}>
          <label class="check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled((e.target as HTMLInputElement).checked)}
            />
            <span>
              Riconnettiti da solo alla rete salvata migliore fra quelle visibili. Gli
              access point non vengono mai toccati.
            </span>
          </label>

          <label class="field">
            <span>Segnale minimo accettabile</span>
            <select value={rssi} onChange={(e) => setRssi((e.target as HTMLSelectElement).value)}>
              <option value="-65">-65 dBm · solo reti forti</option>
              <option value="-72">-72 dBm · buone</option>
              <option value="-78">-78 dBm · consigliato</option>
              <option value="-85">-85 dBm · anche deboli</option>
            </select>
            <span class="muted">
              Una rete sotto questa soglia viene ignorata: agganciarla darebbe una
              connessione che cade in continuazione.
            </span>
          </label>

          <label class="field">
            <span>Se compare una rete a priorità più alta</span>
            <select value={roam} onChange={(e) => setRoam((e.target as HTMLSelectElement).value)}>
              <option value="stay">Resta su quella attuale</option>
              <option value="best">Passa alla migliore</option>
            </select>
            <span class="muted">
              "Resta" evita che la connessione si interrompa mentre la stai usando.
            </span>
          </label>

          <label class="field">
            <span>Metti da parte una rete dopo</span>
            <select
              value={after}
              onChange={(e) => setAfter((e.target as HTMLSelectElement).value)}
            >
              <option value="2">2 tentativi falliti</option>
              <option value="3">3 tentativi falliti</option>
              <option value="5">5 tentativi falliti</option>
            </select>
          </label>

          <label class="field">
            <span>e riprovala dopo</span>
            <select value={ttl} onChange={(e) => setTtl((e.target as HTMLSelectElement).value)}>
              <option value="300">5 minuti</option>
              <option value="600">10 minuti</option>
              <option value="1800">30 minuti</option>
              <option value="3600">un'ora</option>
            </select>
          </label>

          {error && <p class="alert alert--error alert--code">{error}</p>}

          <div class="sheet__actions">
            <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
              Annulla
            </button>
            <button class="button button--primary" type="submit" disabled={busy}>
              Salva
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
