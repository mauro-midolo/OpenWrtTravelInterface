import { useState } from 'preact/hooks';
import {
  blockReason,
  blocked,
  formatWgBytes,
  handshakeAge,
  wgActiveProfile,
  wgAlive,
  wgCarrying,
  wgDelete,
  wgEndpointProblem,
  wgImport,
  wgProfiles,
  wgRoutingSteps,
  wgLockedByToggle,
  wgSave,
  wgToggle,
  wgToggleProfile,
} from '../lib/vpn';
import type { WgFields, WgProfile, WgState } from '../lib/vpn';
import { hostPortJoin } from '../lib/ip';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div class="row">
      <span class="row__label">{label}</span>
      <span class="row__value">{value}</span>
    </div>
  );
}

/** Endpoint e indirizzi in una riga: e' cio' che distingue due profili a colpo d'occhio. */
function summary(profile: WgProfile): string {
  const { config } = profile;
  // `hostPortJoin` e non una concatenazione: un endpoint IPv6 arriva gia' fra
  // parentesi dal router, e unirlo alla porta a mano ne aggiungerebbe un
  // secondo paio - oppure, su un indirizzo senza, produrrebbe un indirizzo
  // diverso e valido. La funzione e' idempotente sulle parentesi apposta.
  const endpoint = config.endpoint
    ? hostPortJoin(config.endpoint, config.port || '51820')
    : 'senza endpoint';
  return config.addresses ? `${endpoint} · ${config.addresses.trim()}` : endpoint;
}

/**
 * Il modulo di un profilo, uno solo per tutte le strade che lo scrivono.
 *
 * Serve sia a modificare i singoli parametri sia a mostrare cosa e' stato
 * importato: due moduli diversi per gli stessi campi si sarebbero convalidati
 * in due modi, e uno dei due sarebbe stato quello sbagliato.
 */
function FieldsForm({
  fields,
  hasPrivateKey,
  hasPreshared,
  onChange,
}: {
  fields: WgFields;
  hasPrivateKey: boolean;
  hasPreshared: boolean;
  onChange: (patch: Partial<WgFields>) => void;
}) {
  const text = (
    key: keyof WgFields,
    label: string,
    placeholder: string,
    hint?: string,
    // Cosa non va nel valore scritto, stringa vuota se va bene. Prende il posto
    // del suggerimento invece di aggiungersi: due righe sotto un campo, una che
    // spiega e una che corregge, si leggono come una sola e si perde quella che
    // conta.
    problem?: string,
  ) => (
    <label class="field">
      <span>{label}</span>
      <input
        type="text"
        value={String(fields[key] ?? '')}
        placeholder={placeholder}
        autocapitalize="none"
        autocomplete="off"
        spellcheck={false}
        onInput={(e) => onChange({ [key]: (e.target as HTMLInputElement).value } as Partial<WgFields>)}
      />
      {problem ? (
        <span class="alert alert--warn">{problem}</span>
      ) : (
        hint && <span class="muted">{hint}</span>
      )}
    </label>
  );

  return (
    <>
      {text(
        'name',
        'Nome',
        'es. casa, ufficio, provider svizzero',
        'Obbligatorio: è come distingui questa configurazione dalle altre.',
      )}
      {text('addresses', 'Indirizzi dell’interfaccia', '10.66.0.2/32', 'Il campo Address del file .conf. Più indirizzi separati da virgola.')}
      {text('peer_key', 'Chiave pubblica del peer', 'PublicKey del [Peer]')}
      {text(
        'endpoint',
        'Endpoint',
        'vpn.example.com',
        'Un nome, un IPv4, o un IPv6 — anche senza parentesi: le mette il router.',
        wgEndpointProblem(fields.endpoint),
      )}
      {text('port', 'Porta', '51820')}
      {text('allowed_ips', 'Instradato nel tunnel', '0.0.0.0/0', 'AllowedIPs. Con 0.0.0.0/0 passa tutto di là.')}
      {text('dns', 'DNS', 'vuoto per non cambiarli')}
      {text('mtu', 'MTU', 'vuoto per il valore automatico')}
      {text('keepalive', 'Keepalive', '25', 'Secondi. Senza, un tunnel dietro NAT si addormenta.')}

      {/* I segreti non escono mai dal router, quindi il campo parte vuoto e
          vuoto vuol dire "lascia quello che c'è": è la stessa regola della
          password del WiFi, e per la stessa ragione. */}
      <label class="field">
        <span>Chiave privata</span>
        <input
          type="password"
          value={fields.private_key}
          autocomplete="new-password"
          placeholder={hasPrivateKey ? 'lascia vuoto per non cambiarla' : 'obbligatoria'}
          onInput={(e) => onChange({ private_key: (e.target as HTMLInputElement).value })}
        />
        <span class="muted">
          {hasPrivateKey
            ? 'È salvata sul router e non viene mostrata: non esce mai da lì.'
            : 'Manca: senza, il tunnel non può salire.'}
        </span>
      </label>

      <label class="field">
        <span>Chiave precondivisa</span>
        <input
          type="password"
          value={fields.preshared_key}
          autocomplete="new-password"
          disabled={fields.drop_preshared}
          placeholder={hasPreshared ? 'lascia vuoto per non cambiarla' : 'facoltativa'}
          onInput={(e) => onChange({ preshared_key: (e.target as HTMLInputElement).value })}
        />
      </label>

      {/* Fuori dal campo e non dentro: un `label` dentro un altro `label` è
          HTML che il browser rimette a posto come gli pare, e il tocco
          finirebbe sulla casella sbagliata. Togliere una chiave precondivisa è
          una richiesta esplicita, perché un campo lasciato in bianco vuol dire
          "non cambiarla" — il browser quella chiave non l'ha mai avuta. */}
      {hasPreshared && (
        <label class="check">
          <input
            type="checkbox"
            checked={fields.drop_preshared}
            onChange={(e) => onChange({ drop_preshared: (e.target as HTMLInputElement).checked })}
          />
          <span>Togli la chiave precondivisa</span>
        </label>
      )}
    </>
  );
}

