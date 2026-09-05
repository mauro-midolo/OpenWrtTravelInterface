import { useCallback, useEffect, useState } from 'preact/hooks';
import { UbusError } from '../lib/ubus';
import { useApply } from '../lib/apply';
import {
  getAp,
  getUplinks,
  listRadios,
  planConnection,
  scanRadio,
  signalBars,
  stageApEnabled,
  stageDisconnect,
  uplinkState,
} from '../lib/wifi';
import type { ApSection, ConnectionPlan, Radio, ScanResult, Uplink, UplinkState } from '../lib/wifi';
import { listSaved } from '../lib/networks';
import type { SavedNetwork } from '../lib/networks';
import { getDaemon } from '../lib/autoreconnect';
import type { DaemonStatus } from '../lib/autoreconnect';
import { AutoCard, AutoSheet } from './AutoReconnect';
import { ConnectSheet } from './Connect';
import { ApCard, ApSheet } from './AccessPoint';
import { SavedCard, SavedSheet } from './SavedNetworks';
import { ApplyStatus } from '../components/ApplyStatus';
import { PORTAL_LABEL, getPortals } from '../lib/portal';
import type { PortalResult, PortalStatus } from '../lib/portal';

function Signal({ dbm }: { dbm: number }) {
  const bars = signalBars(dbm);
  return (
    // Il numero accanto alle tacche: su un telefono il tooltip non esiste, e
    // fra due reti "a tre tacche" il dBm e' l'unica cosa che le distingue.
    <span class="signal-group" aria-label={`segnale ${dbm} dBm`}>
      <span class="signal-group__dbm">{dbm}</span>
      <span class="signal" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <i key={n} class={n <= bars ? 'signal__bar signal__bar--on' : 'signal__bar'} />
        ))}
      </span>
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div class="row">
      <span class="row__label">{label}</span>
      <span class="row__value">{value}</span>
    </div>
  );
}

/**
 * Titolo dell'uplink.
 *
 * "Connesso" non e' "Connesso a Internet": avere un indirizzo non lo
 * garantisce, perche' un captive portal risponde al DHCP e blocca il resto. La
 * differenza fra i due la fa la verifica dell'uscita, che sta nella riga sotto:
 * il titolo continua a parlare del solo collegamento, che e' cio' che sa.
 */
function uplinkTitle(uplink: Uplink, state: UplinkState): string {
  const band = uplink.band ? `WiFi ${uplink.band} GHz` : `WiFi ${uplink.radio}`;
  switch (state) {
    case 'addressed':
      return `Connesso tramite ${band}`;
    case 'no-address':
      return `${band} senza indirizzo`;
    case 'disabled':
      return `${band} disattivata`;
    default:
      return `${band} non agganciata`;
  }
}

function UplinkCard({ uplink, portal }: { uplink: Uplink; portal: PortalResult | null }) {
  const state = uplinkState(uplink);

  return (
    <section class={`card uplink uplink--${state}`}>
      <h2 class="uplink__title">{uplinkTitle(uplink, state)}</h2>

      {/* Il verdetto sull'uscita, non solo sul collegamento. Qui si mostra e
          basta: rifare la verifica, aprire il portale e clonare un MAC stanno
          nella scheda Internet, che e' dove si va quando qualcosa non va. */}
      {state === 'addressed' && portal && (
        <p class={portal.state === 'online' ? 'alert alert--ok' : 'alert alert--warn'}>
          {PORTAL_LABEL[portal.state]}
          {portal.state === 'portal' && (
            <>
              {' — '}
              <a href={portal.url} target="_blank" rel="noreferrer">
                apri la pagina di accesso
              </a>
            </>
          )}
        </p>
      )}

      {state === 'addressed' || state === 'no-address' ? (
        <>
          <Row label="Rete" value={uplink.ssid ?? '—'} />
          <Row label="Indirizzo" value={uplink.ipv4 || 'nessuno'} />
          <Row label="Gateway" value={uplink.gateway || '—'} />
          <Row label="DNS" value={uplink.dns?.length ? uplink.dns.join('  ') : '—'} />
          <Row label="MAC in uso" value={uplink.mac || '—'} />
          {typeof uplink.signal === 'number' && (
            <Row label="Segnale" value={`${uplink.signal} dBm`} />
          )}
          {uplink.channel ? <Row label="Canale" value={String(uplink.channel)} /> : null}
        </>
      ) : (
        <p class="muted">
          {state === 'disabled'
            ? 'La rete è configurata ma disattivata.'
            : 'Configurata, ma la radio non è riuscita ad agganciare la rete. Di solito è la password.'}
        </p>
      )}
    </section>
  );
}

