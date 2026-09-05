import { useEffect, useState } from 'preact/hooks';
import { useApply } from '../lib/apply';
import { stageStaMac, wirelessCameUp } from '../lib/wifi';
import { findSaved, listSaved, updateNetwork } from '../lib/networks';
import type { SavedNetwork } from '../lib/networks';
import {
  PORTAL_LABEL,
  checkPortal,
  forgetPortal,
  listPortalMemory,
  portalAt,
  portalReason,
  portalWhen,
} from '../lib/portal';
import type { PortalMemory, PortalResult } from '../lib/portal';
import { clientDetail, clientLink, clientTitle, listClients } from '../lib/lan';
import type { LanClient } from '../lib/lan';
import type { DashWan } from '../lib/dashboard';
import { ApplyStatus } from '../components/ApplyStatus';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div class="row">
      <span class="row__label">{label}</span>
      <span class="row__value">{value}</span>
    </div>
  );
}

/**
 * L'esito della verifica dell'uscita, dentro la scheda della WAN.
 *
 * Sta li' e non in una schermata sua perche' e' la risposta a una domanda che
 * si fa guardando quella WAN - "questa qui porta da qualche parte?" - e una
 * scheda separata costringerebbe a tenere a mente quale riga corrisponde a
 * quale, che e' esattamente il lavoro che l'interfaccia deve togliere.
 */