/** I campi di un profilo salvato, pronti per il modulo. I segreti restano vuoti. */
function fieldsOf(profile: WgProfile | null): WgFields {
  const c = profile?.config;
  return {
    name: profile?.named ? profile.name : '',
    addresses: (c?.addresses ?? '').trim(),
    dns: (c?.dns ?? '').trim(),
    mtu: c?.mtu ?? '',
    private_key: '',
    peer_key: c?.peer_key ?? '',
    preshared_key: '',
    drop_preshared: false,
    endpoint: c?.endpoint ?? '',
    port: c?.port ?? '',
    allowed_ips: (c?.allowed_ips ?? '').trim(),
    keepalive: c?.keepalive ?? '',
  };
}

/**
 * Importazione di una configurazione WireGuard.
 *
 * Si incolla il file del provider così com'è. Non è una comodità: è il formato
 * in cui la configurazione viene consegnata, e l'unico modo per non far
 * ridigitare due chiavi base64 da 44 caratteri su un telefono, in piedi, con
 * una mano. A leggerlo è il router — la chiave privata non deve fare il giro
 * due volte, e la validazione deve stare dalla stessa parte del controllo.
 *
 * Il nome invece lo si chiede qui, prima di importare: è l'unica cosa che il
 * file non contiene e l'unica con cui poi si distingue questa configurazione
 * dalle altre. Chiederlo dopo vorrebbe dire avere per un momento una voce senza
 * nome in un elenco, che è esattamente ciò che rende un elenco inutile.
 */
