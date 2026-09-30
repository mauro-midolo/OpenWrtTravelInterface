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
import type {
  ApSection,
  Band,
  ConnectionPlan,
  Radio,
  ScanResult,
  Uplink,
  UplinkState,
} from '../lib/wifi';
import { bandsLabel, findSaved, findSavedOn, hasAnyBand, listSaved } from '../lib/networks';
import type { SavedNetwork } from '../lib/networks';
import { getDaemon } from '../lib/autoreconnect';
import type { DaemonStatus } from '../lib/autoreconnect';
import { AutoCard, AutoSheet } from './AutoReconnect';
import { ConnectSheet } from './Connect';
import { ApCard, ApSheet } from './AccessPoint';
import { SavedEntryCard, SavedNetworksScreen } from './SavedNetworks';
import { HiddenSheet } from './HiddenNetwork';
import { ApplyStatus } from '../components/ApplyStatus';
import { getPortals, portalLabel, portalLoginUrl } from '../lib/portal';
import { commonText } from '../i18n/common';
import { wifiText } from '../i18n/wifi';
import type { PortalResult, PortalStatus } from '../lib/portal';

function Signal({ dbm }: { dbm: number }) {
  const t = wifiText();
  const bars = signalBars(dbm);
  return (
    // Il numero accanto alle tacche: su un telefono il tooltip non esiste, e
    // fra due reti "a tre tacche" il dBm e' l'unica cosa che le distingue.
    <span class="signal-group" aria-label={t.signal(dbm)}>
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
  const t = wifiText().uplink;
  const band = uplink.band ? t.band(uplink.band) : t.radio(uplink.radio);
  switch (state) {
    case 'addressed':
      return t.addressed(band);
    case 'no-address':
      return t.noAddress(band);
    case 'disabled':
      return t.disabled(band);
    default:
      return t.notAssociated(band);
  }
}

function UplinkCard({ uplink, portal }: { uplink: Uplink; portal: PortalResult | null }) {
  const t = wifiText().uplink;
  const state = uplinkState(uplink);

  return (
    <section class={`card uplink uplink--${state}`}>
      <h2 class="uplink__title">{uplinkTitle(uplink, state)}</h2>

      {/* Il verdetto sull'uscita, non solo sul collegamento. Qui si mostra e
          basta: rifare la verifica, aprire il portale e clonare un MAC stanno
          nella scheda Internet, che e' dove si va quando qualcosa non va. */}
      {state === 'addressed' && portal && (
        <p class={portal.state === 'online' ? 'alert alert--ok' : 'alert alert--warn'}>
          {portalLabel(portal.state)}
          {portal.state === 'portal' && portalLoginUrl(portal) && (
            <>
              {' — '}
              <a href={portalLoginUrl(portal)} target="_blank" rel="noreferrer">
                {t.openLogin}
              </a>
            </>
          )}
        </p>
      )}

      {state === 'addressed' || state === 'no-address' ? (
        <>
          <Row label={t.network} value={uplink.ssid ?? '—'} />
          {/* "nessuno" accanto a un IPv6 che funziona direbbe una cosa falsa:
              su un uplink v6-only la riga si qualifica e mostra un trattino. */}
          <Row
            label={uplink.ipv6.length > 0 ? t.address4 : t.address}
            value={uplink.ipv4 || (uplink.ipv6.length > 0 ? '—' : t.none)}
          />
          <Row label={t.gateway} value={uplink.gateway || '—'} />
          <Row label={t.dns} value={uplink.dns?.length ? uplink.dns.join('  ') : '—'} />
          {/* Le righe IPv6 compaiono solo dove IPv6 c'e': su una rete v4-only
              quattro righe con un trattino direbbero che manca qualcosa. */}
          {uplink.ipv6.length > 0 && (
            <>
              <Row label={t.address6} value={uplink.ipv6.join('  ')} />
              {/* Un trattino accanto a un indirizzo valido fa sospettare un
                  guasto che non c'e': senza rotta predefinita IPv6 non esce
                  dalla rete locale, e la riga lo dice invece di lasciarlo
                  dedurre.

                  Quello che NON dice e' come vada IPv4: questa riga non lo sa.
                  Un uplink puo' non avere affatto un indirizzo IPv4, e anche
                  averlo non basta - dietro un captive portal non si esce lo
                  stesso. A quella domanda risponde la verifica dell'uscita,
                  che e' un'altra cosa e sta apposta altrove. */}
              <Row
                label={t.gateway6}
                value={uplink.gateway6 || t.noGateway6}
              />
              {uplink.dns6.length > 0 && (
                <Row label={t.dns6} value={uplink.dns6.join('  ')} />
              )}
              {uplink.prefix6 && <Row label={t.prefix6} value={uplink.prefix6} />}
            </>
          )}
          <Row label={t.mac} value={uplink.mac || '—'} />
          {typeof uplink.signal === 'number' && (
            <Row label={t.signal} value={`${uplink.signal} dBm`} />
          )}
          {uplink.channel ? <Row label={t.channel} value={String(uplink.channel)} /> : null}
        </>
      ) : (
        <p class="muted">
          {state === 'disabled'
            ? t.disabledNote
            : t.notAssociatedNote}
        </p>
      )}
    </section>
  );
}

/**
 * Come dire, in una targhetta, che questa rete e' gia' configurata.
 *
 * Serve a distinguere a colpo d'occhio le reti che il router conosce gia' da
 * quelle da configurare da zero: toccando le prime il modulo si apre sulla
 * configurazione salvata e la password non va ridigitata, e saperlo prima di
 * toccarle cambia cosa ci si aspetta.
 *
 * La banda fa parte della risposta quando non e' questa. Una rete salvata a 5
 * GHz e ritrovata cercando a 2.4 e' la stessa rete - il modulo la riconosce e
 * ne riusa la password - ma non e' ancora configurata su questa radio, e dire
 * soltanto "salvata" lo nasconderebbe.
 */
export function savedLabel(saved: SavedNetwork[], net: ScanResult): string {
  if (net.hidden) return '';
  const label = wifiText().saved;
  if (findSavedOn(saved, net.ssid, net.band)) return label;

  const elsewhere = findSaved(saved, net.ssid);
  if (!elsewhere) return '';
  return hasAnyBand(elsewhere.bands) ? `${label} · ${bandsLabel(elsewhere.bands)}` : label;
}

function Network({
  net,
  saved,
  connected,
  onPick,
  onAddHidden,
}: {
  net: ScanResult;
  /** Come e' gia' configurata questa rete, se lo e'. Vuoto se non lo e'. */
  saved: string;
  connected: boolean;
  onPick: () => void;
  /** Per le righe senza nome: l'unico modo di usarle e' scriverlo a mano. */
  onAddHidden: () => void;
}) {
  const t = wifiText();
  return (
    <li>
      {/* Una rete che non annuncia il nome si vede - il punto di accesso e'
          li' e trasmette - ma non si puo' toccare per collegarsi, perche' non
          c'e' un SSID da mettere nella configurazione. Prima la riga era
          disattivata e finiva li'; ora porta al modulo che chiede il nome, che
          e' esattamente cio' che manca. */}
      <button class="net" onClick={net.hidden ? onAddHidden : onPick}>
        <span class="net__main">
          <span class={net.hidden ? 'net__ssid net__ssid--hidden' : 'net__ssid'}>
            {net.hidden ? t.hidden : net.ssid}
          </span>
          <span class="net__meta">
            ch {net.channel} · {net.security}
            {net.count > 1 && ` · ${t.accessPoints(net.count)}`}
          </span>
        </span>
        <span class="net__side net__side--wrap">
          {connected && <span class="badge badge--ok">{t.connected}</span>}
          {/* Un fatto sulla configurazione, non sullo stato: la stessa
              targhetta muta che nell'elenco delle reti salvate dice
              "nascosta". Verde o arancione competerebbe con "collegata" e con
              "aperta", che parlano di adesso. */}
          {saved !== '' && <span class="badge badge--muted">{saved}</span>}
          {net.open && <span class="badge badge--warn">{t.open}</span>}
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
  const t = commonText().actions;
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
            {action.warn && <p class="alert alert--warn">{action.warn}</p>}
            <div class="sheet__actions">
              <button class="button button--ghost" onClick={() => onClose(false)}>
                {t.cancel}
              </button>
              <button class="button button--primary" onClick={go}>
                {t.proceed}
              </button>
            </div>
          </>
        )}

        <ApplyStatus apply={apply} onClose={() => onClose(true)} />

        {confirmed && (
          <>
            <p class="alert alert--ok">{t.done}</p>
            <div class="sheet__actions">
              <button class="button button--primary" onClick={() => onClose(true)}>
                {t.close}
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
  saved,
  scanning,
  blocked,
  onScan,
  onPick,
  onAp,
  onDisconnect,
  onAddHidden,
}: {
  radio: Radio;
  uplink: Uplink | null;
  results: ScanResult[] | null;
  /** Le reti gia' configurate: servono a marcare quelle che il router conosce. */
  saved: SavedNetwork[];
  scanning: boolean;
  /** Un'altra radio sta scansionando: sono sulla stessa phy, si disturbano. */
  blocked: boolean;
  onScan: () => void;
  onPick: (net: ScanResult) => void;
  onAp: (enable: boolean) => void;
  onDisconnect: () => void;
  onAddHidden: () => void;
}) {
  const t = wifiText().radio;
  const busy = radio.staSection !== null;
  const label = radio.band ? `${radio.band} GHz` : radio.name;

  return (
    <section class="card">
      <header class="radio__head">
        <div>
          <h2 class="radio__title">{label}</h2>
          <p class="muted">
            {busy
              ? t.connected(uplink?.ssid ?? '')
              : radio.apEnabled
                ? t.ap(radio.apSsid ?? '')
                : t.free}
            {radio.up && radio.channel ? t.channel(radio.channel) : ''}
          </p>
        </div>
        <button class="button button--primary" onClick={onScan} disabled={scanning || blocked}>
          {scanning ? t.scanning : t.scan}
        </button>
      </header>

      {radio.apEnabled && busy && (
        <p class="alert alert--warn">{t.shared}</p>
      )}

      {/* Perche' il pulsante qui sotto non si preme. Sta accanto al pulsante e
          non in cima alla schermata: chi lo trova spento cerca la ragione li',
          e "l'access point è acceso" da solo non spiega chi lo tiene acceso. */}
      {radio.apSection && radio.apToggle && (
        <p class="alert alert--info">{t.followsSwitch}</p>
      )}

      <div class="radio__actions">
        {/* Resta visibile anche quando lo comanda la levetta: dice com'e'
            messo l'access point adesso, ed e' proprio cio' che serve leggere
            per capire dov'e' la levetta. Sparire lascerebbe la scheda senza
            quella riga, che e' il contrario di quello che si vuole. */}
        {radio.apSection && (
          <button
            class="button button--ghost"
            disabled={radio.apToggle}
            onClick={() => onAp(!radio.apEnabled)}
          >
            {radio.apEnabled ? t.apOff : t.apOn}
          </button>
        )}
        {busy && (
          <button class="button button--ghost" onClick={onDisconnect}>
            {t.disconnect}
          </button>
        )}
        {/* Sta qui e non altrove perche' e' l'altra meta' della stessa scelta:
            l'elenco sopra mostra le reti che si annunciano, questa serve per
            quelle che non lo fanno. Sotto la scheda della radio ne eredita
            anche la banda, che e' il primo campo del modulo. */}
        <button class="button button--ghost" onClick={onAddHidden}>
          {t.addHidden}
        </button>
      </div>

      {scanning && <p class="muted">{t.scanNote}</p>}

      {results !== null && results.length === 0 && !scanning && (
        <p class="muted">{t.noResults}</p>
      )}

      {results !== null && results.length > 0 && (
        <ul class="list list--flush">
          {results.map((net) => (
            <Network
              key={`${net.bssid}-${net.channel}`}
              net={net}
              saved={savedLabel(saved, net)}
              connected={Boolean(uplink?.ssid) && uplink?.ssid === net.ssid}
              onPick={() => onPick(net)}
              onAddHidden={onAddHidden}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function Wifi({ onLogout }: { onLogout: () => void }) {
  const t = wifiText();
  const [radios, setRadios] = useState<Radio[] | null>(null);
  const [uplinks, setUplinks] = useState<Uplink[]>([]);
  const [aps, setAps] = useState<ApSection[]>([]);
  const [editingAp, setEditingAp] = useState(false);
  const [saved, setSaved] = useState<SavedNetwork[]>([]);
  /**
   * Quale delle due viste della scheda e' aperta.
   *
   * Le reti salvate stanno in una pagina a se' ma non in una scheda a se': si
   * arriva da qui, e la barra in basso deve continuare a dire dove si e'
   * entrati. Tenerle qui vuol dire anche che condividono la lettura gia' fatta
   * - reti, radio e uplink - invece di rifarne una loro.
   */
  const [view, setView] = useState<'radios' | 'saved'>('radios');
  /**
   * Banda con cui aprire il modulo della rete nascosta, oppure chiuso.
   *
   * Non un booleano: il modulo si apre dalla scheda di una radio, e partire
   * dalla banda di quella radio evita di doverla riscegliere. Resta comunque
   * cambiabile dentro il modulo, perche' la banda e' una decisione sulla rete
   * e non su da dove si e' entrati.
   */
  const [addingHidden, setAddingHidden] = useState<Band | null>(null);
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

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

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
      setError(t.noRadio(net.band));
      return;
    }
    setPicked({ net, plan });
  };

  const toggleAp = (radio: Radio, enable: boolean) => {
    const other = (radios ?? []).find((r) => r.name !== radio.name);
    setAction({
      title: enable ? t.apOnTitle(radio.band ?? radio.name) : t.apOffTitle(radio.band ?? radio.name),
      warn: enable
        ? radio.staSection
          ? t.apFallsWithUplink
          : ''
        : other?.apEnabled
          ? ''
          : t.noApLeft,
      stage: () => stageApEnabled(radio, enable),
    });
  };

  const disconnect = (radio: Radio) => {
    setAction({
      title: t.disconnectTitle(radio.band ?? radio.name),
      warn: t.disconnectWarn,
      stage: () => stageDisconnect(radio),
    });
  };

  if (view === 'saved') {
    return (
      <SavedNetworksScreen
        saved={saved}
        radios={radios ?? []}
        uplinks={uplinks}
        onReload={reload}
        onBack={() => setView('radios')}
      />
    );
  }

  return (
    <main class="screen">
      <header class="topbar">
        <h1>{t.title}</h1>
        <button class="button button--ghost" onClick={reload}>
          {commonText().actions.refresh}
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

      <SavedEntryCard saved={saved} onOpen={() => setView('saved')} />

      <AutoCard
        daemon={daemon}
        error={daemonError}
        saved={saved}
        onEdit={() => setEditingAuto(true)}
        onChanged={reload}
      />

      {error && <p class="alert alert--error alert--code">{error}</p>}

      {radios === null && error === null && <p class="muted">{t.loadingRadios}</p>}

      {(radios ?? []).map((radio) => (
        <RadioCard
          key={radio.name}
          radio={radio}
          uplink={uplinkOf(radio)}
          results={results[radio.name] ?? null}
          saved={saved}
          scanning={scanningRadio === radio.name}
          blocked={scanningRadio !== null && scanningRadio !== radio.name}
          onScan={() => void scan(radio)}
          onPick={pick}
          onAp={(enable) => toggleAp(radio, enable)}
          onDisconnect={() => disconnect(radio)}
          onAddHidden={() => setAddingHidden(radio.band ?? '2.4')}
        />
      ))}

      {addingHidden && (
        <HiddenSheet
          saved={saved}
          band={addingHidden}
          onClose={(changed) => {
            setAddingHidden(null);
            if (changed) reload();
          }}
        />
      )}

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