function Network({
  net,
  connected,
  onPick,
}: {
  net: ScanResult;
  connected: boolean;
  onPick: () => void;
}) {
  return (
    <li>
      <button class="net" onClick={onPick} disabled={net.hidden}>
        <span class="net__main">
          <span class={net.hidden ? 'net__ssid net__ssid--hidden' : 'net__ssid'}>
            {net.hidden ? 'rete nascosta' : net.ssid}
          </span>
          <span class="net__meta">
            ch {net.channel} · {net.security}
            {net.count > 1 && ` · ${net.count} punti di accesso`}
          </span>
        </span>
        <span class="net__side">
          {connected && <span class="badge badge--ok">collegata</span>}
          {net.open && <span class="badge badge--warn">aperta</span>}
          <Signal dbm={net.signal} />
        </span>
      </button>
    </li>
  );
}

interface Action {
  title: string;
  warn: string;
  stage: () => Promise<void>;
  verify?: () => Promise<boolean>;
}

/** Esegue una modifica rischiosa con conto alla rovescia e ritorno indietro. */
function ActionSheet({ action, onClose }: { action: Action; onClose: (c: boolean) => void }) {
  const apply = useApply();
  const [confirmed, setConfirmed] = useState(false);

  const go = async () => {
    if (await apply.run(action.stage, { verify: action.verify })) setConfirmed(true);
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{action.title}</h2>

        {apply.phase === 'idle' && (
          <>
            <p class="alert alert--warn">{action.warn}</p>
            <div class="sheet__actions">
              <button class="button button--ghost" onClick={() => onClose(false)}>
                Annulla
              </button>
              <button class="button button--primary" onClick={go}>
                Procedi
              </button>
            </div>
          </>
        )}

        <ApplyStatus apply={apply} onClose={() => onClose(true)} />

        {confirmed && (
          <>
            <p class="alert alert--ok">Fatto.</p>
            <div class="sheet__actions">
              <button class="button button--primary" onClick={() => onClose(true)}>
                Chiudi
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RadioCard({
  radio,
  uplink,
  results,
  scanning,
  blocked,
  onScan,
  onPick,
  onAp,
  onDisconnect,
}: {
  radio: Radio;
  uplink: Uplink | null;
  results: ScanResult[] | null;
  scanning: boolean;
  /** Un'altra radio sta scansionando: sono sulla stessa phy, si disturbano. */
  blocked: boolean;
  onScan: () => void;
  onPick: (net: ScanResult) => void;
  onAp: (enable: boolean) => void;
  onDisconnect: () => void;
}) {
  const busy = radio.staSection !== null;
  const label = radio.band ? `${radio.band} GHz` : radio.name;

  return (
    <section class="card">
      <header class="radio__head">
        <div>
          <h2 class="radio__title">{label}</h2>
          <p class="muted">
            {busy
              ? `Collegata${uplink?.ssid ? ` a ${uplink.ssid}` : ''}`
              : radio.apEnabled
                ? `Access point ${radio.apSsid ?? ''}`.trim()
                : 'Libera'}
            {radio.up && radio.channel ? ` · canale ${radio.channel}` : ''}
          </p>
        </div>
        <button class="button button--primary" onClick={onScan} disabled={scanning || blocked}>
          {scanning ? 'Cerco…' : 'Cerca reti'}
        </button>
      </header>

      {radio.apEnabled && busy && (
        <p class="alert alert--warn">
          Access point e rete condividono questa radio: l'access point cadrà quando la rete
          cade.
        </p>
      )}

      <div class="radio__actions">
        {radio.apSection && (
          <button class="button button--ghost" onClick={() => onAp(!radio.apEnabled)}>
            {radio.apEnabled ? 'Spegni access point' : 'Accendi access point'}
          </button>
        )}
        {busy && (
          <button class="button button--ghost" onClick={onDisconnect}>
            Disconnetti
          </button>
        )}
      </div>

      {scanning && <p class="muted">La connessione può bloccarsi per qualche secondo.</p>}

      {results !== null && results.length === 0 && !scanning && (
        <p class="muted">Nessuna rete trovata su questa banda.</p>
      )}

      {results !== null && results.length > 0 && (
        <ul class="list list--flush">
          {results.map((net) => (
            <Network
              key={`${net.bssid}-${net.channel}`}
              net={net}
              connected={Boolean(uplink?.ssid) && uplink?.ssid === net.ssid}
              onPick={() => onPick(net)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function Wifi({ onLogout }: { onLogout: () => void }) {
  const [radios, setRadios] = useState<Radio[] | null>(null);
  const [uplinks, setUplinks] = useState<Uplink[]>([]);
  const [aps, setAps] = useState<ApSection[]>([]);
  const [editingAp, setEditingAp] = useState(false);
  const [saved, setSaved] = useState<SavedNetwork[]>([]);
  const [pickedSaved, setPickedSaved] = useState<SavedNetwork | null>(null);
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
  const [portals, setPortals] = useState<PortalStatus | null>(null);
  const [editingAuto, setEditingAuto] = useState(false);
  const [daemonError, setDaemonError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ScanResult[]>>({});
  const [scanningRadio, setScanningRadio] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ net: ScanResult; plan: ConnectionPlan } | null>(null);
  const [action, setAction] = useState<Action | null>(null);

  // Il messaggio dell'errore arriva cosi' com'e': dice quale chiamata ubus e'
  // fallita e perche'. Un "operazione fallita" generico costringe a indovinare.
  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof UbusError && err.isAuthError) return onLogout();
      setError(err instanceof Error ? err.message : String(err));
    },
    [onLogout],
  );

  const reload = useCallback(() => {
    setError(null);
    listRadios().then(setRadios).catch(handle);
    getUplinks()
      .then(setUplinks)
      .catch(() => setUplinks([]));
    getAp()
      .then(setAps)
      .catch(() => setAps([]));
    listSaved()
      .then(setSaved)
      .catch(() => setSaved([]));
    // Il verdetto gia' in RAM nel daemon: leggerlo non fa partire nessuna
    // verifica, quindi aprire questa schermata non costa niente in piu'.
    getPortals()
      .then(setPortals)
      .catch(() => setPortals(null));
    // Se travelD non c'e', il resto dell'interfaccia deve funzionare comunque -
    // ma il motivo va riportato, non inghiottito: "non risponde" da solo non
    // distingue un servizio morto da un permesso mancante.
    getDaemon()
      .then((d) => {
        setDaemon(d);
        setDaemonError(null);
      })
      .catch((err) => {
        setDaemon(null);
        setDaemonError(err instanceof Error ? err.message : String(err));
      });
  }, [handle]);

  useEffect(reload, [reload]);

  const uplinkOf = (radio: Radio) => uplinks.find((u) => u.radio === radio.name) ?? null;

  const scan = async (radio: Radio) => {
    setScanningRadio(radio.name);
    setError(null);
    try {
      const found = await scanRadio(radio);
      setResults((prev) => ({ ...prev, [radio.name]: found.sort((a, b) => b.signal - a.signal) }));
    } catch (err) {
      handle(err);
    } finally {
      setScanningRadio(null);
    }
  };

  const pick = (net: ScanResult) => {
    if (!radios) return;
    const plan = planConnection(radios, net.band);
    if (!plan) {
      setError(`Nessuna radio disponibile sulla banda ${net.band} GHz.`);
      return;
    }
    setPicked({ net, plan });
  };

  const toggleAp = (radio: Radio, enable: boolean) => {
    const other = (radios ?? []).find((r) => r.name !== radio.name);
    setAction({
      title: enable
        ? `Accendi l'access point su ${radio.band} GHz`
        : `Spegni l'access point su ${radio.band} GHz`,
      warn: enable
        ? radio.staSection
          ? "L'access point condividerà la radio con la rete a cui sei collegato: erediterà il suo canale e cadrà insieme a lei."
          : "L'access point tornerà attivo su questa radio."
        : other?.apEnabled
          ? "Resterà attivo l'access point sull'altra radio: il telefono si riconnetterà da solo."
          : "Non resterà nessun access point attivo. Se stai usando il router dal WiFi perderai l'accesso, e senza conferma tornerà tutto indietro da solo.",
      stage: () => stageApEnabled(radio, enable),
    });
  };

  const disconnect = (radio: Radio) => {
    setAction({
      title: `Disconnetti la rete su ${radio.band} GHz`,
      warn: 'La radio torna libera. Se la usi come uplink, perderai Internet finché non ne colleghi un altro.',
      stage: () => stageDisconnect(radio),
    });
  };

  return (
    <main class="screen">
      <header class="topbar">
        <h1>Reti WiFi</h1>
        <button class="button button--ghost" onClick={reload}>
          Aggiorna
        </button>
      </header>

      {/* Solo le radio. Il filtro dice cosa tenere e non cosa scartare: la
          versione precedente escludeva l'ethernet per nome, e il giorno in cui
          e' comparso il tethering USB - un tipo nuovo, che nessuno aveva
          pensato di escludere - ha iniziato a mostrarlo qui come una radio che
          non aggancia. Un elenco di cose ammesse non ha quel problema: un tipo
          che non conosciamo resta fuori da solo. */}
      {uplinks.filter((u) => u.kind === 'wifi').map((uplink) => (
        <UplinkCard
          key={uplink.section}
          uplink={uplink}
          portal={portals?.results[uplink.network] ?? null}
        />
      ))}

      <ApCard aps={aps} onEdit={() => setEditingAp(true)} />

      <SavedCard saved={saved} onPick={setPickedSaved} />

      <AutoCard
        daemon={daemon}
        error={daemonError}
        saved={saved}
        onEdit={() => setEditingAuto(true)}
        onChanged={reload}
      />

      {error && <p class="alert alert--error alert--code">{error}</p>}

      {radios === null && error === null && <p class="muted">Leggo le radio…</p>}

      {(radios ?? []).map((radio) => (
        <RadioCard
          key={radio.name}
          radio={radio}
          uplink={uplinkOf(radio)}
          results={results[radio.name] ?? null}
          scanning={scanningRadio === radio.name}
          blocked={scanningRadio !== null && scanningRadio !== radio.name}
          onScan={() => void scan(radio)}
          onPick={pick}
          onAp={(enable) => toggleAp(radio, enable)}
          onDisconnect={() => disconnect(radio)}
        />
      ))}

      {picked && (
        <ConnectSheet
          net={picked.net}
          plan={picked.plan}
          saved={saved}
          onClose={(changed) => {
            setPicked(null);
            if (changed) reload();
          }}
        />
      )}

      {editingAuto && daemon && (
        <AutoSheet
          daemon={daemon}
          onClose={(changed) => {
            setEditingAuto(false);
            if (changed) reload();
          }}
        />
      )}

      {pickedSaved && (
        <SavedSheet
          net={pickedSaved}
          saved={saved}
          radios={radios ?? []}
          onClose={(changed) => {
            setPickedSaved(null);
            if (changed) reload();
          }}
        />
      )}

      {editingAp && aps.length > 0 && (
        <ApSheet
          aps={aps}
          onClose={(changed) => {
            setEditingAp(false);
            if (changed) reload();
          }}
        />
      )}

      {action && (
        <ActionSheet
          action={action}
          onClose={(changed) => {
            setAction(null);
            if (changed) reload();
          }}
        />
      )}
    </main>
  );
}
