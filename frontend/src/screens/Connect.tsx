import { useEffect, useState } from 'preact/hooks';
import { useApply } from '../lib/apply';
import {
  getUplinks,
  isValidMac,
  stageConnection,
  stageStaMac,
  uplinkState,
  wirelessCameUp,
} from '../lib/wifi';
import { encryptionForSta } from '../lib/wifi';
import type { ConnectionPlan, MacChoice, ScanResult, Uplink } from '../lib/wifi';
import {
  BANDS,
  bandConflicts,
  bandLabel,
  bandValues,
  bandsFromScan,
  bandsLabel,
  findSaved,
  findSavedOn,
  fromScan,
  hostnameOf,
  macForNewBand,
  markUsed,
  saveNetwork,
  stageConnectSaved,
  updateMacOnBand,
  updateNetwork,
} from '../lib/networks';
import type { BandSet, MacByBand, SavedNetwork } from '../lib/networks';
import { HOSTNAME_OFF, getSystem, isValidHostname, stageWanHostname } from '../lib/hostname';
import type { HostnameChoice } from '../lib/hostname';
import { checkPortal, portalReason } from '../lib/portal';
import type { PortalResult } from '../lib/portal';
import { HostnamePicker } from '../components/HostnamePicker';
import { MacPicker } from '../components/MacPicker';
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
  const [remember, setRemember] = useState(true);
  /** Se aggiungere questa banda a una rete gia' salvata sull'altra. */
  const [addBand, setAddBand] = useState(true);
  const [checking, setChecking] = useState(false);
  const [probing, setProbing] = useState(false);
  const [portal, setPortal] = useState<PortalResult | null>(null);
  const [uplink, setUplink] = useState<Uplink | null>(null);
  const [done, setDone] = useState(false);
  const [deviceHostname, setDeviceHostname] = useState('');

  /**
   * La rete salvata che copre gia' questa banda, se c'e'.
   *
   * Copre: non "si chiama uguale". Sulla stessa radio ci sta una stazione
   * sola, quindi e' questa la voce che verrebbe usata collegandosi qui, ed e'
   * questa quella di cui aggiornare l'ultimo utilizzo.
   */
  const savedHere = findSavedOn(saved, net.ssid, net.band);

  /**
   * La stessa rete salvata, ma solo sull'altra banda.
   *
   * Succede di continuo: la rete di casa e' stata salvata a 5 GHz e adesso la
   * si trova cercando a 2.4. Non e' una rete nuova da salvare accanto a
   * quella - e' la stessa - quindi si propone di aggiungerle questa banda,
   * riusando password, cifratura e nome DHCP che ha gia'.
   */
  const savedElsewhere = savedHere ? undefined : findSaved(saved, net.ssid);

  /**
   * Le bande su cui salvarla.
   *
   * Parte dalla sola banda della scansione, e quella resta accesa: e' l'unica
   * di cui si sa qualcosa: la rete e' stata vista li', con quella cifratura, e
   * la password verra' provata li'. L'altra si puo' aggiungere subito se si sa
   * che la stessa rete c'e' anche di la', e resta comunque cambiabile dopo,
   * dalle reti salvate.
   */
  const [bands, setBands] = useState<BandSet>(() => bandsFromScan(net.band));

  /** L'altra banda: quella facoltativa, in questo modulo. */
  const otherBand = BANDS.find((b) => b !== net.band);

  /**
   * L'altra banda e' gia' coperta da un'altra voce con questo nome.
   *
   * Succede rifiutando di estendere quella voce e salvando comunque: la rete
   * nuova puo' prendersi la banda della scansione, che e' libera, ma non
   * quella dell'altra - su quella radio ci sta una stazione sola, e la seconda
   * configurazione non verrebbe mai provata.
   */
  const otherTaken =
    otherBand !== undefined && bandConflicts(saved, net.ssid, bandsFromScan(otherBand)).length > 0;

  /** Le bande che il salvataggio userebbe davvero, tolte quelle occupate. */
  const bandsToSave: BandSet = otherTaken && otherBand ? { ...bands, [otherBand]: false } : bands;

  /** La voce salvata che questa connessione riguarda, su questa o sull'altra banda. */
  const known = savedHere ?? savedElsewhere;

  /**
   * Il modulo parte dalla configurazione salvata, non da zero.
   *
   * Ritrovare la rete di casa in una scansione e doverne ridigitare MAC e nome
   * DHCP - o peggio la password - vuol dire riconfigurarla ogni volta da capo,
   * mentre il router la conosce gia'. Qui i campi partono da quello che c'e'
   * salvato e restano tutti modificabili: la configurazione e' il valore
   * iniziale del modulo, non una gabbia.
   *
   * Il MAC e' quello della banda su cui si sta per andare, perche' e' della
   * radio: le due bande della stessa rete possono averne due diversi.
   */
  const [mac, setMac] = useState<MacChoice>(() =>
    known ? { ...known.mac[net.band] } : { mode: 'device', value: '' },
  );

  // Il nome DHCP si chiede a ogni rete nuova, e parte da "non inviarlo": e' una
  // scelta per rete, perche' la rete di casa e quella di un albergo non
  // meritano lo stesso trattamento. Su una rete gia' salvata si riprende
  // quello che aveva, altrimenti collegarsi dal pannello lo azzererebbe.
  const [hostname, setHostname] = useState<HostnameChoice>(
    known ? hostnameOf(known) : HOSTNAME_OFF,
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

  /**
   * Il MAC di ciascuna banda, partendo da quello scelto per questa connessione.
   *
   * La banda della scansione prende esattamente l'indirizzo che sta per essere
   * usato: e' quello che ha funzionato, ed e' quello che si vuole ritrovare
   * ricollegandosi. L'altra lo eredita secondo la regola di `macForNewBand` -
   * stesso modo, indirizzo casuale rigenerato - perche' due radio con lo stesso
   * MAC casuale sullo stesso punto di accesso sarebbero un conflitto.
   */
  const macByBand = (): MacByBand => {
    const out: MacByBand = { '2.4': mac, '5': mac };
    if (otherBand) out[otherBand] = macForNewBand(mac);
    return out;
  };

  const macOk = mac.mode === 'device' || isValidMac(mac.value);
  /**
   * La password puo' mancare solo su una rete gia' salvata.
   *
   * Li' non e' un campo vuoto, e' "quella di prima": la chiave sta sul router e
   * non e' mai uscita, quindi non c'e' niente da mostrare e niente da
   * ridigitare. Su una rete nuova la regola resta quella di sempre, perche' non
   * c'e' nessuna password da riusare. Digitarne una qui e' una modifica, e come
   * tale viene validata con le stesse regole.
   */
  const passwordOk = net.open || password.length >= 8 || (known !== undefined && password === '');
  const hostnameOk = hostname.mode !== 'custom' || isValidHostname(hostname.value.trim());

  /**
   * Se c'e' di che scrivere una voce salvata nuova.
   *
   * Riguarda un caso solo: la stessa rete e' gia' salvata sull'altra banda, si
   * e' rifiutato di estenderla, e la password non e' stata ridigitata. Ci si
   * collega lo stesso - la chiave ce l'ha il router - ma una voce nuova
   * nascerebbe senza, e sarebbe una rete salvata che non si aggancia. Per
   * salvarla a parte la password va scritta; per collegarsi no.
   */
  const canSaveApart = net.open || password !== '';

  /**
   * Prepara la configurazione della STA.
   *
   * Due strade, e la differenza e' una sola: chi ha la password. Se e' stata
   * ridigitata qui, la scrive il browser come per qualunque rete trovata
   * cercando. Se il campo e' vuoto su una rete salvata, la chiave esiste solo
   * sul router: se la prende lui da `/etc/config/travel` senza farla passare di
   * qui, che e' esattamente cio' per cui `stage_connect_saved` e' nato.
   *
   * In quel secondo caso i valori del modulo che l'utente ha cambiato si
   * riscrivono sopra la sezione appena preparata, nello stesso lotto di
   * modifiche in sospeso. Si riscrivono solo se sono davvero diversi da quelli
   * salvati: senza modifiche, le chiamate sono le stesse che fa "Connetti"
   * dalla pagina delle reti salvate.
   */
  const stage = async (chosen: MacChoice) => {
    if (!known || password !== '') {
      await stageConnection(net, password, plan, chosen, hostname);
      return;
    }

    await stageConnectSaved(known.section, plan.staRadio.name);

    // Il confronto e' fra indirizzi, non fra modi: quello che il router ha
    // appena scritto nella sezione e' il MAC salvato per questa banda - vuoto
    // se e' quello della radio - e qui si riscrive sopra solo se il modulo ne
    // mostra un altro. Confrontare i modi farebbe partire una riscrittura
    // anche passando da "casuale" a "manuale" sullo stesso indirizzo, e
    // soprattutto ne farebbe saltare una dove il modo coincide ma il valore no.
    const savedMac = known.mac[net.band];
    const staged = savedMac.mode === 'device' ? '' : savedMac.value;
    const wanted = chosen.mode === 'device' ? '' : chosen.value;
    if (wanted !== staged) {
      await stageStaMac(`sta_${plan.staRadio.name}`, wanted);
    }

    const savedHostname = hostnameOf(known);
    if (hostname.mode !== savedHostname.mode || hostname.value !== savedHostname.value) {
      await stageWanHostname(`wwan_${plan.staRadio.name}`, hostname);
    }
  };

  const start = async (event: Event) => {
    event.preventDefault();
    // Il valore arriva gia' normalizzato da MacPicker: qui non si ritocca.
    const chosen: MacChoice = { mode: mac.mode, value: mac.value };

    const confirmed = await apply.run(() => stage(chosen), {
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
      // La voce da aggiornare invece di salvarne una nuova: quella che copre
      // gia' questa banda, oppure - se si e' accettato di estenderla - la
      // stessa rete salvata sull'altra. Rifiutando l'estensione non si aggiorna
      // niente di quella voce: si torna a salvare, come per una rete nuova.
      const extend = savedElsewhere && addBand ? savedElsewhere : undefined;
      const update = savedHere ?? extend;

      if (update) {
        // Il nome DHCP puo' essere stato cambiato adesso: la voce salvata deve
        // ricordarselo, altrimenti la riconnessione automatica rimetterebbe
        // quello vecchio senza che si capisca perche'.
        await markUsed(update.section, outcome);

        const values: Record<string, string> = {
          hostname_mode: hostname.mode,
          hostname_value: hostname.mode === 'custom' ? hostname.value.trim() : '',
        };

        // La password ridigitata qui e' una correzione a quella salvata, e si
        // scrive solo adesso: la rete si e' agganciata, quindi quella nuova
        // funziona. Il campo lasciato vuoto non e' una cancellazione - vuol
        // dire "usa quella che c'e' gia'" - e infatti non compare.
        if (password) values.key = password;

        // La rete era salvata solo sull'altra banda e adesso ha funzionato
        // anche qui: la banda si aggiunge alla voce che c'e' gia', con il MAC
        // che ha appena funzionato. Non si crea una seconda voce - sarebbe la
        // stessa rete scritta due volte - e non si tocca nient'altro di suo.
        if (extend && !extend.bands[net.band]) {
          Object.assign(
            values,
            bandValues(
              { ...extend.bands, [net.band]: true },
              { ...extend.mac, [net.band]: mac },
            ),
          );
        }

        await updateNetwork(update.section, values);

        // Il MAC cambiato nel modulo appartiene alla banda su cui si e' appena
        // andati, e va scritto senza toccare quello dell'altra. Estendendo una
        // banda ci ha gia' pensato `bandValues` qui sopra, che le scrive tutte
        // e due di proposito.
        const savedMac = update.mac[net.band];
        if (!extend && (mac.mode !== savedMac.mode || mac.value !== savedMac.value)) {
          await updateMacOnBand(update.section, net.band, mac);
        }
      } else if (remember && !net.hidden && canSaveApart) {
        await saveNetwork(
          fromScan(net, password, bandsToSave, macByBand(), encryptionForSta(net), hostname),
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
                  autofocus={known === undefined}
                  placeholder={
                    known?.has_key ? 'lascia vuoto per usare quella salvata' : undefined
                  }
                  onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                />
                {/* La chiave salvata non si mostra: non esce mai dal router.
                    Lasciare il campo vuoto non la cancella - la usa. */}
                {known?.has_key && (
                  <span class="muted">
                    Questa rete ha già una password salvata: lascia il campo vuoto per
                    usarla, oppure scrivine una nuova per correggerla.
                  </span>
                )}
              </label>
            )}

            <MacPicker choice={mac} onChange={setMac} />

            <HostnamePicker
              choice={hostname}
              deviceHostname={deviceHostname}
              onChange={setHostname}
            />

            {savedHere && (
              <p class="muted">
                Questa rete è già salvata ({bandsLabel(savedHere.bands)}): l'ultimo utilizzo
                verrà aggiornato.
              </p>
            )}

            {/* La stessa rete, salvata finora solo sull'altra banda. Non se ne
                crea una seconda: si aggiunge questa banda a quella che c'e'
                gia', che porta con se' password, cifratura e nome DHCP. */}
            {savedElsewhere && (
              <label class="check">
                <input
                  type="checkbox"
                  checked={addBand}
                  onChange={(e) => setAddBand((e.target as HTMLInputElement).checked)}
                />
                <span>
                  «{savedElsewhere.ssid}» è già salvata ({bandsLabel(savedElsewhere.bands)}):
                  aggiungi anche <strong>{bandLabel(net.band)}</strong> a quella stessa rete,
                  invece di salvarne una seconda. Succede solo se la connessione riesce.
                </span>
              </label>
            )}

            {/* Rifiutando di estendere la voce che c'è, questa resta una rete
                da salvare come le altre: la banda della scansione è libera -
                nessuna voce la copre - quindi salvarla qui non crea nessun
                doppione. Senza questo ramo, dire "no" all'estensione avrebbe
                voluto dire non poterla salvare affatto. */}
            {!savedHere && !(savedElsewhere && addBand) && (
              <>
                <label class="check">
                  <input
                    type="checkbox"
                    checked={remember && canSaveApart}
                    disabled={net.hidden || !canSaveApart}
                    onChange={(e) => setRemember((e.target as HTMLInputElement).checked)}
                  />
                  <span>
                    Salva questa rete{savedElsewhere ? ' come voce a parte' : ''}, così la
                    ritrovi senza ridigitare la password. Viene salvata solo se la
                    connessione riesce.
                  </span>
                </label>

                {/* La chiave salvata sta sul router e non passa di qui: basta a
                    collegarsi, non a scrivere una voce nuova che deve averne
                    una sua. */}
                {!canSaveApart && (
                  <p class="muted">
                    Per salvarla come voce a parte serve la password: scrivila qui sopra.
                    Per collegarti e basta non serve — quella salvata la usa il router.
                  </p>
                )}

                {/* La banda da cui l'hai trovata resta accesa e non si può
                    togliere: e' l'unica su cui si sa che questa rete c'e' e che
                    la password e' quella. L'altra si aggiunge se la conosci, e
                    resta modificabile dopo, dalle reti salvate. */}
                {remember && !net.hidden && (
                  <div class="field">
                    <span id="bande-salvataggio">Bande su cui salvarla</span>
                    <div role="group" aria-labelledby="bande-salvataggio">
                      {BANDS.map((band) => (
                        <label class="check" key={band}>
                          <input
                            type="checkbox"
                            checked={bandsToSave[band]}
                            disabled={band === net.band || (band === otherBand && otherTaken)}
                            onChange={(e) =>
                              setBands({ ...bands, [band]: (e.target as HTMLInputElement).checked })
                            }
                          />
                          <span>
                            {bandLabel(band)}
                            {band === net.band ? ' · la banda da cui l’hai trovata' : ''}
                            {band === otherBand && otherTaken
                              ? ' · già usata da un’altra rete salvata con questo nome'
                              : ''}
                          </span>
                        </label>
                      ))}
                    </div>
                    <span class="muted">
                      {otherTaken
                        ? "Su quella banda una voce con questo nome c'è già: non se ne aggiunge una seconda, che non verrebbe mai provata."
                        : `Aggiungi ${otherBand ? bandLabel(otherBand) : "l'altra banda"} solo se sai che la stessa rete, con la stessa password, c'è anche lì.`}
                    </span>
                  </div>
                )}
              </>
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
