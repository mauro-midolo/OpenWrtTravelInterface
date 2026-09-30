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

import { commonText } from '../i18n/common';
import { hiddenText } from '../i18n/hidden';
import { useState } from 'preact/hooks';
import {
  BANDS,
  bandConflicts,
  bandLabel,
  bandsFromScan,
  hasAnyBand,
  macOnBothBands,
  saveNetwork,
} from '../lib/networks';
import type { BandSet, SavedNetwork } from '../lib/networks';
import { STA_ENCRYPTIONS, isValidPassphrase, isValidSsid, needsKey } from '../lib/wifi';
import type { Band } from '../lib/wifi';
import { HOSTNAME_OFF } from '../lib/hostname';

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
  /**
   * Le bande su cui vale questa rete.
   *
   * Si parte da quella della radio da cui si e' aperto il modulo, ma qui - a
   * differenza del salvataggio da una scansione - si puo' togliere: nessuno
   * l'ha vista da nessuna parte, e' un nome scritto a mano, quindi non c'e'
   * una banda che valga come testimone.
   */
  const [bands, setBands] = useState<BandSet>(() => bandsFromScan(initialBand));
  const t = hiddenText();
  const [encryption, setEncryption] = useState<string>('psk2');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wantsKey = needsKey(encryption);

  // Un doppione e' una voce con lo stesso nome che copre una delle bande
  // scelte: su quella radio verrebbe usata quella, e questa non sarebbe mai
  // provata. Le altre bande restano libere, e infatti il messaggio dice quale
  // e' occupata.
  const conflicts = bandConflicts(saved, ssid.trim(), bands);

  const ssidOk = isValidSsid(ssid.trim());
  const passwordOk = !wantsKey || isValidPassphrase(password);
  const canSave =
    ssidOk && passwordOk && hasAnyBand(bands) && conflicts.length === 0 && !busy;

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
          bands,
          hidden: true,
          // Il MAC della radio, su tutte e due le bande: e' il default, e da
          // qui non si configura. Si cambia dalla rete salvata, una banda alla
          // volta, come per ogni altra rete.
          mac: macOnBothBands({ mode: 'device', value: '' }),
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
        <h2>{t.title}</h2>

        <form onSubmit={save}>
          <label class="field">
            <span>{t.ssid}</span>
            <input
              type="text"
              value={ssid}
              autocomplete="off"
              autocapitalize="none"
              spellcheck={false}
              placeholder={t.ssidPlaceholder}
              onInput={(e) => setSsid((e.target as HTMLInputElement).value)}
            />
          </label>

          {/* Errori solo su un campo gia' toccato: dire "obbligatorio" su una
              casella ancora vuota accusa di un errore non ancora commesso. */}
          {ssid !== '' && !ssidOk && (
            <p class="alert alert--error">{t.ssidTooLong}</p>
          )}

          <div class="field">
            <span id="banda-nascosta">{t.bands}</span>
            <div role="group" aria-labelledby="banda-nascosta">
              {BANDS.map((entry) => (
                <label class="check" key={entry}>
                  <input
                    type="checkbox"
                    checked={bands[entry]}
                    onChange={(e) =>
                      setBands({ ...bands, [entry]: (e.target as HTMLInputElement).checked })
                    }
                  />
                  <span>{bandLabel(entry)}</span>
                </label>
              ))}
            </div>
          </div>

          {!hasAnyBand(bands) && (
            <p class="alert alert--error">{t.pickBand}</p>
          )}

          <label class="field">
            <span>{t.security}</span>
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
          </label>

          {/* Solo i parametri che servono davvero a collegarsi: su una rete
              aperta la casella della password non compare, invece di comparire
              disattivata a far chiedere cosa manchi. */}
          {wantsKey && (
            <label class="field">
              <span>{t.password}</span>
              <input
                type="password"
                value={password}
                autocomplete="new-password"
                placeholder={t.minPassword}
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              />
            </label>
          )}

          {wantsKey && password !== '' && !passwordOk && (
            <p class="alert alert--error">{t.badPassword}</p>
          )}

          <label class="field">
            <span>{t.note}</span>
            <input
              type="text"
              value={note}
              placeholder={t.notePlaceholder}
              onInput={(e) => setNote((e.target as HTMLInputElement).value)}
            />
          </label>

          {conflicts.map(({ band, net }) => (
            <p class="alert alert--warn" key={band}>
              {t.conflict(net.ssid, bandLabel(band))}
            </p>
          ))}

          {error && <p class="alert alert--error alert--code">{error}</p>}

          <div class="sheet__actions">
            <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
              {commonText().actions.cancel}
            </button>
            <button class="button button--primary" type="submit" disabled={!canSave}>
              {commonText().actions.save}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
