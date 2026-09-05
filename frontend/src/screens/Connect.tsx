import { useEffect, useState } from 'preact/hooks';
import { useApply } from '../lib/apply';
import {
  getUplinks,
  isValidMac,
  randomMac,
  stageConnection,
  uplinkState,
  wirelessCameUp,
} from '../lib/wifi';
import { encryptionForSta } from '../lib/wifi';
import type { ConnectionPlan, MacChoice, MacMode, ScanResult, Uplink } from '../lib/wifi';
import { findSaved, fromScan, hostnameOf, markUsed, saveNetwork, updateNetwork } from '../lib/networks';
import type { SavedNetwork } from '../lib/networks';
import { HOSTNAME_OFF, getSystem, isValidHostname } from '../lib/hostname';
import type { HostnameChoice } from '../lib/hostname';
import { checkPortal, portalReason } from '../lib/portal';
import type { PortalResult } from '../lib/portal';
import { clientTitle, listClients } from '../lib/lan';
import type { LanClient } from '../lib/lan';
import { HostnamePicker } from '../components/HostnamePicker';
import { ApplyStatus } from '../components/ApplyStatus';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Quanto si aspetta, dopo la conferma, che la STA prenda un indirizzo. */
const DHCP_WAIT_SECONDS = 30;

export function ConnectSheet({
  net,
  plan,
  saved,
  onClose,
}: {
  net: ScanResult;
  plan: ConnectionPlan;
  saved: SavedNetwork[];
  onClose: (changed: boolean) => void;
}) {
  const apply = useApply();
  const [password, setPassword] = useState('');
  const [macMode, setMacMode] = useState<MacMode>('device');
  const [macRandom, setMacRandom] = useState(randomMac);
  const [macManual, setMacManual] = useState('');
  const [macClone, setMacClone] = useState('');
  const [clients, setClients] = useState<LanClient[] | null>(null);
  const [remember, setRemember] = useState(true);
  const [checking, setChecking] = useState(false);
  const [probing, setProbing] = useState(false);
  const [portal, setPortal] = useState<PortalResult | null>(null);
  const [uplink, setUplink] = useState<Uplink | null>(null);
  const [done, setDone] = useState(false);
  const [deviceHostname, setDeviceHostname] = useState('');

  // La banda conta: la stessa rete a 2.4 e a 5 GHz sono due voci distinte, e
  // salvare solo la prima lascerebbe l'altra radio senza candidate.
  const already = findSaved(saved, net.ssid, net.band);

  // Il nome DHCP si chiede a ogni rete nuova, e parte da "non inviarlo": e' una
  // scelta per rete, perche' la rete di casa e quella di un albergo non
  // meritano lo stesso trattamento. Su una rete gia' salvata si riprende
  // quello che aveva, altrimenti collegarsi dal pannello lo azzererebbe.
  const [hostname, setHostname] = useState<HostnameChoice>(
    already ? hostnameOf(already) : HOSTNAME_OFF,
  );

  // Serve solo a dire cosa verrebbe inviato scegliendo "nome del router": se
  // non si riesce a leggerlo, la scelta resta possibile senza il dettaglio.
  useEffect(() => {
    let cancelled = false;
    void getSystem()
      .then((info) => !cancelled && setDeviceHostname(info.hostname))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // L'elenco dei dispositivi si legge solo se serve davvero: e' una passata sui
  // lease e sulla tabella dei vicini, inutile per chi non clona niente.
  useEffect(() => {
    if (macMode !== 'clone' || clients !== null) return;
    let cancelled = false;
    void listClients()
      .then((list) => !cancelled && setClients(list))
      .catch(() => !cancelled && setClients([]));
    return () => {
      cancelled = true;
    };
  }, [macMode, clients]);

  const macValue =
    macMode === 'random' ? macRandom : macMode === 'clone' ? macClone : macManual;
  const macOk = macMode === 'device' || isValidMac(macValue);
  const passwordOk = net.open || password.length >= 8;
  const hostnameOk = hostname.mode !== 'custom' || isValidHostname(hostname.value.trim());

  const start = async (event: Event) => {
    event.preventDefault();
    const mac: MacChoice = { mode: macMode, value: macValue.toLowerCase() };

    const confirmed = await apply.run(() => stageConnection(net, password, plan, mac, hostname), {
      // "Il router risponde" non basta: da cavo risponde sempre. Si conferma
      // solo se le radio hanno davvero accettato la configurazione.
      verify: wirelessCameUp,
    });
    if (confirmed) void checkUplink();
  };

  /** Distingue gli esiti che dall'esterno sembrano uguali. */
  const checkUplink = async () => {
    setChecking(true);
    const deadline = Date.now() + DHCP_WAIT_SECONDS * 1000;
    let last: Uplink | null = null;

    while (Date.now() < deadline) {
      try {
        // Solo l'uplink di questa radio: l'altra puo' essere collegata a
        // un'altra rete e il suo esito non dice niente su questa.
        const found = (await getUplinks()).find((u) => u.radio === plan.staRadio.name);
        if (found) {
          last = found;
          setUplink(found);
          if (uplinkState(found) === 'addressed') break;
        }
      } catch {
        // Il reload della rete puo' far cadere una chiamata: si riprova.
      }
      await sleep(2000);
    }

    setChecking(false);

    // Presa la rete, resta la domanda vera: si esce davvero? E' il momento in
    // cui serve saperlo - si e' appena scelta la rete e si sta guardando lo
    // schermo - e aspettare il giro del daemon vorrebbe dire scoprirlo dopo,
    // altrove, quando non e' piu' chiaro a cosa si riferisca.
    let verdict: PortalResult | null = null;
    if (last && uplinkState(last) === 'addressed') {
      setProbing(true);
      try {
        verdict = await checkPortal(`wwan_${plan.staRadio.name}`);
        setPortal(verdict);
      } catch {
        // Una verifica che non riesce non toglie niente alla connessione appena
        // fatta: si mostra l'esito senza, come prima della Fase 5.
      }
      setProbing(false);
    }

    await remember_(last, verdict);
    setDone(true);
  };

  /**
   * Salva la rete solo se si e' agganciata davvero.
   *
   * Una password sbagliata non si vede prima di provare: salvarla comunque
   * significherebbe riproporla alla riconnessione automatica, che continuerebbe
   * a fallire senza che si capisca perche'.
   */
  const remember_ = async (result: Uplink | null, verdict: PortalResult | null) => {
    const state = result ? uplinkState(result) : 'unassociated';
    if (state === 'unassociated' || state === 'disabled') return;

    // Connessa e dietro un portale non e' "connessa": e' l'esito che conviene
    // ritrovare nell'elenco delle reti salvate, perche' dice che la prossima
    // volta servira' di nuovo un login.
    const outcome =
      state === 'addressed' ? (verdict?.state === 'portal' ? 'portal' : 'ok') : 'no-address';

    try {
      if (already) {
        // Il nome DHCP puo' essere stato cambiato adesso: la voce salvata deve
        // ricordarselo, altrimenti la riconnessione automatica rimetterebbe
        // quello vecchio senza che si capisca perche'.
        await markUsed(already.section, outcome);
        await updateNetwork(already.section, {
          hostname_mode: hostname.mode,
          hostname_value: hostname.mode === 'custom' ? hostname.value.trim() : '',
        });
      } else if (remember && !net.hidden) {
        await saveNetwork(
          fromScan(
            net,
            password,
            macMode,
            macValue.toLowerCase(),
            encryptionForSta(net),
            hostname,
          ),
          saved,
        );
      }
    } catch {
      // Non salvarla non compromette la connessione appena fatta.
    }
  };

  const idle = apply.phase === 'idle';

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{net.hidden ? 'Rete nascosta' : net.ssid}</h2>

        {idle && (
          <form onSubmit={start}>
            <p class="muted">
              {net.band} GHz · canale {net.channel} · {net.security}
            </p>

            <p class="alert alert--info">
              Il router userà la radio <strong>{plan.staRadio.band} GHz</strong> per
              collegarsi. Gli access point restano accesi dove sono: questa operazione non
              ne tocca nessuno.
            </p>

            {plan.sharesRadioWithAp && (
              <p class="alert alert--warn">
                L'access point su <strong>{plan.staRadio.band} GHz</strong> condivide questa
                radio: erediterà il canale della rete e potrà interrompersi quando la rete
                cade.
                {plan.otherApActive && plan.otherRadio ? (
                  <>
                    {' '}
                    Quello su <strong>{plan.otherRadio.band} GHz</strong> resta indipendente:
                    è da lì che rientri se succede.
                  </>
                ) : (
                  <>
                    {' '}
                    <strong>
                      Sull'altra radio non c'è nessun access point acceso: accendilo prima
                    </strong>
                    , altrimenti resteresti senza via di rientro se questa rete cade.
                  </>
                )}
              </p>
            )}

            {plan.noApAtAll && (
              <p class="alert alert--warn">
                Non c'è <strong>nessun access point acceso</strong>. Se ti stai collegando
                via cavo va bene, ma in viaggio accendine uno prima di partire.
              </p>
            )}

            {!net.open && (
              <label class="field">
                <span>Password della rete</span>
                <input
                  type="password"
                  value={password}
                  autocomplete="off"
                  autofocus
                  onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                />
              </label>
            )}

            <div class="field">
              <span>Indirizzo MAC da usare</span>
              <div class="chips">
                {(
                  [
                    ['device', 'Della scheda'],
                    ['random', 'Casuale'],
                    ['manual', 'Manuale'],
                    ['clone', 'Di un dispositivo'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    class={macMode === mode ? 'chip chip--on' : 'chip'}
                    onClick={() => setMacMode(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {macMode === 'random' && (
                <div class="mac-row">
                  <code>{macRandom}</code>
                  <button
                    type="button"
                    class="button button--ghost"
                    onClick={() => setMacRandom(randomMac())}
                  >
                    Rigenera
                  </button>
                </div>
              )}

              {macMode === 'manual' && (
                <input
                  type="text"
                  value={macManual}
                  placeholder="aa:bb:cc:dd:ee:ff"
                  autocapitalize="none"
                  autocomplete="off"
                  spellcheck={false}
                  onInput={(e) => setMacManual((e.target as HTMLInputElement).value)}
                />
              )}

              {/* Il MAC di un dispositivo gia' autenticato: serve dove il
                  portale autorizza gli indirizzi, e vale la pena impostarlo
                  prima di collegarsi se si sa gia' che quella rete lo fa. */}
              {macMode === 'clone' && (
                <>
                  {clients === null && <span class="muted">Leggo i dispositivi collegati…</span>}
                  {clients !== null && clients.length === 0 && (
                    <span class="muted">
                      Nessun dispositivo visto sulla LAN. Collega al router il telefono con
                      cui hai fatto l'accesso e riprova.
                    </span>
                  )}
                  {clients !== null && clients.length > 0 && (
                    <div class="chips">
                      {clients.map((client) => (
                        <button
                          key={client.mac}
                          type="button"
                          class={macClone === client.mac.toLowerCase() ? 'chip chip--on' : 'chip'}
                          onClick={() => setMacClone(client.mac.toLowerCase())}
                        >
                          {clientTitle(client)}
                        </button>
                      ))}
                    </div>
                  )}
                  {macClone && (
                    <span class="muted">
                      <code>{macClone}</code> — mentre il router lo usa, quel dispositivo non
                      deve restare collegato direttamente a questa rete.
                    </span>
                  )}
                </>
              )}

              {macMode === 'manual' && macManual !== '' && !macOk && (
                <span class="muted">
                  Formato non valido, o primo byte dispari (sarebbe un indirizzo multicast).
                </span>
              )}
            </div>

            <HostnamePicker
              choice={hostname}
              deviceHostname={deviceHostname}
              onChange={setHostname}
            />

            {already ? (
              <p class="muted">
                Questa rete è già salvata
                {already.band ? ` fra quelle a ${already.band} GHz` : ' per entrambe le bande'}:
                l'ultimo utilizzo verrà aggiornato.
              </p>
            ) : (
              <label class="check">
                <input
                  type="checkbox"
                  checked={remember}
                  disabled={net.hidden}
                  onChange={(e) => setRemember((e.target as HTMLInputElement).checked)}
                />
                <span>
                  Salva questa rete{net.band ? ` fra quelle a ${net.band} GHz` : ''}, così la
                  ritrovi senza ridigitare la password. Viene salvata solo se la connessione
                  riesce.
                </span>
              </label>
            )}

            <div class="sheet__actions">
              <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
                Annulla
              </button>
              <button
                class="button button--primary"
                type="submit"
                disabled={!passwordOk || !macOk || !hostnameOk}
              >
                Connetti
              </button>
            </div>
          </form>
        )}

        <ApplyStatus apply={apply} onClose={() => onClose(true)} />

        {checking && <p class="muted">Connesso al router. Verifico la rete…</p>}
        {probing && <p class="muted">Rete presa. Controllo se si esce davvero…</p>}
        {done && <Outcome uplink={uplink} portal={portal} onClose={() => onClose(true)} />}
      </div>
    </div>
  );
}

/**
 * Gli esiti vanno distinti in modo esplicito: associato senza IP e non
 * associato hanno rimedi diversi, e chiamarli entrambi "non connesso" fa
 * perdere tempo a chi legge. Vale anche per l'ultimo gradino, quello che prima
 * mancava: preso l'indirizzo, si esce davvero o c'e' un portale in mezzo?
 */
function Outcome({
  uplink,
  portal,
  onClose,
}: {
  uplink: Uplink | null;
  portal: PortalResult | null;
  onClose: () => void;
}) {
  const state = uplink ? uplinkState(uplink) : 'unassociated';

  return (
    <>
      {state === 'addressed' && (
        <p class={portal?.state === 'online' ? 'alert alert--ok' : 'alert alert--info'}>
          Collegato a <strong>{uplink?.ssid}</strong>.<br />
          IP {uplink?.ipv4} · gateway {uplink?.gateway || '—'}
          {typeof uplink?.signal === 'number' ? ` · ${uplink.signal} dBm` : ''}
          {portal?.state === 'online' && (
            <>
              <br />
              <br />
              Verificato: <strong>Internet si raggiunge</strong>.
            </>
          )}
          {!portal && (
            <>
              <br />
              <br />
              Non è stato possibile verificare l'uscita: se la rete richiede un login su
              pagina web non hai ancora Internet. Il controllo si rifà dalla scheda Internet.
            </>
          )}
        </p>
      )}

      {/* Il caso per cui esiste tutta la Fase 5: la connessione e' riuscita e
          Internet non c'e'. Senza questo riquadro si vedrebbe "Collegato" e si
          andrebbe a cercare il guasto nella password o nel segnale. */}
      {state === 'addressed' && portal?.state === 'portal' && (
        <>
          <p class="alert alert--warn">
            La rete ha un <strong>portale di accesso</strong>: finché non fai il login non
            passa niente. Aprilo adesso, dal telefono.
          </p>
          <a class="button button--primary" href={portal.url} target="_blank" rel="noreferrer">
            Apri la pagina di accesso
          </a>
        </>
      )}

      {state === 'addressed' && portal?.state === 'blocked' && (
        <p class="alert alert--warn">
          La rete ha dato un indirizzo ma <strong>non esce niente</strong>: nessuna risposta
          dall'esterno. Non è un portale — quello risponderebbe.
        </p>
      )}

      {state === 'addressed' && portal?.state === 'unknown' && portalReason(portal) && (
        <p class="alert alert--warn">{portalReason(portal)}</p>
      )}

      {state === 'no-address' && (
        <p class="alert alert--error">
          Agganciato a <strong>{uplink?.ssid}</strong>, ma la rete non ha dato un indirizzo.
          Di solito è una rete satura o che richiede un'autenticazione preventiva.
        </p>
      )}

      {(state === 'unassociated' || state === 'disabled') && (
        <p class="alert alert--error">
          Non è riuscito ad agganciare la rete. Il motivo più probabile è la password
          sbagliata.
        </p>
      )}

      <div class="sheet__actions">
        <button class="button button--primary" onClick={onClose}>
          Chiudi
        </button>
      </div>
    </>
  );
}
