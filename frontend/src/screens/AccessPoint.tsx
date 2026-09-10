import { useState } from 'preact/hooks';
import { useApply } from '../lib/apply';
import { AP_ENCRYPTIONS, encryptionLabel, stageApSettings, wirelessCameUp } from '../lib/wifi';
import type { ApSection } from '../lib/wifi';
import { ApplyStatus } from '../components/ApplyStatus';

/**
 * Cambiare nome o password stacca tutti i client, che devono riagganciarsi a
 * mano con le credenziali nuove prima di poter confermare. 90 secondi non
 * bastano per farlo dal telefono.
 */
const AP_ROLLBACK_SECONDS = 240;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div class="row">
      <span class="row__label">{label}</span>
      <span class="row__value">{value}</span>
    </div>
  );
}

export function ApCard({ aps, onEdit }: { aps: ApSection[]; onEdit: () => void }) {
  if (aps.length === 0) {
    return (
      <section class="card">
        <h2 class="uplink__title">Access point</h2>
        <p class="muted">
          Nessun access point configurato. Rilancia <code>tools\setup-ap.ps1</code> dal PC.
        </p>
      </section>
    );
  }

  const active = aps.filter((ap) => ap.enabled);
  const reference = active[0] ?? aps[0];
  const clients = active.reduce((sum, ap) => sum + (ap.clients ?? 0), 0);

  // Quelli che segue la levetta: non si accendono e non si spengono da qui, e
  // dirlo su questa scheda evita di andarlo a scoprire premendo un pulsante
  // spento sulla scheda della radio.
  const byToggle = aps.filter((ap) => ap.toggle);

  // Le sezioni devono restare identiche fra le radio, altrimenti lo spostamento
  // automatico cambierebbe rete a chi e' collegato.
  const diverging = aps.some(
    (ap) => ap.ssid !== reference.ssid || ap.encryption !== reference.encryption,
  );

  return (
    <section class={`card uplink uplink--${active.length > 0 ? 'addressed' : 'disabled'}`}>
      <header class="radio__head">
        <h2 class="uplink__title">
          {active.length > 0 ? 'Access point attivo' : 'Access point spento'}
        </h2>
        <button class="button button--ghost" onClick={onEdit}>
          Modifica
        </button>
      </header>

      <Row label="Nome rete" value={reference.ssid || '—'} />
      <Row label="Sicurezza" value={encryptionLabel(reference.encryption)} />
      <Row label="Password" value={reference.has_key ? 'impostata' : 'assente'} />

      {active.length > 0 ? (
        <>
          <Row
            label="Banda"
            value={active.map((ap) => `${ap.band} GHz${ap.channel ? ` (ch ${ap.channel})` : ''}`).join(', ')}
          />
          <Row label="BSSID" value={active.map((ap) => ap.bssid).filter(Boolean).join('  ') || '—'} />
          <Row label="Dispositivi collegati" value={String(clients)} />
        </>
      ) : (
        <p class="muted">
          Configurato su {aps.map((ap) => `${ap.band} GHz`).join(' e ')}, ma spento su
          entrambe.{' '}
          {byToggle.length < aps.length && 'Riaccendilo dalla scheda della radio.'}
        </p>
      )}

      {byToggle.length > 0 && (
        <p class="alert alert--info">
          {byToggle.map((ap) => `${ap.band} GHz`).join(' e ')}: lo comanda l’interruttore
          fisico, e si accende o si spegne muovendo la levetta. Per tornare a deciderlo
          dall’interfaccia, cambia la funzione dell’interruttore in Sistema.
        </p>
      )}

      {diverging && (
        <p class="alert alert--warn">
          Le due radio hanno impostazioni diverse. Salvale di nuovo da qui per riallinearle:
          altrimenti lo spostamento automatico dell'access point cambierebbe rete sotto i
          piedi di chi è collegato.
        </p>
      )}
    </section>
  );
}

