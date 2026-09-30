import { useState } from 'preact/hooks';
import { useApply } from '../lib/apply';
import { AP_ENCRYPTIONS, encryptionLabel, stageApSettings, wirelessCameUp } from '../lib/wifi';
import type { ApSection } from '../lib/wifi';
import { ApplyStatus } from '../components/ApplyStatus';
import { apText } from '../i18n/ap';
import { commonText } from '../i18n/common';

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
  const t = apText();
  if (aps.length === 0) {
    return (
      <section class="card">
        <h2 class="uplink__title">{t.title}</h2>
        <p class="muted">{t.none}</p>
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
          {active.length > 0 ? t.active : t.off}
        </h2>
        <button class="button button--ghost" onClick={onEdit}>
          {t.edit}
        </button>
      </header>

      <Row label={t.ssid} value={reference.ssid || '—'} />
      <Row label={t.security} value={encryptionLabel(reference.encryption)} />
      <Row label={t.password} value={reference.has_key ? t.set : t.missing} />

      {active.length > 0 ? (
        <>
          <Row
            label={t.band}
            value={active.map((ap) => `${ap.band} GHz${ap.channel ? ` (ch ${ap.channel})` : ''}`).join(', ')}
          />
          <Row label="BSSID" value={active.map((ap) => ap.bssid).filter(Boolean).join('  ') || '—'} />
          <Row label={t.clients} value={String(clients)} />
        </>
      ) : (
        <p class="muted">{t.offOn(aps.map((ap) => `${ap.band} GHz`).join(t.and))}</p>
      )}

      {byToggle.length > 0 && (
        <p class="alert alert--info">
          {t.byToggle(byToggle.map((ap) => `${ap.band} GHz`).join(t.and))}
        </p>
      )}

      {diverging && (
        <p class="alert alert--warn">{t.diverging}</p>
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
  const t = apText();
  const actions = commonText().actions;
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

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{t.title}</h2>

        {apply.phase === 'idle' && !confirmed && (
          <form onSubmit={save}>
            <label class="field">
              <span>{t.ssidField}</span>
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
                  {ssidBytes === 0 ? t.ssidEmpty : t.ssidTooLong(ssidBytes)}
                </span>
              )}
            </label>

            <label class="field">
              <span>{t.security}</span>
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
            </label>

            <label class="field">
              <span>{t.password}</span>
              <div class="mac-row">
                <input
                  type={reveal ? 'text' : 'password'}
                  value={password}
                  autocomplete="new-password"
                  placeholder={needsPassword ? t.minPassword : t.keepPassword}
                  onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                />
                <button
                  type="button"
                  class="button button--ghost"
                  onClick={() => setReveal((v) => !v)}
                >
                  {reveal ? t.hide : t.show}
                </button>
              </div>
              {password !== '' && password.length < 8 && (
                <span class="muted">{t.shortPassword}</span>
              )}
            </label>

            {changesCredentials && (
              <p class="alert alert--warn">
                {t.credentialsWarn(AP_ROLLBACK_SECONDS)}
              </p>
            )}

            <div class="sheet__actions">
              <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
                {actions.cancel}
              </button>
              <button class="button button--primary" type="submit" disabled={!ssidOk || !passwordOk}>
                {actions.save}
              </button>
            </div>
          </form>
        )}

        <ApplyStatus apply={apply} onClose={() => onClose(true)} />

        {confirmed && (
          <>
            <p class="alert alert--ok">{t.saved}</p>
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
