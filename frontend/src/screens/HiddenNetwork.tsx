/**
 * Aggiunta manuale di una rete nascosta.
 *
 * Una rete che non annuncia il proprio SSID non compare in nessuna scansione,
 * quindi non c'e' una riga da toccare per collegarsi: l'unico modo e' dire al
 * router come si chiama. Questo foglio raccoglie i parametri che altrove si
 * ricavano dai beacon - nome, banda, cifratura - e li salva come una qualsiasi
 * rete salvata.
 *
 * Salvare non prova a collegarsi, di proposito: scrive solo in
 * `/etc/config/travel`, che non tocca la rete in funzione. Cosi' la rete si
 * puo' configurare stando a casa e usarla in albergo la settimana dopo, che e'
 * il caso normale per una rete d'ufficio.
 */

import { useState } from 'preact/hooks';
import { saveNetwork, findSaved } from '../lib/networks';
import type { SavedNetwork } from '../lib/networks';
import { STA_ENCRYPTIONS, isValidPassphrase, isValidSsid, needsKey } from '../lib/wifi';
import type { Band } from '../lib/wifi';
import { HOSTNAME_OFF } from '../lib/hostname';

const BANDS: Array<{ value: Band; label: string }> = [
  { value: '2.4', label: '2.4 GHz' },
  { value: '5', label: '5 GHz' },
];

export function HiddenSheet({
  saved,
  band: initialBand,
  onClose,
}: {
  saved: SavedNetwork[];
  /** La banda della radio da cui si e' aperto: e' solo un punto di partenza. */
  band: Band;
  onClose: (changed: boolean) => void;
}) {
  const [ssid, setSsid] = useState('');
  const [band, setBand] = useState<Band>(initialBand);
  const [encryption, setEncryption] = useState<string>('psk2');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = STA_ENCRYPTIONS.find((e) => e.value === encryption);
  const wantsKey = needsKey(encryption);

  // La banda fa parte dell'identita': la stessa rete nascosta a 2.4 e a 5 GHz
  // sono due configurazioni, e solo quella sulla stessa banda e' un doppione.
  const duplicate = findSaved(saved, ssid.trim(), band);

  const ssidOk = isValidSsid(ssid.trim());
  const passwordOk = !wantsKey || isValidPassphrase(password);
  const canSave = ssidOk && passwordOk && !duplicate && !busy;

  const save = async (event: Event) => {
    event.preventDefault();
    if (!canSave) return;

    setBusy(true);
    setError(null);
    try {
      await saveNetwork(
        {
          ssid: ssid.trim(),
          // Una rete aperta non ha password: il campo non viene nemmeno
          // mostrato, e qui non deve arrivarci per sbaglio quello digitato
          // prima di cambiare cifratura.
          password: wantsKey ? password : '',
          encryption,
          band,
          hidden: true,
          macMode: 'device',
          macValue: '',
          // Il nome DHCP parte dal default del progetto - non inviarlo - e si
          // cambia dalla rete salvata come per tutte le altre.
          hostname: HOSTNAME_OFF,
          note: note.trim(),
        },
        saved,
      );
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>Aggiungi rete nascosta</h2>

        <form onSubmit={save}>
          <p class="muted">
            Una rete che non annuncia il proprio nome non compare cercando: va scritta a
            mano. Viene salvata anche se adesso non è raggiungibile, e ci si collega quando
            si è a portata.
          </p>

          <label class="field">
            <span>Nome della rete (SSID)</span>
            <input
              type="text"
              value={ssid}
              autocomplete="off"
              autocapitalize="none"
              spellcheck={false}
              placeholder="esattamente com'è scritto"
              onInput={(e) => setSsid((e.target as HTMLInputElement).value)}
            />
            <span class="muted">
              Maiuscole e minuscole contano: <code>Ufficio</code> e <code>ufficio</code> sono
              due reti diverse.
            </span>
          </label>

          {/* Errori solo su un campo gia' toccato: dire "obbligatorio" su una
              casella ancora vuota accusa di un errore non ancora commesso. */}
          {ssid !== '' && !ssidOk && (
            <p class="alert alert--error">Il nome può essere lungo al massimo 32 byte.</p>
          )}

          <div class="field">
            <span id="banda-nascosta">Banda</span>
            <div class="chips" role="group" aria-labelledby="banda-nascosta">
              {BANDS.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  class={band === entry.value ? 'chip chip--on' : 'chip'}
                  aria-pressed={band === entry.value}
                  onClick={() => setBand(entry.value)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <span class="muted">
              Le due bande sono configurazioni distinte: se la stessa rete nascosta c'è su
              entrambe, va aggiunta due volte.
            </span>
          </div>

          <label class="field">
            <span>Sicurezza</span>
            <select
              value={encryption}
              onChange={(e) => setEncryption((e.target as HTMLSelectElement).value)}
            >
              {STA_ENCRYPTIONS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
            {chosen && <span class="muted">{chosen.note}</span>}
          </label>

          {/* Solo i parametri che servono davvero a collegarsi: su una rete
              aperta la casella della password non compare, invece di comparire
              disattivata a far chiedere cosa manchi. */}
          {wantsKey && (
            <label class="field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                autocomplete="new-password"
                placeholder="almeno 8 caratteri"
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              />
            </label>
          )}

          {wantsKey && password !== '' && !passwordOk && (
            <p class="alert alert--error">
              La password deve essere fra 8 e 63 caratteri.
            </p>
          )}

          <label class="field">
            <span>Nota (facoltativa)</span>
            <input
              type="text"
              value={note}
              placeholder="es. rete dell'ufficio, non compare nell'elenco"
              onInput={(e) => setNote((e.target as HTMLInputElement).value)}
            />
          </label>

          {duplicate && (
            <p class="alert alert--warn">
              {duplicate.band === ''
                ? `«${duplicate.ssid}» è già salvata per entrambe le bande.`
                : `«${duplicate.ssid}» è già salvata a ${duplicate.band} GHz.`}{' '}
              Modificala dalle reti salvate invece di aggiungerne una seconda uguale.
            </p>
          )}

          {error && <p class="alert alert--error alert--code">{error}</p>}

          <div class="sheet__actions">
            <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
              Annulla
            </button>
            <button class="button button--primary" type="submit" disabled={!canSave}>
              Salva
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