function ImportSheet({
  profile,
  onClose,
}: {
  profile: WgProfile | null;
  onClose: (changed: boolean) => void;
}) {
  const [name, setName] = useState(profile?.named ? profile.name : '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await wgImport(text, name.trim(), profile?.id ?? '');
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{profile ? `Reimporta «${profile.name}»` : 'Nuova configurazione'}</h2>

        <label class="field">
          <span>Nome</span>
          <input
            type="text"
            value={name}
            placeholder="es. casa, ufficio, provider svizzero"
            autocapitalize="none"
            autocomplete="off"
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
          <span class="muted">
            Obbligatorio: è come distingui questa configurazione dalle altre.
          </span>
        </label>

        <label class="field">
          <span>Incolla il file .conf del provider</span>
          <textarea
            rows={10}
            value={text}
            placeholder={'[Interface]\nPrivateKey = …\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = …\nEndpoint = vpn.example.com:51820\nAllowedIPs = 0.0.0.0/0'}
            autocapitalize="none"
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          />
          <span class="muted">
            La chiave privata resta sul router: viene scritta e non riletta più, come la
            password del WiFi.
          </span>
        </label>

        <p class="alert alert--info">
          {profile
            ? 'Sostituisce i parametri di questa configurazione. Le altre non vengono toccate.'
            : 'La configurazione viene salvata spenta. Attivarla è un passo a parte, così anche la prima accensione passa dai controlli di compatibilità.'}
        </p>

        {error && <p class="alert alert--error alert--code">{error}</p>}

        <div class="sheet__actions">
          <button class="button button--ghost" disabled={busy} onClick={() => onClose(false)}>
            Annulla
          </button>
          <button
            class="button button--primary"
            disabled={busy || name.trim() === '' || text.trim() === ''}
            onClick={() => void go()}
          >
            {busy ? 'Importo…' : profile ? 'Sostituisci' : 'Salva'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Attivazione e disattivazione di una configurazione.
 *
 * **Niente applica-e-conferma**, per la stessa ragione già scritta per le
 * modifiche multi-WAN: questa cambia il routing dei *client*, non l'accesso al
 * router. La LAN, il suo indirizzo e le regole che fanno passare il traffico
 * verso l'interfaccia di gestione non vengono toccati, quindi non ci si può
 * chiudere fuori. Il rischio è restare senza Internet, non senza router.
 *
 * C'era, in una prima versione, ed era un errore di forma prima che di
 * sostanza: `useApply` vuole che il passo di preparazione lasci le modifiche
 * *in sospeso* nella sessione, mentre `wg_toggle` è un metodo che fa `uci
 * commit` da sé. Arrivati a `uci apply` non restava niente da applicare, e il
 * router rispondeva "nessun dato". Due schemi che non si mescolano: o si
 * preparano modifiche uci e le applica il browser, o si chiama un metodo che
 * fa tutto lui.
 */
function ToggleSheet({
  profile,
  on,
  onClose,
}: {
  profile: WgProfile;
  on: boolean;
  onClose: (c: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await wgToggle(on, profile.id);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>
          {on ? 'Attiva' : 'Disattiva'} «{profile.name}»
        </h2>

        {!done && (
          <>
            <p class="alert alert--warn">
              {on
                ? 'Da adesso tutto il traffico dei client esce da questo tunnel. Se il tunnel non sale, senza kill switch il traffico torna a uscire dalla rete a cui sei collegato.'
                : 'Il traffico torna a uscire direttamente dalla rete a cui sei collegato.'}
            </p>
            <p class="muted">
              L'accesso al router non viene toccato: questa schermata resta raggiungibile in
              ogni caso.
            </p>

            {error && <p class="alert alert--error alert--code">{error}</p>}

            <div class="sheet__actions">
              <button class="button button--ghost" disabled={busy} onClick={() => onClose(false)}>
                {error ? 'Chiudi' : 'Annulla'}
              </button>
              <button class="button button--primary" disabled={busy} onClick={() => void go()}>
                {busy ? 'Applico…' : 'Procedi'}
              </button>
            </div>
          </>
        )}

        {done && (
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

type Mode = 'menu' | 'edit' | 'toggle' | 'reimport' | 'delete';

/**
 * Cosa si può fare a una configurazione salvata.
 *
 * Attivare non compare quando ne è già attiva un'altra, e al suo posto c'è
 * scritto quale spegnere. Non è un divieto nascosto: è il vincolo di sempre —
 * una cosa sola alla volta decide da dove esce il traffico — detto nel punto in
 * cui qualcuno sta per provarci.
 */
function ProfileSheet({
  profile,
  wg,
  onClose,
}: {
  profile: WgProfile;
  wg: WgState;
  onClose: (changed: boolean) => void;
}) {
  const [mode, setMode] = useState<Mode>('menu');
  const [fields, setFields] = useState<WgFields>(() => fieldsOf(profile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // L'altra configurazione accesa, se non è questa. È ciò che impedisce di
  // attivare questa, e va detto col suo nome: "una alla volta" senza dire quale
  // lascia a chi legge il compito di cercarla.
  const active = wgActiveProfile(wg);
  const other = active && active.id !== profile.id ? active : null;
  const isBlocked = blocked(wg.policy, 'wireguard');
  // La levetta comanda: da qui si guarda e basta. Vale per tutte le
  // configurazioni e non solo per quella associata — accenderne un'altra la
  // spegnerebbe, e la levetta resterebbe dov'è a dire il contrario.
  const byToggle = wgToggleProfile(wg);
  const locked = wgLockedByToggle(wg);

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

  if (mode === 'toggle') {
    return (
      <ToggleSheet
        profile={profile}
        on={!profile.active}
        onClose={(changed) => (changed ? onClose(true) : setMode('menu'))}
      />
    );
  }

  if (mode === 'reimport') {
    return (
      <ImportSheet
        profile={profile}
        onClose={(changed) => (changed ? onClose(true) : setMode('menu'))}
      />
    );
  }

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{profile.name}</h2>

        {mode === 'menu' && (
          <>
            <p class="muted">{summary(profile)}</p>

            {profile.active && <p class="alert alert--ok">È la configurazione attiva.</p>}

            {!profile.named && (
              <p class="alert alert--info">
                Questa configurazione arriva da una versione precedente e non ha un nome:
                qui sopra c'è il suo endpoint. Aprila in Modifica per dargliene uno.
              </p>
            )}

            {/* Il vincolo, detto prima che si provi. Il router lo rifiuterebbe
                comunque, ma scoprirlo dopo aver premuto è un giro a vuoto. */}
            {!profile.active && other && !locked && (
              <p class="alert alert--info">
                Per attivare questa devi prima disattivare «{other.name}»: una sola
                configurazione WireGuard alla volta può portare il traffico.
              </p>
            )}
            {!profile.active && !other && !locked && isBlocked && (
              <p class="alert alert--info">
                Non si può attivare WireGuard adesso: {blockReason(wg.policy, 'wireguard')}. Al
                massimo una cosa alla volta può decidere da dove esce il traffico.
              </p>
            )}

            {/* Il divieto della levetta viene prima di tutti gli altri: quando
                c'è, gli altri non si possono nemmeno provare. */}
            {locked && (
              <p class="alert alert--info">
                {byToggle?.id === profile.id
                  ? 'Questa configurazione segue l’interruttore fisico: si accende e si spegne muovendo la levetta, non da qui.'
                  : `L’interruttore fisico comanda «${byToggle?.name ?? 'una configurazione'}»: finché è così, da qui non si attiva e non si disattiva nessuna configurazione.`}{' '}
                Per tornare a decidere da qui, cambia la funzione dell’interruttore in Sistema.
              </p>
            )}

            {error && <p class="alert alert--error alert--code">{error}</p>}

            <div class="radio__actions">
              <button
                class="button button--primary"
                disabled={
                  busy ||
                  !wg.installed ||
                  locked ||
                  (!profile.active && (Boolean(other) || isBlocked))
                }
                onClick={() => setMode('toggle')}
              >
                {profile.active ? 'Disattiva' : 'Attiva'}
              </button>
              <button class="button button--ghost" disabled={busy} onClick={() => setMode('edit')}>
                Modifica
              </button>
              <button
                class="button button--ghost"
                disabled={busy}
                onClick={() => setMode('reimport')}
              >
                Reimporta
              </button>
              <button
                class="button button--ghost"
                disabled={busy || profile.active}
                onClick={() => setMode('delete')}
              >
                Elimina
              </button>
            </div>

            {profile.active && (
              <p class="muted">
                Per eliminarla o cambiarne il nome senza rischi, disattivala prima.
              </p>
            )}

            <div class="sheet__actions">
              <button class="button button--ghost" disabled={busy} onClick={() => onClose(false)}>
                Chiudi
              </button>
            </div>
          </>
        )}

        {mode === 'edit' && (
          <>
            <p class="muted">
              Le modifiche valgono solo per questa configurazione: le altre restano come
              sono.
            </p>

            <FieldsForm
              fields={fields}
              hasPrivateKey={profile.config.has_private_key}
              hasPreshared={profile.config.has_preshared}
              onChange={(patch) => setFields((f) => ({ ...f, ...patch }))}
            />

            {profile.active && (
              <p class="alert alert--warn">
                Questa configurazione è attiva: salvando, il tunnel viene rifatto con i
                parametri nuovi e per qualche secondo il traffico non passa.
              </p>
            )}

            {error && <p class="alert alert--error alert--code">{error}</p>}

            <div class="sheet__actions">
              <button class="button button--ghost" disabled={busy} onClick={() => setMode('menu')}>
                Indietro
              </button>
              <button
                class="button button--primary"
                disabled={busy || fields.name.trim() === ''}
                onClick={() =>
                  void guard(() => wgSave(profile.id, { ...fields, name: fields.name.trim() }))
                }
              >
                {busy ? 'Salvo…' : 'Salva'}
              </button>
            </div>
          </>
        )}

        {mode === 'delete' && (
          <>
            <p class="alert alert--warn">
              Elimini «{profile.name}» e la sua chiave privata. Per riaverla servirà di nuovo
              il file del provider.
            </p>
            <p class="muted">Le altre configurazioni salvate non vengono toccate.</p>

            {error && <p class="alert alert--error alert--code">{error}</p>}

            <div class="sheet__actions">
              <button class="button button--ghost" disabled={busy} onClick={() => setMode('menu')}>
                Indietro
              </button>
              <button
                class="button button--primary"
                disabled={busy}
                onClick={() => void guard(() => wgDelete(profile.id))}
              >
                {busy ? 'Elimino…' : 'Elimina'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * La scheda WireGuard.
 *
 * Sta accanto a Tailscale e non in una schermata sua: sono due risposte alla
 * stessa domanda - da dove esce il traffico - e vederle insieme è ciò che
 * rende evidente perché non possono essere accese tutte e due.
 *
 * Le configurazioni salvate sono tante, quella attiva è una sola, e la scheda è
 * costruita perché quale sia si legga senza cercarlo: nel sottotitolo, nel
 * distintivo sulla riga, e nei dettagli che compaiono solo per lei — handshake,
 * traffico, catena del routing sono fatti del tunnel acceso e di nessun altro.
 */
export function WireGuardCard({
  wg,
  onChanged,
}: {
  wg: WgState;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  const profiles = wgProfiles(wg);
  const active = wgActiveProfile(wg);
  const isBlocked = blocked(wg.policy, 'wireguard');
  const alive = wgAlive(wg.status);
  // Chi comanda l'accensione: la levetta sul fianco del router, o questa
  // scheda. Non tutte e due, mai — è ciò che tiene d'accordo posizione della
  // levetta, tunnel acceso e quello che si legge qui.
  const byToggle = wgToggleProfile(wg);
  const locked = wgLockedByToggle(wg);

  // Gli anelli fra "il tunnel è su" e "i client ci passano dentro", e il
  // giudizio che ne segue. Stanno in vpn.ts perché la stessa domanda la fa
  // anche il kill switch, che senza una risposta condivisa gridava al vuoto su
  // un tunnel perfettamente funzionante.
  const steps = wgRoutingSteps(wg);
  const broken = steps.filter((s) => !s.ok);
  const carrying = wgCarrying(wg);
  const tone = !active ? 'unassociated' : carrying ? 'addressed' : 'no-address';

  // La riga sotto il titolo dice due cose in quest'ordine: quale è attiva, e
  // quante ce ne sono. L'ordine non è casuale — la prima è quella che cambia
  // cosa sta succedendo adesso.
  const subtitle = !wg.installed
    ? 'non installato'
    : profiles.length === 0
      ? 'nessuna configurazione salvata'
      : active
        ? `${active.name} · ${
            carrying
              ? 'attiva'
              : alive
                ? 'attiva, ma il traffico non ci entra'
                : 'attiva, ma il peer non risponde'
          }`
        : `nessuna attiva · ${profiles.length} salvat${profiles.length === 1 ? 'a' : 'e'}`;

  const openProfile = picked ? (profiles.find((p) => p.id === picked) ?? null) : null;

  return (
    <section class={`card uplink uplink--${tone}`}>
      <header class="radio__head">
        <div>
          <h2 class="uplink__title">WireGuard</h2>
          <p class="muted">{subtitle}</p>
        </div>
        {carrying && <span class="badge badge--ok">porta il traffico</span>}
      </header>

      {!wg.installed && (
        <p class="alert alert--warn">
          Il pacchetto <code>wireguard-tools</code> non è sul router. Si installa da solo al
          prossimo deploy fatto con Internet funzionante.
        </p>
      )}

      {/* Il vincolo esterno, detto una volta sola sulla scheda: dentro al
          foglio di un profilo si ripete solo quando lì si sta per premere. */}
      {!active && isBlocked && !locked && profiles.length > 0 && (
        <p class="alert alert--info">
          Non si può attivare WireGuard adesso: {blockReason(wg.policy, 'wireguard')}. Al
          massimo una cosa alla volta può decidere da dove esce il traffico.
        </p>
      )}

      {/* Chi comanda si dice qui, non solo dentro al foglio di un profilo: chi
          apre la scheda per capire perché il tunnel si è acceso da solo deve
          trovarne la ragione senza doverla cercare. */}
      {locked && (
        <p class="alert alert--info">
          L’attivazione la comanda l’interruttore fisico:{' '}
          <strong>{byToggle?.name ?? wg.toggle}</strong> segue la levetta e da qui non si
          attiva né si disattiva nessuna configurazione. Le altre cose — modificare,
          reimportare, guardare — restano come sempre.
        </p>
      )}

      {profiles.length === 0 ? (
        <p class="muted">
          Nessuna. Incolla il file .conf del tuo provider, dagli un nome, e lo ritrovi qui:
          puoi salvarne quante ne vuoi e attivarne una alla volta.
        </p>
      ) : (
        <ul class="list list--flush">
          {profiles.map((profile) => (
            <li key={profile.id}>
              <button class="net" onClick={() => setPicked(profile.id)}>
                <span class="net__main">
                  <span class="net__ssid">{profile.name}</span>
                  <span class="net__meta">{summary(profile)}</span>
                </span>
                <span class="net__side">
                  {profile.active && <span class="badge badge--ok">attiva</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Handshake, traffico e catena del routing riguardano il tunnel acceso e
          nessun altro: sono fatti che vivono nel kernel, e ne esiste una serie
          sola perché può esserci un tunnel solo. */}
      {active && (
        <>
          <h3 class="group__title">{active.name}</h3>
          <Row label="Ultimo handshake" value={handshakeAge(wg.status)} />
          <Row
            label="Traffico"
            value={`↓ ${formatWgBytes(wg.status.rx)}   ↑ ${formatWgBytes(wg.status.tx)}`}
          />

          {/* Handshake a posto ma traffico che non entra: è il guasto più
              ingannevole di tutti, perché la scheda direbbe "attivo" e i
              client uscirebbero lo stesso dalla WAN. Si mostra solo quando
              c'è qualcosa che non va: quando la catena è intera, non serve. */}
          {wg.routing && broken.length > 0 && (
            <>
              <h3 class="group__title">Il traffico entra nel tunnel?</h3>
              {steps.map((step) => (
                <div key={step.label} class="node">
                  <span
                    class={step.ok ? 'dot dot--on' : 'dot'}
                    role="img"
                    aria-label={step.ok ? 'a posto' : 'manca'}
                  />
                  <span class="node__name">{step.label}</span>
                </div>
              ))}
              <p class="alert alert--warn">
                Il tunnel è su ma <strong>il traffico dei client non ci entra</strong>:{' '}
                {broken.map((s) => s.fix).join(' · ')}
              </p>
            </>
          )}

          {/* Acceso e senza handshake recente: il device è su, la
              configurazione sembra a posto, e non passa niente. È la stessa
              distinzione fra "collegato" e "funziona" che regge il resto
              dell'interfaccia. */}
          {!alive && (
            <p class="alert alert--warn">
              Il tunnel è acceso ma <strong>l'ultimo handshake non è recente</strong>: il peer
              non sta rispondendo. Di solito è l'endpoint irraggiungibile dalla rete in cui
              ti trovi, oppure una chiave che non combacia.
            </p>
          )}
        </>
      )}

      <div class="radio__actions">
        <button class="button button--ghost" onClick={() => setAdding(true)}>
          Aggiungi configurazione
        </button>
      </div>

      {adding && (
        <ImportSheet
          profile={null}
          onClose={(changed) => {
            setAdding(false);
            if (changed) onChanged();
          }}
        />
      )}

      {openProfile && (
        <ProfileSheet
          profile={openProfile}
          wg={wg}
          onClose={(changed) => {
            setPicked(null);
            if (changed) onChanged();
          }}
        />
      )}
    </section>
  );
}
