import { useEffect, useState } from 'preact/hooks';
import { useApply } from '../lib/apply';
import {
  bandLabel,
  bandSiblings,
  deleteNetwork,
  groupByBand,
  hostnameOf,
  markUsed,
  reorder,
  stageConnectSaved,
  updateNetwork,
} from '../lib/networks';
import type { SavedNetwork } from '../lib/networks';
import { encryptionLabel, wirelessCameUp } from '../lib/wifi';
import type { Radio } from '../lib/wifi';
import { getSystem, hostnameLabel, isValidHostname } from '../lib/hostname';
import type { HostnameChoice } from '../lib/hostname';
import { HostnamePicker } from '../components/HostnamePicker';
import { ApplyStatus } from '../components/ApplyStatus';

function whenUsed(epoch: number): string {
  if (!epoch) return 'mai usata';
  const days = Math.floor((Date.now() / 1000 - epoch) / 86400);
  if (days <= 0) return 'usata oggi';
  if (days === 1) return 'usata ieri';
  if (days < 30) return `usata ${days} giorni fa`;
  return `usata il ${new Date(epoch * 1000).toLocaleDateString('it-IT')}`;
}

const RESULT_LABEL: Record<string, string> = {
  ok: 'ultima volta: connessa',
  // Connessa e senza Internet: e' un esito a se', ed e' quello che conviene
  // sapere prima di ricollegarsi - dice che servira' di nuovo un login.
  portal: 'ultima volta: portale di accesso',
  'no-address': 'ultima volta: senza indirizzo',
  unassociated: 'ultima volta: non agganciata',
};

