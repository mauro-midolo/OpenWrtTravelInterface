import { useEffect, useState } from 'preact/hooks';
import { isValidMac, normalizeMac, randomMac } from '../lib/wifi';
import type { MacChoice, MacMode } from '../lib/wifi';
import { clientTitle, listClients } from '../lib/lan';
import type { LanClient } from '../lib/lan';

/**
 * Scelta dell'indirizzo MAC da usare su un'interfaccia.
 *
 * Compare collegandosi a una rete WiFi e configurando una porta ethernet: e' la
 * stessa scelta, con gli stessi quattro modi e gli stessi vincoli, e vederla in
 * due forme diverse farebbe pensare a due impostazioni diverse. Sta qui per lo
 * stesso motivo per cui ci sta `HostnamePicker`.
 *
 * I valori dei singoli modi restano dentro al controllo: chi lo usa tiene solo
 * la scelta effettiva. Cosi' passando da "manuale" a "casuale" e tornando
 * indietro si ritrova quello che si era digitato, invece di una casella
 * svuotata da un giro di menu.
 */
export function MacPicker({
  choice,
  onChange,
  label = 'Indirizzo MAC da usare',
}: {
  choice: MacChoice;
  onChange: (choice: MacChoice) => void;
  label?: string;
}) {
  const [random, setRandom] = useState(() =>
    choice.mode === 'random' && choice.value ? choice.value : randomMac(),
  );
  const [manual, setManual] = useState(choice.mode === 'manual' ? choice.value : '');
  const [clone, setClone] = useState(choice.mode === 'clone' ? choice.value : '');
  const [clients, setClients] = useState<LanClient[] | null>(null);

  // Il valore esce di qui gia' in forma canonica, cosi' i due chiamanti non
  // finiscono per normalizzarlo in modi diversi. La regola vera vive in
  // lib/wifi, perche' vale anche per i MAC che in questo controllo non passano
  // mai: per esempio quello ripreso dalla configurazione aprendo un foglio.
  const clean = normalizeMac;

  // L'elenco dei dispositivi si legge solo se serve davvero: e' una passata sui
  // lease e sulla tabella dei vicini, inutile per chi non clona niente.
  useEffect(() => {
    if (choice.mode !== 'clone' || clients !== null) return;
    let cancelled = false;
    void listClients()
      .then((list) => !cancelled && setClients(list))
      .catch(() => !cancelled && setClients([]));
    return () => {
      cancelled = true;
    };
  }, [choice.mode, clients]);

  const pick = (mode: MacMode) => {
    const draft =
      mode === 'random' ? random : mode === 'manual' ? manual : mode === 'clone' ? clone : '';
    onChange({ mode, value: clean(draft) });
  };

  // Si giudica il valore che esce, non quello digitato: altrimenti il messaggio
  // direbbe una cosa e il pulsante ne farebbe un'altra.
  const invalid = choice.mode === 'manual' && clean(manual) !== '' && !isValidMac(clean(manual));

  return (
    <div class="field">
      <span>{label}</span>
      <div class="chips">
        {(
          [
            ['device', 'Della scheda'],
            ['random', 'Casuale'],
            ['manual', 'Manuale'],
            ['clone', 'Di un dispositivo'],
          ] as const
        ).map(([mode, text]) => (
          <button
            key={mode}
            type="button"
            class={choice.mode === mode ? 'chip chip--on' : 'chip'}
            onClick={() => pick(mode)}
          >
            {text}
          </button>
        ))}
      </div>

      {choice.mode === 'random' && (
        <div class="mac-row">
          <code>{random}</code>
          <button
            type="button"
            class="button button--ghost"
            onClick={() => {
              const next = randomMac();
              setRandom(next);
              onChange({ mode: 'random', value: clean(next) });
            }}
          >
            Rigenera
          </button>
        </div>
      )}

      {choice.mode === 'manual' && (
        <input
          type="text"
          value={manual}
          placeholder="aa:bb:cc:dd:ee:ff"
          autocapitalize="none"
          autocomplete="off"
          spellcheck={false}
          onInput={(e) => {
            // La casella mostra quello che si sta digitando; quello che esce e'
            // gia' pulito. Ripulire anche il testo visibile impedirebbe di
            // scrivere, perche' il cursore salterebbe a ogni carattere.
            const next = (e.target as HTMLInputElement).value;
            setManual(next);
            onChange({ mode: 'manual', value: clean(next) });
          }}
        />
      )}

      {/* Il MAC di un dispositivo gia' autenticato: serve dove il portale
          autorizza gli indirizzi, e vale la pena impostarlo prima di
          collegarsi se si sa gia' che quella rete lo fa. */}
      {choice.mode === 'clone' && (
        <>
          {clients === null && <span class="muted">Leggo i dispositivi collegati…</span>}
          {clients !== null && clients.length === 0 && (
            <span class="muted">Nessun dispositivo collegato.</span>
          )}
          {clients !== null && clients.length > 0 && (
            <div class="chips">
              {clients.map((client) => (
                <button
                  key={client.mac}
                  type="button"
                  class={clone === client.mac.toLowerCase() ? 'chip chip--on' : 'chip'}
                  onClick={() => {
                    const next = clean(client.mac);
                    setClone(next);
                    onChange({ mode: 'clone', value: next });
                  }}
                >
                  {clientTitle(client)}
                </button>
              ))}
            </div>
          )}
          {clone && (
            <span class="muted">
              <code>{clone}</code> — quel dispositivo non deve restare collegato direttamente
              a questa rete.
            </span>
          )}
        </>
      )}

      {invalid && (
        <span class="muted">Indirizzo MAC non valido.</span>
      )}
    </div>
  );
}