export function ApSheet({
  aps,
  onClose,
}: {
  aps: ApSection[];
  onClose: (changed: boolean) => void;
}) {
  const reference = aps.find((ap) => ap.enabled) ?? aps[0];
  const apply = useApply();

  const [ssid, setSsid] = useState(reference?.ssid ?? '');
  const [encryption, setEncryption] = useState(reference?.encryption || 'sae-mixed');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  // Il campo password nasce vuoto perche' la chiave non esce mai dal router.
  // Vuoto significa "lasciala com'e'", non "togli la password".
  const needsPassword = !reference?.has_key;
  const passwordOk = password === '' ? !needsPassword : password.length >= 8;
  // Il limite dell'SSID e' in byte, non in caratteri: un'emoji ne occupa quattro.
  const ssidBytes = new TextEncoder().encode(ssid).length;
  const ssidOk = ssidBytes > 0 && ssidBytes <= 32;

  const changesCredentials = ssid !== reference?.ssid || password !== '';

  const save = async (event: Event) => {
    event.preventDefault();
    const ok = await apply.run(() => stageApSettings(aps, { ssid, encryption, password }), {
      seconds: AP_ROLLBACK_SECONDS,
      // Non basta che il router risponda: da cavo risponde sempre, anche se
      // hostapd ha rifiutato la configurazione. Si conferma solo quando le
      // radio sono davvero risalite.
      verify: wirelessCameUp,
    });
    if (ok) setConfirmed(true);
  };

  const selected = AP_ENCRYPTIONS.find((e) => e.value === encryption);

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>Access point</h2>

        {apply.phase === 'idle' && !confirmed && (
          <form onSubmit={save}>
            <label class="field">
              <span>Nome della rete (SSID)</span>
              <input
                type="text"
                value={ssid}
                autocapitalize="none"
                autocomplete="off"
                spellcheck={false}
                onInput={(e) => setSsid((e.target as HTMLInputElement).value)}
              />
              {!ssidOk && (
                <span class="muted">
                  {ssidBytes === 0 ? 'Il nome non può essere vuoto.' : `Troppo lungo: ${ssidBytes} byte su 32.`}
                </span>
              )}
            </label>

            <label class="field">
              <span>Sicurezza</span>
              <select
                value={encryption}
                onChange={(e) => setEncryption((e.target as HTMLSelectElement).value)}
              >
                {AP_ENCRYPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {selected && <span class="muted">{selected.note}</span>}
            </label>

            <label class="field">
              <span>Password</span>
              <div class="mac-row">
                <input
                  type={reveal ? 'text' : 'password'}
                  value={password}
                  autocomplete="new-password"
                  placeholder={needsPassword ? 'almeno 8 caratteri' : 'lascia vuoto per non cambiarla'}
                  onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                />
                <button
                  type="button"
                  class="button button--ghost"
                  onClick={() => setReveal((v) => !v)}
                >
                  {reveal ? 'Nascondi' : 'Mostra'}
                </button>
              </div>
              {password !== '' && password.length < 8 && (
                <span class="muted">Servono almeno 8 caratteri.</span>
              )}
              {password === '' && !needsPassword && (
                <span class="muted">
                  La password attuale non viene mostrata: non esce mai dal router.
                </span>
              )}
            </label>

            <p class="alert alert--warn">
              Le impostazioni valgono per <strong>entrambe le radio</strong>, così
              l'access point può spostarsi senza cambiare rete.
              {changesCredentials && (
                <>
                  {' '}
                  Cambiando nome o password <strong>tutti i dispositivi si scollegano</strong>:
                  dovrai ricollegarti a mano con le credenziali nuove entro{' '}
                  {AP_ROLLBACK_SECONDS} secondi, altrimenti il router torna indietro da solo.
                </>
              )}
            </p>

            <div class="sheet__actions">
              <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
                Annulla
              </button>
              <button class="button button--primary" type="submit" disabled={!ssidOk || !passwordOk}>
                Salva
              </button>
            </div>
          </form>
        )}

        <ApplyStatus apply={apply} onClose={() => onClose(true)} />

        {confirmed && (
          <>
            <p class="alert alert--ok">Impostazioni salvate su entrambe le radio.</p>
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
