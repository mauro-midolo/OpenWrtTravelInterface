import {
  HOSTNAME_MODES,
  isValidHostname,
} from '../lib/hostname';
import type { HostnameChoice, HostnameMode } from '../lib/hostname';

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
  const invalid = choice.mode === 'custom' && choice.value !== '' && !isValidHostname(choice.value);

  const pick = (mode: HostnameMode) => onChange({ ...choice, mode });

  return (
    <div class="field">
      <span>Nome da inviare nella richiesta DHCP</span>
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
          placeholder="es. laptop"
          autocapitalize="none"
          autocomplete="off"
          spellcheck={false}
          onInput={(e) => onChange({ mode: 'custom', value: (e.target as HTMLInputElement).value })}
        />
      )}

      {invalid && (
        <span class="muted">
          Solo lettere, cifre e trattini, non all'inizio né alla fine. Niente spazi o punti:
          il server DHCP li rifiuta.
        </span>
      )}

      <span class="muted">
        {choice.mode === 'none' &&
          'La rete a monte non saprà come si chiama il router: comparirà solo come indirizzo MAC nella sua lista di client. È il default.'}
        {choice.mode === 'device' &&
          `Verrà inviato il nome del router${deviceHostname ? ` (${deviceHostname})` : ''}, che resta scritto nella lista dei client della rete a monte.`}
        {choice.mode === 'custom' &&
          'Verrà inviato questo nome. Serve sulle reti che registrano i client per nome, o per farsi riconoscere da un DHCP con assegnazioni fisse.'}
      </span>
    </div>
  );
}