export function SavedCard({
  saved,
  onPick,
}: {
  saved: SavedNetwork[];
  onPick: (net: SavedNetwork) => void;
}) {
  if (saved.length === 0) {
    return (
      <section class="card">
        <h2 class="uplink__title">Reti salvate</h2>
        <p class="muted">
          Nessuna. Quando ti colleghi a una rete puoi salvarla, e la ritrovi qui la volta
          dopo senza ridigitare la password.
        </p>
      </section>
    );
  }

  return (
    <section class="card">
      <h2 class="uplink__title">Reti salvate</h2>
      <p class="muted">
        Una lista per banda, ordinabili separatamente. Ogni radio sceglie dalla lista della
        sua banda, quindi la stessa rete può stare in tutte e due con priorità diverse.
      </p>

      {/* Un gruppo per banda invece di un elenco unico: le due radio scelgono
          in modo indipendente, e un elenco solo suggeriva il contrario. */}
      {groupByBand(saved).map((group) => (
        <div key={group.band}>
          <h3 class="group__title">{bandLabel(group.band)}</h3>
          {group.networks.length === 0 ? (
            <p class="muted">
              Nessuna rete salvata su questa banda. Collegati a una rete{' '}
              {group.band ? `a ${group.band} GHz` : ''} e salvala per averla qui.
            </p>
          ) : (
            <ul class="list list--flush">
              {group.networks.map((net, index) => (
                <li key={net.section}>
                  <button class="net" onClick={() => onPick(net)}>
                    <span class="net__main">
                      <span class={net.disabled ? 'net__ssid net__ssid--hidden' : 'net__ssid'}>
                        {index + 1}. {net.ssid}
                      </span>
                      <span class="net__meta">
                        {encryptionLabel(net.encryption)} · {whenUsed(net.last_used)}
                        {net.note ? ` · ${net.note}` : ''}
                      </span>
                    </span>
                    <span class="net__side">
                      {net.disabled && <span class="badge badge--warn">disattivata</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

type Mode = 'menu' | 'edit' | 'connecting';

export function SavedSheet({
  net,
  saved,
  radios,
  onClose,
}: {
  net: SavedNetwork;
  saved: SavedNetwork[];
  radios: Radio[];
  onClose: (changed: boolean) => void;
}) {
  const apply = useApply();
  const [mode, setMode] = useState<Mode>('menu');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState(net.note);
  const [hostname, setHostname] = useState<HostnameChoice>(() => hostnameOf(net));
  const [deviceHostname, setDeviceHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  // Solo per dire cosa verrebbe inviato scegliendo "nome del router".
  useEffect(() => {
    let cancelled = false;
    void getSystem()
      .then((info) => !cancelled && setDeviceHostname(info.hostname))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const hostnameOk = hostname.mode !== 'custom' || isValidHostname(hostname.value.trim());

  // Si sposta dentro la propria banda: e' l'insieme fra cui la radio sceglie,
  // e spostarsi rispetto a una rete che l'altra radio non vedra' mai non
  // vorrebbe dire niente.
  const siblings = bandSiblings(saved, net);
  const index = siblings.findIndex((n) => n.section === net.section);

  // La banda salvata dice su quale radio va la STA. Senza, si prende la prima
  // radio disponibile e lo si dice invece di sceglierla in silenzio.
  const target =
    radios.find((r) => r.band === net.band) ?? radios.find((r) => r.band === '5') ?? radios[0];

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const connect = async () => {
    if (!target) {
      setError('Nessuna radio disponibile.');
      return;
    }
    setMode('connecting');
    const ok = await apply.run(() => stageConnectSaved(net.section, target.name), {
      verify: wirelessCameUp,
    });
    if (ok) {
      setConnected(true);
      // L'esito fine (indirizzo o no) lo si vede nella scheda dell'uplink:
      // qui basta annotare che la rete e' stata usata.
      void markUsed(net.section, 'ok').catch(() => undefined);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{net.ssid}</h2>

        {mode === 'menu' && (
          <>
            <p class="muted">
              {encryptionLabel(net.encryption)} · {bandLabel(net.band)} ·{' '}
              {whenUsed(net.last_used)}
              {net.last_result && RESULT_LABEL[net.last_result]
                ? ` · ${RESULT_LABEL[net.last_result]}`
                : ''}
            </p>

            {target && (
              <p class="muted">
                Si collegherà usando la radio {target.band ?? target.name} GHz.
              </p>
            )}

            <p class="muted">
              Nome inviato nel DHCP: {hostnameLabel(hostnameOf(net), deviceHostname)}.
            </p>

            {error && <p class="alert alert--error alert--code">{error}</p>}

            <div class="radio__actions">
              <button class="button button--primary" disabled={busy} onClick={connect}>
                Connetti
              </button>
              <button class="button button--ghost" disabled={busy} onClick={() => setMode('edit')}>
                Modifica
              </button>
              <button
                class="button button--ghost"
                disabled={busy || index <= 0}
                onClick={() => void guard(() => reorder(siblings, net.section, -1))}
              >
                Sposta su
              </button>
              <button
                class="button button--ghost"
                disabled={busy || index < 0 || index >= siblings.length - 1}
                onClick={() => void guard(() => reorder(siblings, net.section, 1))}
              >
                Sposta giù
              </button>
              <button
                class="button button--ghost"
                disabled={busy}
                onClick={() =>
                  void guard(() =>
                    updateNetwork(net.section, { disabled: net.disabled ? '0' : '1' }),
                  )
                }
              >
                {net.disabled ? 'Riattiva' : 'Disattiva'}
              </button>
              <button
                class="button button--ghost"
                disabled={busy}
                onClick={() => void guard(() => deleteNetwork(net.section))}
              >
                Elimina
              </button>
            </div>

            <div class="sheet__actions">
              <button class="button button--ghost" onClick={() => onClose(false)}>
                Chiudi
              </button>
            </div>
          </>
        )}

        {mode === 'edit' && (
          <>
            <label class="field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                autocomplete="new-password"
                placeholder={
                  net.has_key ? 'lascia vuoto per non cambiarla' : 'almeno 8 caratteri'
                }
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              />
              <span class="muted">
                La password salvata non viene mostrata: non esce mai dal router.
              </span>
            </label>

            <HostnamePicker
              choice={hostname}
              deviceHostname={deviceHostname}
              onChange={setHostname}
            />

            <label class="field">
              <span>Nota</span>
              <input
                type="text"
                value={note}
                placeholder="es. hotel di Berlino, chiedere codice alla reception"
                onInput={(e) => setNote((e.target as HTMLInputElement).value)}
              />
            </label>

            {error && <p class="alert alert--error alert--code">{error}</p>}

            <div class="sheet__actions">
              <button class="button button--ghost" onClick={() => setMode('menu')}>
                Indietro
              </button>
              <button
                class="button button--primary"
                disabled={busy || !hostnameOk || (password !== '' && password.length < 8)}
                onClick={() =>
                  void guard(() =>
                    updateNetwork(net.section, {
                      note,
                      hostname_mode: hostname.mode,
                      hostname_value: hostname.mode === 'custom' ? hostname.value.trim() : '',
                      ...(password ? { key: password } : {}),
                    }),
                  )
                }
              >
                Salva
              </button>
            </div>
          </>
        )}

        {mode === 'connecting' && (
          <>
            <ApplyStatus apply={apply} onClose={() => onClose(true)} />
            {connected && (
              <>
                <p class="alert alert--ok">
                  Connessione applicata. L'esito lo trovi nella scheda dell'uplink.
                </p>
                <div class="sheet__actions">
                  <button class="button button--primary" onClick={() => onClose(true)}>
                    Chiudi
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