export function PortalPanel({
  wan,
  onDone,
  onClone,
}: {
  wan: DashWan;
  /** Il verdetto e' cambiato: la dashboard puo' rileggere. */
  onDone: () => void;
  onClone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<PortalResult | null>(null);

  // Il risultato appena chiesto vince su quello della dashboard finche' non
  // arriva il polling successivo: altrimenti premere "Verifica" sembrerebbe non
  // fare niente per un paio di secondi.
  const result = fresh ?? wan.portal;

  const recheck = async () => {
    setBusy(true);
    setError(null);
    try {
      setFresh(await checkPortal(wan.network));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = (
    <div class="radio__actions">
      <button class="button button--ghost" disabled={busy} onClick={() => void recheck()}>
        {busy ? 'Verifico…' : 'Verifica adesso'}
      </button>
      {/* Il MAC clonato serve dove il portale autentica gli indirizzi, ma e'
          utile anche prima di aver visto il portale: chi conosce l'albergo lo
          imposta e basta. Per questo il pulsante non aspetta il verdetto. */}
      {wan.kind === 'wifi' && wan.section && (
        <button class="button button--ghost" onClick={onClone}>
          Usa il MAC di un dispositivo
        </button>
      )}
    </div>
  );

  if (!result) {
    return (
      <>
        <h2>Uscita verso Internet</h2>
        <p class="muted">
          Non ancora verificata. Il router lo controlla da solo poco dopo che la WAN prende
          un indirizzo.
        </p>
        {verify}
        {error && <p class="alert alert--error alert--code">{error}</p>}
      </>
    );
  }

  const reason = portalReason(result);

  return (
    <>
      <h2>Uscita verso Internet</h2>
      <Row
        label={PORTAL_LABEL[result.state]}
        value={[portalAt(result), result.http ? `HTTP ${result.http}` : '']
          .filter(Boolean)
          .join(' · ')}
      />

      {result.state === 'portal' && (
        <>
          <p class="alert alert--warn">
            Questa rete ha un <strong>portale di accesso</strong>: il collegamento c'è, ma
            finché non fai il login non passa niente. Apri la pagina dal telefono — il
            traffico esce da qui, quindi è la stessa pagina che vedresti collegandoti alla
            rete direttamente.
          </p>
          {/* Un link vero e non una chiamata: il login deve avvenire nel
              browser di chi guarda, con i suoi cookie e la sua sessione. Il
              router non puo' farlo al posto suo, e fingere di poterlo fare
              sarebbe la promessa peggiore da rompere in una hall d'albergo. */}
          <a class="button button--primary" href={result.url} target="_blank" rel="noreferrer">
            Apri la pagina di accesso
          </a>
          <p class="muted">
            Se la pagina non si apre, prova a visitare un indirizzo qualsiasi in{' '}
            <strong>http://</strong> (non https): è così che il portale si fa vedere.
            Fatto il login, torna qui e verifica di nuovo.
          </p>
        </>
      )}

      {result.state === 'blocked' && (
        <p class="alert alert--error">
          La WAN ha un indirizzo ma <strong>non esce niente</strong>: nessuna risposta
          dall'esterno. Non è un portale — quello risponderebbe — ma una rete che non porta
          da nessuna parte.
          {reason ? ` ${reason}` : ''}
        </p>
      )}

      {result.state === 'unknown' && (
        <p class="alert alert--warn">
          {reason || 'La verifica non ha potuto dire niente.'}
        </p>
      )}

      {result.state === 'online' && result.tool === 'uclient-fetch' && (
        <p class="muted">
          Verificata con uclient-fetch: segue i rimandi, quindi se comparisse un portale non
          saprebbe dire dove si trova la sua pagina.
        </p>
      )}

      {verify}
      {error && <p class="alert alert--error alert--code">{error}</p>}
    </>
  );
}

/**
 * Fa indossare al router il MAC di un dispositivo della LAN.
 *
 * A cosa serve: certi portali autenticano l'indirizzo MAC per un certo tempo.
 * Se hai gia' fatto l'accesso dal telefono - o l'hai pagato - il router puo'
 * presentarsi con quello stesso indirizzo ed essere riconosciuto come gia'
 * autorizzato, invece di rifare tutto da capo.
 *
 * Il MAC si sceglie da un elenco e non si digita: sono dodici cifre che nessuno
 * ricorda, e ricopiarle a mano e' il modo piu' facile di sbagliarne una - con il
 * risultato che il portale non riconosce niente e non si capisce perche'.
 */
export function MacCloneSheet({
  wan,
  onClose,
}: {
  wan: DashWan;
  onClose: (changed: boolean) => void;
}) {
  const apply = useApply();
  const [clients, setClients] = useState<LanClient[] | null>(null);
  const [chosen, setChosen] = useState<string>('');
  const [saved, setSaved] = useState<SavedNetwork | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listClients()
      .then((list) => !cancelled && setClients(list))
      .catch(() => !cancelled && setClients([]));
    return () => {
      cancelled = true;
    };
  }, []);

  // La voce salvata di questa rete, se c'e': senza aggiornarla anche li', alla
  // prima riconnessione automatica travelD rimetterebbe il MAC di prima e la
  // scelta sembrerebbe sparita da sola.
  useEffect(() => {
    if (!wan.ssid) return;
    let cancelled = false;
    void listSaved()
      .then((list) => !cancelled && setSaved(findSaved(list, wan.ssid, wan.band) ?? null))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [wan.ssid, wan.band]);

  // Il MAC arriva come parametro e non dallo stato: "torna a quello della
  // scheda" azzera la scelta e parte nello stesso gesto, e leggendo lo stato si
  // userebbe ancora il valore di prima.
  const go = async (mac: string) => {
    const ok = await apply.run(() => stageStaMac(wan.section, mac), {
      // Da cavo il router risponde comunque: si conferma solo se la radio ha
      // davvero accettato il MAC nuovo e si e' rialzata.
      verify: wirelessCameUp,
      // Cambiare MAC fa cadere l'associazione e rifare il DHCP: chi guarda dal
      // WiFi ha bisogno di piu' dei novanta secondi soliti per tornare dentro.
      seconds: 150,
    });
    if (!ok) return;

    if (saved) {
      try {
        await updateNetwork(saved.section, {
          mac_mode: mac ? 'clone' : 'device',
          mac_value: mac,
        });
      } catch {
        // La radio ha gia' il MAC nuovo: non averlo scritto fra le reti salvate
        // si vede alla prossima riconnessione automatica, non adesso.
      }
    }
    setDone(true);
  };

  const current = wan.mac ? wan.mac.toLowerCase() : '';

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>MAC da usare su {wan.ssid || wan.network}</h2>

        {apply.phase === 'idle' && (
          <>
            <p class="muted">
              Adesso il router si presenta come <code>{current || '—'}</code>.
            </p>

            {clients === null && <p class="muted">Leggo i dispositivi collegati…</p>}

            {clients !== null && clients.length === 0 && (
              <p class="muted">
                Nessun dispositivo visto sulla LAN. Collega al router il telefono con cui hai
                fatto l'accesso: comparirà qui.
              </p>
            )}

            {clients !== null && clients.length > 0 && (
              <ul class="list list--flush">
                {clients.map((client) => (
                  <li key={client.mac}>
                    <button
                      class="net"
                      type="button"
                      onClick={() => setChosen(client.mac.toLowerCase())}
                    >
                      <span class="net__main">
                        <span class="net__ssid">{clientTitle(client)}</span>
                        <span class="net__meta">
                          {[
                            clientDetail(client),
                            clientLink(client),
                            client.source === 'arp' ? 'senza lease DHCP' : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <span class="net__side">
                        {chosen === client.mac.toLowerCase() && (
                          <span class="badge badge--ok">scelto</span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <p class="alert alert--warn">
              Mentre il router usa il MAC di un dispositivo, quel dispositivo non deve
              restare collegato <strong>direttamente</strong> alla stessa rete: due schede
              con lo stesso indirizzo si tolgono la connessione a vicenda. Passando dal
              router va bene, ed è il punto.
            </p>

            <div class="sheet__actions">
              <button class="button button--ghost" onClick={() => onClose(false)}>
                Annulla
              </button>
              {current && (
                <button
                  class="button button--ghost"
                  onClick={() => {
                    setChosen('');
                    void go('');
                  }}
                >
                  MAC della scheda
                </button>
              )}
              <button
                class="button button--primary"
                disabled={!chosen}
                onClick={() => void go(chosen)}
              >
                Usa questo MAC
              </button>
            </div>
          </>
        )}

        <ApplyStatus apply={apply} onClose={() => onClose(true)} />

        {done && (
          <>
            <p class="alert alert--ok">
              Fatto. Il router si presenta con il MAC scelto: se il portale lo riconosce come
              già autenticato, Internet passa senza rifare il login. Verifica dalla scheda
              della WAN.
            </p>
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

/**
 * Le reti su cui e' gia' stato incontrato un portale.
 *
 * Non e' un registro per completezza: e' cio' che permette di sapere *prima* di
 * ricollegarsi che quella rete chiedera' un login, e quando l'ultimo accesso
 * era andato a buon fine. Su una rete d'albergo con accesso a tempo, la
 * seconda informazione e' quella che dice se serve rifarlo.
 *
 * La scheda non compare finche' non c'e' niente da mostrare: un elenco vuoto
 * per sempre sarebbe rumore in fondo a una schermata gia' lunga.
 */
export function PortalMemoryCard() {
  const [entries, setEntries] = useState<PortalMemory[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    void listPortalMemory()
      .then(setEntries)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(reload, []);

  const forget = async (section: string) => {
    try {
      await forgetPortal(section);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (entries.length === 0 && !error) return null;

  return (
    <section class="card">
      <h2 class="uplink__title">Reti con portale</h2>
      <p class="muted">
        Reti su cui è già comparsa una pagina di accesso. L'ultimo accesso riuscito dice se
        quello di prima è ancora valido o se va rifatto.
      </p>

      {entries.map((entry) => (
        <div key={entry.section} class="port">
          <div class="port__main">
            <strong>{entry.label || entry.key}</strong>
            <span class="muted">
              visto {portalWhen(entry.last_seen)} · accesso{' '}
              {entry.last_login ? portalWhen(entry.last_login) : 'mai riuscito'}
            </span>
          </div>
          <button class="button button--ghost" onClick={() => void forget(entry.section)}>
            Dimentica
          </button>
        </div>
      ))}

      {error && <p class="alert alert--warn alert--code">{error}</p>}
    </section>
  );
}
