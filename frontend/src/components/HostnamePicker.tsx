import {
  HOSTNAME_MODES,
  isValidHostname,
} from '../lib/hostname';
import type { HostnameChoice, HostnameMode } from '../lib/hostname';
import { hostnameText } from '../i18n/hostname';

/**
 * Scelta del nome da mandare nella richiesta DHCP.
 *
 * Compare sia quando ci si collega a una rete nuova sia nelle impostazioni di
 * una WAN gia' configurata: e' la stessa scelta, e vederla in due forme diverse
 * farebbe pensare a due impostazioni diverse.
 */
export function HostnamePicker({
  choice,
  deviceHostname,
  onChange,
}: {
  choice: HostnameChoice;
  /** Nome del router, per dire cosa verrebbe inviato davvero. */
  deviceHostname?: string;
  onChange: (choice: HostnameChoice) => void;
}) {
  const t = hostnameText();
  const invalid = choice.mode === 'custom' && choice.value !== '' && !isValidHostname(choice.value);

  const pick = (mode: HostnameMode) => onChange({ ...choice, mode });

  return (
    <div class="field">
      <span>{t.field}</span>
      <div class="chips">
        {HOSTNAME_MODES.map((entry) => (
          <button
            key={entry.mode}
            type="button"
            class={choice.mode === entry.mode ? 'chip chip--on' : 'chip'}
            onClick={() => pick(entry.mode)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {choice.mode === 'custom' && (
        <input
          type="text"
          value={choice.value}
          placeholder={t.placeholder}
          autocapitalize="none"
          autocomplete="off"
          spellcheck={false}
          onInput={(e) => onChange({ mode: 'custom', value: (e.target as HTMLInputElement).value })}
        />
      )}

      {invalid && (
        <span class="muted">{t.invalid}</span>
      )}

      {choice.mode === 'device' && deviceHostname && (
        <span class="muted">{deviceHostname}</span>
      )}
    </div>
  );
}
