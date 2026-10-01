/** Condivisione su richiesta della sola rete salvata selezionata. */
import { useEffect, useState } from 'preact/hooks';
import { bandsLabel, readShareNetwork } from '../lib/networks';
import type { SavedNetwork } from '../lib/networks';
import { encryptionLabel } from '../lib/wifi';
import { qrMatrix, qrPath, qrSide } from '../lib/qr';
import { wifiUri } from '../lib/share';

type ShareProps = { net: SavedNetwork; onClose: () => void };
type ShareData = Awaited<ReturnType<typeof readShareNetwork>>;

export function ShareSheet(props: ShareProps) {
  // Cambiando rete si eliminano subito dati e stato di visibilità precedenti.
  return <ShareContent key={props.net.section} {...props} />;
}

function ShareContent({ net, onClose }: ShareProps) {
  const [data, setData] = useState<{ network: ShareData; matrix: boolean[][] } | null>(null);
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setShown(false);
    setError(null);
    // Una sola lettura aggiornata: mai combinare la chiave con un vecchio SSID.
    void readShareNetwork(net.section)
      .then((network) => {
        if (cancelled) return;
        const matrix = qrMatrix(wifiUri(network));
        setData({ network, matrix });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [net.section, attempt]);

  const network = data?.network;
  const side = data ? qrSide(data.matrix) : 0;
  const open = network?.encryption === 'none';

  return (
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="share-title">
      <div class="sheet__panel card">
        <h2 id="share-title">Condividi {network?.ssid ?? net.ssid}</h2>

        {error && <p class="alert alert--error alert--code" role="alert">{error}</p>}
        {!data && !error && <p class="muted" role="status">Leggo la rete salvata dal router…</p>}

        {data && network && (
          <>
            <p class="muted">
              {encryptionLabel(network.encryption)} · {bandsLabel(network.bands)}
              {network.hidden ? ' · rete nascosta' : ''}
            </p>
            <div class="qr-wrap">
              <svg
                class="qr"
                viewBox={`0 0 ${side} ${side}`}
                role="img"
                aria-label={`Codice QR per collegarsi a ${network.ssid}`}
                shape-rendering="crispEdges"
              >
                <rect width={side} height={side} fill="#ffffff" />
                <path d={qrPath(data.matrix)} fill="#000000" />
              </svg>
            </div>

            {open ? (
              <p class="muted">Rete aperta, senza password.</p>
            ) : (
              <>
                <div class="field">
                  <span>Password</span>
                  {shown ? (
                    <code class="secret">{network.key}</code>
                  ) : (
                    <code class="secret secret--masked" aria-label="Password nascosta">
                      ••••••••••
                    </code>
                  )}
                  <div class="radio__actions">
                    <button
                      class="button button--ghost"
                      aria-pressed={shown}
                      onClick={() => setShown(!shown)}
                    >
                      {shown ? 'Nascondi password' : 'Mostra password'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        <div class="sheet__actions">
          {error && (
            <button class="button button--ghost" onClick={() => setAttempt(attempt + 1)}>
              Riprova
            </button>
          )}
          <button class="button button--primary" onClick={onClose}>Chiudi</button>
        </div>
      </div>
    </div>
  );
}
