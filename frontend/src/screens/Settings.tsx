import { useEffect, useState } from 'preact/hooks';
import { UbusError } from '../lib/ubus';
import { usePoll } from '../lib/poll';
import { formatUptime } from '../lib/dashboard';
import { getStatus, getUsb, getUsbDevices, resetUsb, setUsbMode } from '../lib/device';
import type { DeviceStatus, UsbDevice, UsbDevices } from '../lib/device';
import { getSystem, isValidHostname, setSystemHostname } from '../lib/hostname';
import { BackupCard, ProfilesCard, RebootCard, TimeCard } from './System';
import { LedAndToggleRows } from '../components/LedAndToggleRows';

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
        <h2>Nome del router</h2>

        <label class="field">
          <span>Nome</span>
          <input
            type="text"
            value={name}
            placeholder="es. Beryl"
            autocapitalize="none"
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
          <span class="muted">
            Solo lettere, cifre e trattini, non all'inizio né alla fine. È il nome che
            compare nel prompt della shell e nelle pagine di gestione, ed è anche quello che
            le WAN impostate su “nome del router” mandano alla rete a monte.
          </span>
        </label>

        {error && <p class="alert alert--error alert--code">{error}</p>}

        <div class="sheet__actions">
          <button class="button button--ghost" onClick={() => onClose(false)}>
            Annulla
          </button>
          <button
            class="button button--primary"
            disabled={busy || !valid || !section}
            onClick={save}
          >
            Salva
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
  const net = dev.interfaces.find((i) => i.network);
  const offered = dev.interfaces.filter((i) => i.label).map((i) => i.label);

  if (!net) {
    return (
      <p class="alert alert--warn">
        Collegato, ma non sta offrendo nessuna funzione di rete
        {offered.length > 0 ? `: espone ${offered.join(', ')}` : ''}. Se è un telefono,
        accendi la <strong>condivisione tramite USB</strong> dalle sue impostazioni: finché
        resta in trasferimento file non c'è niente che il router possa agganciare.
      </p>
    );
  }

  if (net.module_state === 'assente') {
    return (
      <p class="alert alert--error">
        Sta offrendo <strong>{net.label}</strong>, ma sul router manca il modulo{' '}
        <code>{net.module}</code>: nessuno può agganciarlo, ed è per questo che non compare
        fra le WAN mentre il telefono mostra la condivisione accesa. Con il router connesso
        a Internet, installalo con{' '}
        <code>apk add kmod-usb-net-{net.module.replace(/_/g, '-')}</code> — oppure rilancia
        il deploy, che ora lo fa da sé.
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
        Sta offrendo <strong>{net.label}</strong> e <code>{net.module}</code> è sul disco,
        ma <strong>non è caricato</strong>: per questo non aggancia niente.{' '}
        {base && base !== 'caricato' ? (
          <>
            La causa è a monte: <code>usbnet</code>, da cui dipende, è{' '}
            <strong>{base}</strong>. Finché non si carica lui non si carica nessuno dei
            driver di tethering.{' '}
          </>
        ) : null}
        Il motivo esatto lo dice <code>modprobe {net.module}</code> via SSH: di solito è un
        modulo compilato per un kernel diverso da quello in esecuzione, e si risolve
        reinstallando i kmod dopo un <code>apk update</code>.
      </p>
    );
  }

  return (
    <p class="alert alert--warn">
      Sta offrendo <strong>{net.label}</strong> e il modulo <code>{net.module}</code> è
      caricato, ma non lo ha agganciato. Stacca e riattacca il cavo; se non basta, il log
      dice cosa è successo: <code>logread | grep -i usb</code>.
    </p>
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

  if (state.devices.length === 0) {
    return (
      <p class="muted">
        Nessun dispositivo collegato alla porta USB.
      </p>
    );
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
              value={[dev.netdev || 'nessuna interfaccia', speed].filter(Boolean).join(' · ')}
            />
            {/* Attaccato ma senza driver di rete: e' il caso che prima
                spariva. Cosa dire dipende da cosa il dispositivo offre, ed e'
                per questo che si guardano le sue funzioni una per una. */}
            {!dev.netdev && <UnboundReason dev={dev} modules={state.modules} />}
            {dev.netdev && state.wan_usb.disabled && (
              <p class="alert alert--warn">
                Il driver <strong>{dev.driver || '—'}</strong> lo ha agganciato come{' '}
                <code>{dev.netdev}</code>, ma l'interfaccia <code>wan_usb</code> è rimasta
                disattivata: per questo non compare fra le WAN. Stacca e riattacca il cavo;
                se non basta, il log dice cosa è successo.
              </p>
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
  if (state?.mode === 'unsupported') {
    return (
      <p class="muted">
        Questo kernel non permette di spegnere le porte SuperSpeed: la velocità della
        porta USB non è regolabile da qui.
      </p>
    );
  }

  return (
    <>
      <div class="field">
        <span>Velocità della porta</span>
        <div class="chips">
          {(
            [
              [false, 'Massima disponibile'],
              [true, 'Limita a USB 2.0'],
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

      <p class="muted">
        {state === null
          ? 'Leggo lo stato della porta…'
          : state.force_usb2
            ? 'La SuperSpeed è spenta: i dispositivi si collegano in USB 2.0. Per il tethering non cambia niente, un telefono sta ben sotto i 480 Mbit/s.'
            : 'Il dispositivo negozia la velocità che sa fare. Se il tethering si accende e si spegne da solo dopo una decina di secondi, prova a limitare a USB 2.0: su questo SoC il link SuperSpeed si è già visto cadere così.'}
      </p>

      {error && <p class="alert alert--error alert--code">{error}</p>}
    </>
  );
}

function UsbReset() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const { controller, mode } = await resetUsb();
      const label = controller || 'controller';
      setDone(mode === 'usb2' ? `${label} riavviato, porta in USB 2.0` : `${label} riavviato`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button class="button button--ghost" disabled={busy} onClick={run}>
        {busy ? 'Riavvio in corso…' : 'Riavvia la porta USB'}
      </button>
      <p class="muted">
        Se il telefono non viene più rilevato nemmeno riattaccandolo, questo rimette in
        sesto la porta. Stacca per qualche secondo <strong>qualunque</strong> periferica
        USB collegata. Se non basta, riavvia il telefono: anche il suo stack USB può
        restare incantato, e da lì il router non può farci niente.
      </p>
      {done && (
        <p class="alert alert--ok">
          {done}. Riattacca il telefono e riabilita la condivisione.
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
        <h1>Impostazioni</h1>
        {/* "Aggiorna" come nelle altre schermate, non "Esci": l'uscita resta
            dov'era, in Internet, e averla in due posti sarebbe solo un doppione
            da cercare. */}
        <button class="button button--ghost" onClick={poll.refresh}>
          Aggiorna
        </button>
      </header>

      <section class="card">
        {/* Il nome non e' solo un'etichetta: e' anche quello che le WAN
            impostate su "nome del router" mandano alla rete a monte. */}
        <header class="radio__head">
          <h2 class="uplink__title">Dispositivo</h2>
          <button class="button button--ghost" onClick={() => setEditingName(true)}>
            Cambia nome
          </button>
        </header>

        {data === null ? (
          <p class="muted">
            {poll.loading ? 'Caricamento…' : 'Il router non ha risposto.'}
          </p>
        ) : (
          <>
            <Row label="Nome" value={data.hostname || '—'} />
            <Row label="Acceso da" value={formatUptime(data.uptime)} />
            <Row label="Carico" value={data.load.map((n) => n.toFixed(2)).join('  ')} />
            <Row
              label="Temperatura"
              value={
                data.temp_mc == null
                  ? 'non disponibile'
                  : `${Math.round(data.temp_mc / 1000)} °C`
              }
            />
            <Row label="Memoria in uso" value={`${mem}%`} />
          </>
        )}

        {/* LED e levetta vengono da chiamate loro: le righe restano anche quando
            lo stato del dispositivo non arriva. */}
        <LedAndToggleRows />

        {poll.error && !(poll.error instanceof UbusError && poll.error.isAuthError) && (
          <p class="alert alert--warn alert--code">{poll.error.message}</p>
        )}
      </section>

      {/* I profili stanno per primi fra le cose della Fase 8: sono quelli che
          si usano arrivando in un posto nuovo, mentre backup, orologio e
          riavvio si toccano una volta e poi stanno li'. */}
      <ProfilesCard />

      <section class="card">
        <h2 class="uplink__title">Porta USB</h2>
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
        <h2 class="uplink__title">Configurazione avanzata</h2>
        <a class="button button--ghost" href="/cgi-bin/luci/" target="_blank" rel="noreferrer">
          Apri LuCI
        </a>
        <p class="muted">
          L'interfaccia completa di OpenWrt, intatta: tutto quello che questa interfaccia non
          copre si fa da lì. È anche la via di riserva se qui qualcosa non funziona.
        </p>
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
