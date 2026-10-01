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
import { commonText } from '../i18n/common';
import { wgText } from '../i18n/wireguard';

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
    : wgText().noEndpoint;
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
  const t = wgText();
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
      {text('name', t.name, t.namePlaceholder)}
      {text('addresses', t.addresses, '10.66.0.2/32')}
      {text('peer_key', t.peerKey, t.peerKeyPlaceholder)}
      {text(
        'endpoint',
        t.endpoint,
        'vpn.example.com',
        undefined,
        wgEndpointProblem(fields.endpoint),
      )}
      {text('port', t.port, '51820')}
      {text('allowed_ips', t.allowedIps, '0.0.0.0/0')}
      {text('dns', t.dns, t.dnsPlaceholder)}
      {text('mtu', t.mtu, t.mtuPlaceholder)}
      {text('keepalive', t.keepalive, '25')}

      {/* I segreti non escono mai dal router, quindi il campo parte vuoto e
          vuoto vuol dire "lascia quello che c'è": è la stessa regola della
          password del WiFi, e per la stessa ragione. */}
      <label class="field">
        <span>{t.privateKey}</span>
        <input
          type="password"
          value={fields.private_key}
          autocomplete="new-password"
          placeholder={hasPrivateKey ? t.keepKey : t.required}
          onInput={(e) => onChange({ private_key: (e.target as HTMLInputElement).value })}
        />
        {!hasPrivateKey && <span class="muted">{t.missingKey}</span>}
      </label>

      <label class="field">
        <span>{t.presharedKey}</span>
        <input
          type="password"
          value={fields.preshared_key}
          autocomplete="new-password"
          disabled={fields.drop_preshared}
          placeholder={hasPreshared ? t.keepKey : t.optional}
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
          <span>{t.dropPreshared}</span>
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
  const t = wgText();
  const actions = commonText().actions;
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
        <h2>{profile ? t.reimportTitle(profile.name) : t.newConfig}</h2>

        <label class="field">
          <span>{t.name}</span>
          <input
            type="text"
            value={name}
            placeholder={t.namePlaceholder}
            autocapitalize="none"
            autocomplete="off"
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </label>

        <label class="field">
          <span>{t.paste}</span>
          <textarea
            rows={10}
            value={text}
            placeholder={'[Interface]\nPrivateKey = …\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = …\nEndpoint = vpn.example.com:51820\nAllowedIPs = 0.0.0.0/0'}
            autocapitalize="none"
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          />
        </label>

        {error && <p class="alert alert--error alert--code">{error}</p>}

        <div class="sheet__actions">
          <button class="button button--ghost" disabled={busy} onClick={() => onClose(false)}>
            {actions.cancel}
          </button>
          <button
            class="button button--primary"
            disabled={busy || name.trim() === '' || text.trim() === ''}
            onClick={() => void go()}
          >
            {busy ? t.importing : profile ? t.replace : actions.save}
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
  const t = wgText();
  const actions = commonText().actions;
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
        <h2>{t.toggleTitle(on, profile.name)}</h2>

        {!done && (
          <>
            <p class="alert alert--warn">
              {on
                ? t.onWarn
                : t.offWarn}
            </p>

            {error && <p class="alert alert--error alert--code">{error}</p>}

            <div class="sheet__actions">
              <button class="button button--ghost" disabled={busy} onClick={() => onClose(false)}>
                {error ? actions.close : actions.cancel}
              </button>
              <button class="button button--primary" disabled={busy} onClick={() => void go()}>
                {busy ? t.applying : actions.proceed}
              </button>
            </div>
          </>
        )}

        {done && (
          <>
            <p class="alert alert--ok">{actions.done}</p>
            <div class="sheet__actions">
              <button class="button button--primary" onClick={() => onClose(true)}>
                {actions.close}
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
  const t = wgText();
  const actions = commonText().actions;
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

            {profile.active && <p class="alert alert--ok">{t.isActive}</p>}

            {!profile.named && (
              <p class="alert alert--info">{t.unnamed}</p>
            )}

            {/* Il vincolo, detto prima che si provi. Il router lo rifiuterebbe
                comunque, ma scoprirlo dopo aver premuto è un giro a vuoto. */}
            {!profile.active && other && !locked && (
              <p class="alert alert--info">{t.deactivateFirst(other.name)}</p>
            )}
            {!profile.active && !other && !locked && isBlocked && (
              <p class="alert alert--info">{t.blocked(blockReason(wg.policy, 'wireguard'))}</p>
            )}

            {/* Il divieto della levetta viene prima di tutti gli altri: quando
                c'è, gli altri non si possono nemmeno provare. */}
            {locked && (
              <p class="alert alert--info">
                {byToggle?.id === profile.id
                  ? t.followsSwitch
                  : t.switchControls(byToggle?.name ?? t.aConfig)}
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
                {profile.active ? t.deactivate : t.activate}
              </button>
              <button class="button button--ghost" disabled={busy} onClick={() => setMode('edit')}>
                {t.edit}
              </button>
              <button
                class="button button--ghost"
                disabled={busy}
                onClick={() => setMode('reimport')}
              >
                {t.reimport}
              </button>
              <button
                class="button button--ghost"
                disabled={busy || profile.active}
                onClick={() => setMode('delete')}
              >
                {t.remove}
              </button>
            </div>

            {profile.active && (
              <p class="muted">{t.deactivateToDelete}</p>
            )}

            <div class="sheet__actions">
              <button class="button button--ghost" disabled={busy} onClick={() => onClose(false)}>
                {actions.close}
              </button>
            </div>
          </>
        )}

        {mode === 'edit' && (
          <>
            <FieldsForm
              fields={fields}
              hasPrivateKey={profile.config.has_private_key}
              hasPreshared={profile.config.has_preshared}
              onChange={(patch) => setFields((f) => ({ ...f, ...patch }))}
            />

            {profile.active && (
              <p class="alert alert--warn">{t.activeSaveWarn}</p>
            )}

            {error && <p class="alert alert--error alert--code">{error}</p>}

            <div class="sheet__actions">
              <button class="button button--ghost" disabled={busy} onClick={() => setMode('menu')}>
                {actions.back}
              </button>
              <button
                class="button button--primary"
                disabled={busy || fields.name.trim() === ''}
                onClick={() =>
                  void guard(() => wgSave(profile.id, { ...fields, name: fields.name.trim() }))
                }
              >
                {busy ? t.saving : actions.save}
              </button>
            </div>
          </>
        )}

        {mode === 'delete' && (
          <>
            <p class="alert alert--warn">{t.confirmDelete(profile.name)}</p>

            {error && <p class="alert alert--error alert--code">{error}</p>}

            <div class="sheet__actions">
              <button class="button button--ghost" disabled={busy} onClick={() => setMode('menu')}>
                {actions.back}
              </button>
              <button
                class="button button--primary"
                disabled={busy}
                onClick={() => void guard(() => wgDelete(profile.id))}
              >
                {busy ? t.deleting : t.remove}
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
  const t = wgText();
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
    ? t.notInstalled
    : profiles.length === 0
      ? t.noneSaved
      : active
        ? `${active.name} · ${carrying ? t.active : alive ? t.activeNoTraffic : t.activeNoPeer}`
        : t.noneActive(profiles.length);

  const openProfile = picked ? (profiles.find((p) => p.id === picked) ?? null) : null;

  return (
    <section class={`card uplink uplink--${tone}`}>
      <header class="radio__head">
        <div>
          <h2 class="uplink__title">WireGuard</h2>
          <p class="muted">{subtitle}</p>
        </div>
        {carrying && <span class="badge badge--ok">{t.carries}</span>}
      </header>

      {!wg.installed && (
        <p class="alert alert--warn">{t.missingPackage}</p>
      )}

      {/* Il vincolo esterno, detto una volta sola sulla scheda: dentro al
          foglio di un profilo si ripete solo quando lì si sta per premere. */}
      {!active && isBlocked && !locked && profiles.length > 0 && (
        <p class="alert alert--info">{t.blocked(blockReason(wg.policy, 'wireguard'))}</p>
      )}

      {/* Chi comanda si dice qui, non solo dentro al foglio di un profilo: chi
          apre la scheda per capire perché il tunnel si è acceso da solo deve
          trovarne la ragione senza doverla cercare. */}
      {locked && (
        <p class="alert alert--info">{t.lockedBy(byToggle?.name ?? wg.toggle ?? '')}</p>
      )}

      {profiles.length === 0 ? (
        <p class="muted">{t.noConfigs}</p>
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
                  {profile.active && <span class="badge badge--ok">{t.active}</span>}
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
          <Row label={t.lastHandshake} value={handshakeAge(wg.status)} />
          <Row
            label={t.traffic}
            value={`↓ ${formatWgBytes(wg.status.rx)}   ↑ ${formatWgBytes(wg.status.tx)}`}
          />

          {/* Handshake a posto ma traffico che non entra: è il guasto più
              ingannevole di tutti, perché la scheda direbbe "attivo" e i
              client uscirebbero lo stesso dalla WAN. Si mostra solo quando
              c'è qualcosa che non va: quando la catena è intera, non serve. */}
          {wg.routing && broken.length > 0 && (
            <>
              <h3 class="group__title">{t.entersTunnel}</h3>
              {steps.map((step) => (
                <div key={step.label} class="node">
                  <span
                    class={step.ok ? 'dot dot--on' : 'dot'}
                    role="img"
                    aria-label={step.ok ? t.ok : t.missing}
                  />
                  <span class="node__name">{step.label}</span>
                </div>
              ))}
              <p class="alert alert--warn">
                {t.notEntering(broken.map((s) => s.fix).join(' · '))}
              </p>
            </>
          )}

          {/* Acceso e senza handshake recente: il device è su, la
              configurazione sembra a posto, e non passa niente. È la stessa
              distinzione fra "collegato" e "funziona" che regge il resto
              dell'interfaccia. */}
          {!alive && (
            <p class="alert alert--warn">
              {t.staleHandshake}
            </p>
          )}
        </>
      )}

      <div class="radio__actions">
        <button class="button button--ghost" onClick={() => setAdding(true)}>
          {t.add}
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
