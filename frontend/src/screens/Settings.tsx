import { useEffect, useState } from 'preact/hooks';
import { UbusError } from '../lib/ubus';
import { usePoll } from '../lib/poll';
import { formatUptime } from '../lib/dashboard';
import { getStatus, getUsb, getUsbDevices, resetUsb, setUsbMode } from '../lib/device';
import type { DeviceStatus, UsbDevice, UsbDevices } from '../lib/device';
import { getSystem, isValidHostname, setSystemHostname } from '../lib/hostname';
import { BackupCard, ProfilesCard, RebootCard, TimeCard } from './System';
import { LedAndToggleRows } from '../components/LedAndToggleRows';
import { LanguageSelect } from '../components/LanguageSelect';
import { commonText } from '../i18n/common';
import { settingsText } from '../i18n/settings';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div class="row">
      <span class="row__label">{label}</span>
      <span class="row__value">{value}</span>
    </div>
  );
}

/**
 * Nome del router.
 *
 * Non passa da applica-e-conferma: non tocca indirizzi, rotte ne' firewall,
 * quindi non puo' chiudere fuori nessuno. Cambia pero' cosa vedono le WAN
 * impostate su "nome del router", ed e' il motivo per cui le due cose si
 * spiegano insieme.
 */
function DeviceNameSheet({
  current,
  onClose,
}: {
  current: string;
  onClose: (changed: boolean) => void;
}) {
  const t = settingsText();
  const actions = commonText().actions;
  const [name, setName] = useState(current);
  const [section, setSection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // La sezione `system` e' anonima: il nome vero lo sa solo il router, e senza
  // quello `uci set` non ha un bersaglio.
  useEffect(() => {
    let cancelled = false;
    void getSystem()
      .then((info) => {
        if (cancelled) return;
        setSection(info.section);
        // Il nome scritto in uci puo' differire da quello attivo: si modifica
        // quello che verrebbe salvato.
        if (info.configured) setName(info.configured);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  const valid = isValidHostname(name.trim());

  const save = async () => {
    if (!section) return;
    setBusy(true);
    setError(null);
    try {
      await setSystemHostname(section, name.trim());
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{t.deviceName}</h2>

        <label class="field">
          <span>{t.name}</span>
          <input
            type="text"
            value={name}
            placeholder={t.namePlaceholder}
            autocapitalize="none"
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
          <span class="muted">{t.nameRule}</span>
        </label>

        {error && <p class="alert alert--error alert--code">{error}</p>}

        <div class="sheet__actions">
          <button class="button button--ghost" onClick={() => onClose(false)}>
            {actions.cancel}
          </button>
          <button
            class="button button--primary"
            disabled={busy || !valid || !section}
            onClick={save}
          >
            {actions.save}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Riavvio del controller USB.
 *
 * Vive qui e non nella scheda del tethering, che compare solo a telefono
 * collegato: serve proprio quando il telefono NON viene rilevato, e una scheda
 * che in quel momento non c'e' non puo' ospitarlo.
 *
 * Il driver dell'hub, dopo abbastanza tentativi falliti, disabilita la porta e
 * smette di riprovare: da li' in poi il telefono non viene nemmeno visto.
 * Questo comando ripulisce quello stato senza spegnere il router, che in
 * viaggio e' l'unica alternativa.
 */
/**
 * Perche' un dispositivo collegato non e' diventato una WAN.
 *
 * Le cause possibili sono tre e hanno rimedi diversi: il dispositivo non offre
 * nessuna funzione di rete (un telefono in trasferimento file), la offre ma il
 * modulo del kernel non c'e', oppure c'e' e non l'ha presa lo stesso. Dirle
 * tutte e tre insieme sarebbe rumore; qui si guarda cosa il dispositivo
 * dichiara e si dice quella giusta.
 */
function UnboundReason({ dev, modules }: { dev: UsbDevice; modules: Record<string, string> }) {
  const t = settingsText().usb;
  // Le etichette e gli stati arrivano dal router, in italiano: si traducono
  // quelli noti, gli altri (sigle come NCM o RNDIS) restano come sono.
  const fn = (label: string) => t.functions[label] ?? label;
  const state = (value: string) => t.moduleState[value] ?? value;
  const net = dev.interfaces.find((i) => i.network);
  const offered = dev.interfaces.filter((i) => i.label).map((i) => fn(i.label));

  if (!net) {
    return (
      <p class="alert alert--warn">{t.noFunction(offered.join(', '))}</p>
    );
  }

  if (net.module_state === 'assente') {
    return (
      <p class="alert alert--error">
        {t.moduleMissing(fn(net.label), `kmod-usb-net-${net.module.replace(/_/g, '-')}`)}
      </p>
    );
  }

  // Sul disco ma non caricato: non e' un problema di aggancio, e dirgli di
  // riattaccare il cavo lo manderebbe in tondo. Quasi sempre e' la dipendenza
  // comune - `usbnet` - che non si carica e porta giu' tutti e tre i driver.
  if (net.module_state === 'installato') {
    const base = modules.usbnet;
    return (
      <p class="alert alert--error">
        {t.moduleNotLoaded(fn(net.label), net.module, base && base !== 'caricato' ? state(base) : '')}
      </p>
    );
  }

  return (
    <p class="alert alert--warn">{t.notBound(fn(net.label), net.module)}</p>
  );
}

/**
 * Cosa c'e' attaccato alla porta USB.
 *
 * Esiste per un guasto preciso: il telefono mostra il tethering acceso, e sul
 * router non compare nessuna WAN. Le due cause possibili - nessun driver di
 * rete ha agganciato il telefono, oppure l'ha agganciato ma l'interfaccia
 * logica e' rimasta disattivata - dall'interfaccia si vedevano identiche,
 * cioe' non si vedevano: la scheda del tethering compare solo quando la WAN
 * esiste, e quando il problema e' proprio che non esiste non c'e' niente da
 * guardare.
 *
 * Qui il dispositivo si vede appena e' attaccato, agganciato o no.
 */
function UsbDevicesCard() {
  // Cambia solo quando si attacca o si stacca qualcosa: cinque secondi sono
  // abbondanti, e la lettura costa una passata su /sys.
  const state: UsbDevices | null = usePoll<UsbDevices>(() => getUsbDevices(), 5000).data;

  if (!state) return null;
  const t = settingsText().usb;

  if (state.devices.length === 0) {
    return <p class="muted">{t.none}</p>;
  }

  return (
    <>
      {state.devices.map((dev) => {
        const label = dev.name || `${dev.vendor}:${dev.product}`;
        const speed = dev.speed ? `${dev.speed} Mbit/s` : '';

        return (
          <div key={dev.port}>
            <Row
              label={label}
              value={[dev.netdev || t.noInterface, speed].filter(Boolean).join(' · ')}
            />
            {/* Attaccato ma senza driver di rete: e' il caso che prima
                spariva. Cosa dire dipende da cosa il dispositivo offre, ed e'
                per questo che si guardano le sue funzioni una per una. */}
            {!dev.netdev && <UnboundReason dev={dev} modules={state.modules} />}
            {dev.netdev && state.wan_usb.disabled && (
              <p class="alert alert--warn">{t.wanDisabled(dev.driver || '—', dev.netdev)}</p>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * Velocita' massima della porta USB.
 *
 * Sta accanto al riavvio della porta perche' e' l'altra mossa da provare
 * quando il tethering non regge, e le due si spiegano solo insieme: la prima
 * rimette in sesto una porta che il driver ha disabilitato, la seconda evita
 * di negoziare una SuperSpeed che su questo SoC si e' vista fallire.
 *
 * Il default e' la velocita' piena: il limite a USB 2.0 nacque da una sessione
 * in cui anche il telefono era bloccato, e non e' mai stato riprovato con il
 * telefono sano. Tenerlo acceso per sempre sarebbe pagare un prezzo certo per
 * un sospetto incerto - ma resta a un tocco di distanza se il sintomo torna.
 */
function UsbSpeed() {
  const [state, setState] = useState<{ force_usb2: boolean; mode: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getUsb()
      .then((usb) => !cancelled && setState(usb))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = async (forceUsb2: boolean) => {
    if (!state || state.force_usb2 === forceUsb2) return;
    setBusy(true);
    setError(null);
    try {
      const mode = await setUsbMode(forceUsb2);
      setState({ force_usb2: forceUsb2, mode });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Il kernel non espone il controllo delle porte: dirlo e' meglio che
  // mostrare una scelta che non produce nessun effetto.
  const t = settingsText().usb;
  if (state?.mode === 'unsupported') {
    return <p class="muted">{t.speedFixed}</p>;
  }

  return (
    <>
      <div class="field">
        <span>{t.speed}</span>
        <div class="chips">
          {(
            [
              [false, t.max],
              [true, t.usb2],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              type="button"
              class={state?.force_usb2 === value ? 'chip chip--on' : 'chip'}
              disabled={busy || state === null}
              onClick={() => void choose(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {state === null && <p class="muted">{t.readingPort}</p>}

      {error && <p class="alert alert--error alert--code">{error}</p>}
    </>
  );
}

function UsbReset() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const t = settingsText().usb;
  const run = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const { controller, mode } = await resetUsb();
      const label = controller || t.controller;
      setDone(mode === 'usb2' ? t.resetUsb2(label) : t.reset(label));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button class="button button--ghost" disabled={busy} onClick={run}>
        {busy ? t.resetting : t.resetButton}
      </button>
      {done && (
        <p class="alert alert--ok">
          {done}.
        </p>
      )}
      {error && <p class="alert alert--error alert--code">{error}</p>}
    </>
  );
}

/**
 * Impostazioni del dispositivo.
 *
 * Sta in una scheda sua e non piu' in fondo a "Internet" per una ragione
 * semplice: non ha niente a che vedere con gli uplink. Ci si arriva quando si
 * vuole cambiare qualcosa del router, non quando si sta guardando perche' la
 * rete non va, e mescolare le due cose allungava una schermata gia' lunga con
 * roba che nessuno stava cercando.
 *
 * Tre schede distinte invece di un blocco solo, perche' rispondono a tre
 * domande diverse: com'e' messo il router, cosa c'e' attaccato alla USB, e
 * dove si va per quello che qui non c'e'.
 */
export function Settings({ onLogout }: { onLogout: () => void }) {
  const t = settingsText();
  // Non passa da travelD ma dal plugin rpcd: questa schermata deve funzionare
  // anche quando il daemon non risponde - e' anche il posto da cui si va a
  // LuCI, cioe' proprio dove si finisce quando qualcosa non va.
  //
  // Cinque secondi invece dei due della dashboard: qui non c'e' niente che
  // cambi in fretta, e il timer si ferma comunque a scheda non visibile.
  const poll = usePoll<DeviceStatus>(() => getStatus(), 5000);
  const [editingName, setEditingName] = useState(false);

  if (poll.error instanceof UbusError && poll.error.isAuthError) {
    onLogout();
  }

  const data = poll.data;
  const mem = data?.memory.total_kb
    ? Math.round(((data.memory.total_kb - data.memory.available_kb) / data.memory.total_kb) * 100)
    : 0;

  return (
    <main class="screen">
      <header class="topbar">
        <h1>{t.title}</h1>
        {/* "Aggiorna" come nelle altre schermate, non "Esci": l'uscita resta
            dov'era, in Internet, e averla in due posti sarebbe solo un doppione
            da cercare. */}
        <button class="button button--ghost" onClick={poll.refresh}>
          {commonText().actions.refresh}
        </button>
      </header>

      <section class="card">
        {/* Il nome non e' solo un'etichetta: e' anche quello che le WAN
            impostate su "nome del router" mandano alla rete a monte. */}
        <header class="radio__head">
          <h2 class="uplink__title">{t.device}</h2>
          <button class="button button--ghost" onClick={() => setEditingName(true)}>
            {t.rename}
          </button>
        </header>

        {data === null ? (
          <p class="muted">
            {poll.loading ? t.loading : t.noAnswer}
          </p>
        ) : (
          <>
            <Row label={t.name} value={data.hostname || '—'} />
            <Row label={t.uptime} value={formatUptime(data.uptime)} />
            <Row label={t.load} value={data.load.map((n) => n.toFixed(2)).join('  ')} />
            <Row
              label={t.temperature}
              value={
                data.temp_mc == null
                  ? t.unavailable
                  : `${Math.round(data.temp_mc / 1000)} °C`
              }
            />
            <Row label={t.memory} value={`${mem}%`} />
          </>
        )}

        {/* LED e levetta vengono da chiamate loro: le righe restano anche quando
            lo stato del dispositivo non arriva. */}
        <LedAndToggleRows />

        {/* La lingua sta qui, accanto alle altre preferenze del dispositivo:
            si cambia senza dover uscire e rientrare dalla pagina di accesso. */}
        <label class="row">
          <span class="row__label">{t.language}</span>
          <LanguageSelect class="row__select" />
        </label>

        {poll.error && !(poll.error instanceof UbusError && poll.error.isAuthError) && (
          <p class="alert alert--warn alert--code">{poll.error.message}</p>
        )}
      </section>

      {/* I profili stanno per primi fra queste schede: sono quelli che
          si usano arrivando in un posto nuovo, mentre backup, orologio e
          riavvio si toccano una volta e poi stanno li'. */}
      <ProfilesCard />

      <section class="card">
        <h2 class="uplink__title">{t.usb.title}</h2>
        <UsbDevicesCard />
        <UsbSpeed />
        <UsbReset />
      </section>

      <TimeCard />

      <BackupCard />

      <RebootCard />

      {/* LuCI resta l'interfaccia di emergenza, e da quando la radice del
          router apre questa SPA non la si incontra piu' per caso: senza un
          collegamento bisognerebbe ricordarsi l'indirizzo proprio nel momento
          in cui qualcosa non va. Si apre in una scheda nuova per non perdere
          questa. */}
      <section class="card">
        <h2 class="uplink__title">{t.advanced}</h2>
        <a class="button button--ghost" href="/cgi-bin/luci/" target="_blank" rel="noreferrer">
          {t.openLuci}
        </a>
      </section>

      {editingName && (
        <DeviceNameSheet
          current={data?.hostname ?? ''}
          onClose={(changed) => {
            setEditingName(false);
            if (changed) poll.refresh();
          }}
        />
      )}
    </main>
  );
}
