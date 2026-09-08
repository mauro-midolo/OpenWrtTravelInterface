/**
 * Le reti WiFi salvate: la voce nella scheda WiFi e la pagina che apre.
 *
 * Stanno in una pagina loro e non in fondo alla scheda WiFi perche' l'elenco
 * cresce senza limite - una rete per albergo, una per bar, due per casa - e
 * finche' stava li' spingeva in basso le radio e la scansione, che sono le cose
 * per cui la scheda si apre. Nella scheda resta una riga sola col totale, come
 * fa Android con le sue reti salvate.
 */

import { useEffect, useState } from 'preact/hooks';
import { useApply } from '../lib/apply';
import {
  bandLabel,
  bandSiblings,
  connectedVia,
  deleteNetwork,
  groupByBand,
  hostnameOf,
  markUsed,
  matchesQuery,
  reorder,
  stageConnectSaved,
  updateNetwork,
} from '../lib/networks';
import type { SavedNetwork } from '../lib/networks';
import {
  awaitConnection,
  encryptionLabel,
  isValidSsid,
  logMark,
  wirelessCameUp,
} from '../lib/wifi';
import type { ConnectOutcome, Radio, Uplink } from '../lib/wifi';
import { getSystem, hostnameLabel, isValidHostname } from '../lib/hostname';
import type { HostnameChoice } from '../lib/hostname';
import { HostnamePicker } from '../components/HostnamePicker';
import { ApplyStatus } from '../components/ApplyStatus';

/**
 * Da quante reti in su compare la casella di ricerca.
 *
 * Sotto questa soglia l'elenco intero sta in una schermata e la casella
 * sarebbe solo un campo da scavalcare per arrivare a quello che si vede gia'.
 * Sopra, scorrere per ritrovare l'albergo di due viaggi fa diventa il modo
 * lento.
 */
const SEARCH_FROM = 6;

/**
 * Quanto si guarda l'uplink prima di dare un verdetto sulla connessione.
 *
 * E' lo stesso tempo che si concede collegandosi da una scansione: dentro ci
 * stanno l'associazione e il giro di DHCP. Su una rete nascosta serve tutto,
 * perche' wpa_supplicant deve prima sondare il nome invece di trovarselo in un
 * beacon gia' ricevuto.
 */
const CONNECT_WAIT_SECONDS = 30;

function whenUsed(epoch: number): string {
  if (!epoch) return 'mai usata';
  const days = Math.floor((Date.now() / 1000 - epoch) / 86400);
  if (days <= 0) return 'usata oggi';
  if (days === 1) return 'usata ieri';
  if (days < 30) return `usata ${days} giorni fa`;
  return `usata il ${new Date(epoch * 1000).toLocaleDateString('it-IT')}`;
}

const RESULT_LABEL: Record<string, string> = {
  ok: 'ultima volta: connessa',
  // Connessa e senza Internet: e' un esito a se', ed e' quello che conviene
  // sapere prima di ricollegarsi - dice che servira' di nuovo un login.
  portal: 'ultima volta: portale di accesso',
  'no-address': 'ultima volta: senza indirizzo',
  unassociated: 'ultima volta: non agganciata',
  // I due modi di non agganciarsi che hanno rimedi opposti: correggere la
  // password, oppure avvicinarsi. Tenerli separati e' il motivo per cui il
  // router va a leggere il log di wpa_supplicant.
  'wrong-key': 'ultima volta: password rifiutata',
  'not-found': 'ultima volta: rete non trovata',
};

/**
 * Lo stesso esito, come sta dentro una riga d'elenco.
 *
 * Manca apposta il caso "ok": in un elenco lungo l'occhio cerca le righe da
 * guardare, e se anche quelle andate bene portassero un'etichetta non ci
 * sarebbe piu' niente che spicca.
 */
const RESULT_SHORT: Record<string, string> = {
  portal: 'portale di accesso',
  'no-address': 'senza indirizzo',
  unassociated: 'non agganciata',
  'wrong-key': 'password rifiutata',
  'not-found': 'rete non trovata',
};

/** Quante reti per banda, in una frase: "3 a 2.4 GHz · 2 a 5 GHz". */
function bandSummary(saved: SavedNetwork[]): string {
  return groupByBand(saved)
    .filter((group) => group.networks.length > 0)
    .map((group) =>
      group.band === ''
        ? `${group.networks.length} senza banda`
        : `${group.networks.length} a ${group.band} GHz`,
    )
    .join(' · ');
}

/**
 * La voce nella scheda WiFi che porta alla pagina delle reti salvate.
 *
 * Il totale sta nel titolo perche' e' l'unica cosa che si vuole sapere senza
 * aprire: dice se ce n'e' una o venti, e quindi se vale la pena entrare.
 */
export function SavedEntryCard({
  saved,
  onOpen,
}: {
  saved: SavedNetwork[];
  onOpen: () => void;
}) {
  return (
    <section class="card">
      <button class="net net--link" onClick={onOpen}>
        <span class="net__main">
          <span class="net__ssid">
            Gestione reti salvate{saved.length > 0 ? ` (${saved.length})` : ''}
          </span>
          <span class="net__meta">
            {saved.length === 0
              ? 'Nessuna ancora. Quando ti colleghi a una rete puoi salvarla, e la ritrovi qui senza ridigitare la password.'
              : bandSummary(saved)}
          </span>
        </span>
        <span class="net__side">
          <span class="chevron" aria-hidden="true">
            ›
          </span>
        </span>
      </button>
    </section>
  );
}

/**
 * Una rete salvata in una riga.
 *
 * Due righe di testo e basta, sempre le stesse due: il nome sopra, il resto
 * sotto su una riga sola che viene troncata se non ci sta. Con venti reti in
 * elenco l'altezza costante e' cio' che permette di scorrere guardando la sola
 * colonna dei nomi; una riga che cresce quando la nota e' lunga costringe
 * invece a rileggere ogni volta dove si e' arrivati. Quello che qui viene
 * tagliato si legge per intero aprendo la rete.
 */
function SavedRow({
  net,
  rank,
  connected,
  onPick,
}: {
  net: SavedNetwork;
  /** Posizione per priorita' dentro la propria banda, a partire da 1. */
  rank: number;
  connected: boolean;
  onPick: () => void;
}) {
  // La banda e' ripetuta in ogni riga anche se c'e' gia' nel titolo del
  // gruppo: cercando, i risultati delle due bande finiscono uno sotto l'altro,
  // e la stessa rete di casa salvata due volte si distingue solo da qui.
  const meta = [
    bandLabel(net.band),
    encryptionLabel(net.encryption),
    whenUsed(net.last_used),
    RESULT_SHORT[net.last_result],
    net.note,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <li>
      <button class="net" onClick={onPick}>
        <span class="net__main">
          <span class="net__ssid saved__ssid">
            <span class="saved__rank">{rank}</span>{' '}
            {net.ssid}
          </span>
          <span class="net__meta saved__meta">{meta}</span>
        </span>
        <span class="net__side saved__badges">
          {connected && <span class="badge badge--ok">collegata</span>}
          {/* Una rete che non annuncia il nome non comparira' mai in una
              scansione: questo elenco e' l'unico posto da cui si sa che c'e'. */}
          {net.hidden && <span class="badge badge--muted">nascosta</span>}
          {net.disabled && <span class="badge badge--warn">disattivata</span>}
        </span>
      </button>
    </li>
  );
}

/**
 * La pagina dedicata alle reti salvate.
 *
 * I dati arrivano dalla scheda WiFi invece di essere riletti qui: sono gli
 * stessi che servono alla connessione e alla riconnessione automatica, e due
 * letture indipendenti si sarebbero disallineate proprio dopo una modifica,
 * cioe' nell'unico momento in cui la differenza si vede.
 */
export function SavedNetworksScreen({
  saved,
  radios,
  uplinks,
  onReload,
  onBack,
}: {
  saved: SavedNetwork[];
  radios: Radio[];
  uplinks: Uplink[];
  onReload: () => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<SavedNetwork | null>(null);

  // La casella sparisce se le reti scendono sotto la soglia: con lei sparisce
  // anche il filtro, altrimenti resterebbe attivo un testo che non si vede
  // piu' e l'elenco sembrerebbe aver perso delle voci.
  const searchable = saved.length >= SEARCH_FROM;
  const needle = searchable ? query.trim() : '';
  const filtering = needle !== '';

  // La posizione si calcola prima di filtrare: "3." deve continuare a dire
  // terza per priorita' su quella banda, non terza fra i risultati mostrati.
  const groups = groupByBand(saved).map((group) => ({
    band: group.band,
    total: group.networks.length,
    rows: group.networks
      .map((net, index) => ({ net, rank: index + 1 }))
      .filter(({ net }) => matchesQuery(net, needle)),
  }));

  const found = groups.reduce((sum, group) => sum + group.rows.length, 0);

  return (
    <main class="screen">
      <header class="topbar">
        <div class="topbar__left">
          <button
            class="button button--ghost button--icon"
            onClick={onBack}
            aria-label="Torna alle reti WiFi"
          >
            ←
          </button>
          <h1>Reti salvate</h1>
        </div>
        <button class="button button--ghost" onClick={onReload}>
          Aggiorna
        </button>
      </header>

      {saved.length === 0 ? (
        <section class="card">
          <p class="muted">
            Nessuna rete salvata. Quando ti colleghi a una rete puoi salvarla, e la ritrovi
            qui la volta dopo senza ridigitare la password.
          </p>
        </section>
      ) : (
        <>
          <p class="muted">
            Una lista per banda, ordinabili separatamente. Ogni radio sceglie dalla lista
            della sua banda, quindi la stessa rete può stare in tutte e due con priorità
            diverse.
          </p>

          {searchable && (
            <label class="field">
              <input
                type="search"
                value={query}
                placeholder="Cerca per nome o nota"
                aria-label="Cerca fra le reti salvate"
                onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              />
            </label>
          )}

          {filtering && found === 0 && (
            <section class="card">
              <p class="muted">Nessuna rete salvata corrisponde a «{needle}».</p>
            </section>
          )}

          {/* Un gruppo per banda invece di un elenco unico: le due radio
              scelgono in modo indipendente, e un elenco solo suggeriva il
              contrario. */}
          {groups.map((group) => {
            // Filtrando, una banda senza risultati sparisce invece di ripetere
            // "nessuna rete su questa banda": quel messaggio parla della
            // configurazione, mentre qui la causa e' la ricerca in corso.
            if (filtering && group.rows.length === 0) return null;

            return (
              <section class="card saved-group" key={group.band}>
                <h2 class="saved-group__title">
                  {bandLabel(group.band)}
                  {!filtering && group.total > 0 && (
                    <span class="saved-group__count">{group.total}</span>
                  )}
                </h2>

                {group.total === 0 ? (
                  <p class="muted">
                    Nessuna rete salvata su questa banda. Collegati a una rete{' '}
                    {group.band ? `a ${group.band} GHz` : ''} e salvala per averla qui.
                  </p>
                ) : (
                  <ul class="list list--flush">
                    {group.rows.map(({ net, rank }) => (
                      <SavedRow
                        key={net.section}
                        net={net}
                        rank={rank}
                        connected={connectedVia(uplinks, net) !== undefined}
                        onPick={() => setPicked(net)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </>
      )}

      {picked && (
        <SavedSheet
          net={picked}
          saved={saved}
          radios={radios}
          onClose={(changed) => {
            setPicked(null);
            if (changed) onReload();
          }}
        />
      )}
    </main>
  );
}

type Mode = 'menu' | 'edit' | 'connecting';

export function SavedSheet({
  net,
  saved,
  radios,
  onClose,
}: {
  net: SavedNetwork;
  saved: SavedNetwork[];
  radios: Radio[];
  onClose: (changed: boolean) => void;
}) {
  const apply = useApply();
  const [mode, setMode] = useState<Mode>('menu');
  const [password, setPassword] = useState('');
  /**
   * Il nome, modificabile solo per le reti nascoste.
   *
   * Per le altre l'SSID viene da una scansione, quindi e' giusto per
   * costruzione e riscriverlo a mano puo' solo romperlo. Per una nascosta e'
   * l'opposto: e' stato digitato, ed e' il primo posto in cui guardare quando
   * il router risponde "rete non trovata". Senza questo campo l'unico rimedio a
   * un refuso sarebbe cancellare la rete e riscriverla tutta.
   */
  const [ssid, setSsid] = useState(net.ssid);
  const [note, setNote] = useState(net.note);
  const [hostname, setHostname] = useState<HostnameChoice>(() => hostnameOf(net));
  const [deviceHostname, setDeviceHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Com'e' finita la connessione appena chiesta, quando si sa. */
  const [outcome, setOutcome] = useState<ConnectOutcome | null>(null);
  /** La riga di log che spiega l'esito, se il router ne ha trovata una. */
  const [detail, setDetail] = useState('');
  const [checking, setChecking] = useState(false);

  // Solo per dire cosa verrebbe inviato scegliendo "nome del router".
  useEffect(() => {
    let cancelled = false;
    void getSystem()
      .then((info) => !cancelled && setDeviceHostname(info.hostname))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const hostnameOk = hostname.mode !== 'custom' || isValidHostname(hostname.value.trim());
  const ssidOk = !net.hidden || isValidSsid(ssid.trim());

  // Si sposta dentro la propria banda: e' l'insieme fra cui la radio sceglie,
  // e spostarsi rispetto a una rete che l'altra radio non vedra' mai non
  // vorrebbe dire niente.
  const siblings = bandSiblings(saved, net);
  const index = siblings.findIndex((n) => n.section === net.section);

  // La banda salvata dice su quale radio va la STA. Senza, si prende la prima
  // radio disponibile e lo si dice invece di sceglierla in silenzio.
  const target =
    radios.find((r) => r.band === net.band) ?? radios.find((r) => r.band === '5') ?? radios[0];

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  /**
   * Chiede la connessione e poi guarda com'e' andata.
   *
   * Applicare non e' collegarsi: `wirelessCameUp` dice che le radio hanno
   * accettato la configurazione, e una password sbagliata e' una
   * configurazione validissima. L'esito vero arriva dopo, guardando l'uplink
   * per un po' e - se non si e' agganciata - chiedendo al router perche'.
   *
   * Per una rete nascosta non si aspetta nessuna scansione: la STA viene
   * scritta con l'SSID salvato e wpa_supplicant va a cercarla sondando
   * direttamente quel nome. E' anche il motivo per cui qui serve una diagnosi:
   * senza un beacon da confrontare, "non trovata" e "password sbagliata" sono
   * indistinguibili da fuori.
   *
   * Qualunque sia l'esito la rete salvata resta dov'e': niente in questa
   * funzione la cancella, e dopo un errore si passa a "Modifica" per
   * correggerla.
   */
  const connect = async () => {
    if (!target) {
      setError('Nessuna radio disponibile.');
      return;
    }
    setMode('connecting');
    setOutcome(null);
    setDetail('');

    // Il segnalibro si prende prima di toccare la radio: da qui in poi tutto
    // quello che compare nel log riguarda questo tentativo e nessun altro.
    // Se non si riesce a prenderlo si va avanti lo stesso con zero, che vuol
    // dire "nessun verdetto": meglio un motivo mancante che uno vecchio.
    const mark = await logMark(target.name).catch(() => 0);

    const applied = await apply.run(() => stageConnectSaved(net.section, target.name), {
      verify: wirelessCameUp,
    });
    if (!applied) return;

    setChecking(true);
    const result = await awaitConnection(target.name, net.ssid, CONNECT_WAIT_SECONDS, mark);
    setChecking(false);
    setOutcome(result.outcome);
    setDetail(result.detail);

    // L'esito si annota, ma solo se e' un esito: e' quello che l'elenco mostra
    // la volta dopo, e distingue una rete che non ha mai funzionato da una che
    // ha smesso. `unknown` non e' un esito - nessuno ha visto niente - e
    // scriverlo sostituirebbe una storia vera con un guasto immaginario.
    if (result.outcome !== 'unknown') {
      void markUsed(net.section, result.outcome).catch(() => undefined);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{net.ssid}</h2>

        {mode === 'menu' && (
          <>
            <p class="muted">
              {net.hidden ? 'Rete nascosta · ' : ''}
              {encryptionLabel(net.encryption)} · {bandLabel(net.band)} ·{' '}
              {whenUsed(net.last_used)}
              {net.last_result && RESULT_LABEL[net.last_result]
                ? ` · ${RESULT_LABEL[net.last_result]}`
                : ''}
            </p>

            {target && (
              <p class="muted">
                Si collegherà usando la radio {target.band ?? target.name} GHz.
              </p>
            )}

            <p class="muted">
              Nome inviato nel DHCP: {hostnameLabel(hostnameOf(net), deviceHostname)}.
            </p>

            {error && <p class="alert alert--error alert--code">{error}</p>}

            <div class="radio__actions">
              <button class="button button--primary" disabled={busy} onClick={connect}>
                Connetti
              </button>
              <button class="button button--ghost" disabled={busy} onClick={() => setMode('edit')}>
                Modifica
              </button>
              <button
                class="button button--ghost"
                disabled={busy || index <= 0}
                onClick={() => void guard(() => reorder(siblings, net.section, -1))}
              >
                Sposta su
              </button>
              <button
                class="button button--ghost"
                disabled={busy || index < 0 || index >= siblings.length - 1}
                onClick={() => void guard(() => reorder(siblings, net.section, 1))}
              >
                Sposta giù
              </button>
              <button
                class="button button--ghost"
                disabled={busy}
                onClick={() =>
                  void guard(() =>
                    updateNetwork(net.section, { disabled: net.disabled ? '0' : '1' }),
                  )
                }
              >
                {net.disabled ? 'Riattiva' : 'Disattiva'}
              </button>
              <button
                class="button button--ghost"
                disabled={busy}
                onClick={() => void guard(() => deleteNetwork(net.section))}
              >
                Elimina
              </button>
            </div>

            <div class="sheet__actions">
              <button class="button button--ghost" onClick={() => onClose(false)}>
                Chiudi
              </button>
            </div>
          </>
        )}

        {mode === 'edit' && (
          <>
            {net.hidden && (
              <label class="field">
                <span>Nome della rete (SSID)</span>
                <input
                  type="text"
                  value={ssid}
                  autocomplete="off"
                  autocapitalize="none"
                  spellcheck={false}
                  onInput={(e) => setSsid((e.target as HTMLInputElement).value)}
                />
                <span class="muted">
                  Il router cerca questo nome sondando, non leggendolo da un elenco: deve
                  essere esatto, maiuscole comprese.
                </span>
              </label>
            )}

            {net.hidden && ssid !== '' && !ssidOk && (
              <p class="alert alert--error">Il nome può essere lungo al massimo 32 byte.</p>
            )}

            <label class="field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                autocomplete="new-password"
                placeholder={
                  net.has_key ? 'lascia vuoto per non cambiarla' : 'almeno 8 caratteri'
                }
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              />
              <span class="muted">
                La password salvata non viene mostrata: non esce mai dal router.
              </span>
            </label>

            <HostnamePicker
              choice={hostname}
              deviceHostname={deviceHostname}
              onChange={setHostname}
            />

            <label class="field">
              <span>Nota</span>
              <input
                type="text"
                value={note}
                placeholder="es. hotel di Berlino, chiedere codice alla reception"
                onInput={(e) => setNote((e.target as HTMLInputElement).value)}
              />
            </label>

            {error && <p class="alert alert--error alert--code">{error}</p>}

            <div class="sheet__actions">
              <button class="button button--ghost" onClick={() => setMode('menu')}>
                Indietro
              </button>
              <button
                class="button button--primary"
                disabled={
                  busy || !hostnameOk || !ssidOk || (password !== '' && password.length < 8)
                }
                onClick={() =>
                  void guard(() =>
                    updateNetwork(net.section, {
                      note,
                      hostname_mode: hostname.mode,
                      hostname_value: hostname.mode === 'custom' ? hostname.value.trim() : '',
                      ...(password ? { key: password } : {}),
                      ...(net.hidden ? { ssid: ssid.trim() } : {}),
                    }),
                  )
                }
              >
                Salva
              </button>
            </div>
          </>
        )}

        {mode === 'connecting' && (
          <>
            <ApplyStatus apply={apply} onClose={() => onClose(true)} />

            {checking && (
              <p class="muted">
                Configurazione applicata. Aspetto che la radio si agganci e prenda un
                indirizzo: fino a {CONNECT_WAIT_SECONDS} secondi.
              </p>
            )}

            {outcome === 'ok' && (
              <p class="alert alert--ok">
                Connessa a «{net.ssid}». L'indirizzo e lo stato dell'uscita li trovi nella
                scheda WiFi.
              </p>
            )}

            {outcome === 'no-address' && (
              <p class="alert alert--warn">
                Agganciata a «{net.ssid}», ma la rete non ha assegnato nessun indirizzo. La
                password è giusta: a non rispondere è il DHCP della rete. La configurazione
                resta salvata.
              </p>
            )}

            {outcome === 'wrong-key' && (
              <p class="alert alert--error">
                «{net.ssid}» ha rifiutato la password. La configurazione resta salvata:
                correggi la password con <strong>Modifica</strong> e riprova.
              </p>
            )}

            {outcome === 'not-found' && (
              <p class="alert alert--warn">
                «{net.ssid}» non è stata trovata.
                {net.hidden
                  ? ' Su una rete nascosta il nome deve essere esatto, maiuscole comprese, e la banda deve essere quella giusta: il router lo cerca sondando, non leggendolo da un elenco.'
                  : ' Può essere spenta o fuori portata.'}{' '}
                La configurazione resta salvata.
              </p>
            )}

            {outcome === 'unassociated' && (
              <p class="alert alert--warn">
                Non si è agganciata a «{net.ssid}» e il router non ha saputo dire perché.
                Può essere fuori portata, oppure rifiutare questo dispositivo. La
                configurazione resta salvata.
              </p>
            )}

            {/* Non un fallimento: un'assenza di misura. Dirlo com'è evita di
                annotare nella storia della rete un guasto che nessuno ha
                visto - il router potrebbe essersi agganciato benissimo. */}
            {outcome === 'unknown' && (
              <p class="alert alert--warn">
                Il router non ha risposto mentre verificavo, quindi non so come sia
                andata. Guarda lo stato della radio nella scheda WiFi: la configurazione
                resta salvata in ogni caso.
              </p>
            )}

            {/* La riga di log alla lettera: e' il dettaglio che distingue due
                guasti che a parole si somigliano, e nasconderlo costringerebbe
                ad andarlo a cercare da terminale. */}
            {detail !== '' && <p class="alert alert--warn alert--code">{detail}</p>}

            {outcome !== null && (
              <div class="sheet__actions">
                {/* Dopo un errore la rete non e' cambiata: si corregge da qui,
                    che e' l'unico posto da cui e' venuta la notizia. */}
                {outcome !== 'ok' && (
                  <button
                    class="button button--ghost"
                    onClick={() => {
                      setOutcome(null);
                      setDetail('');
                      apply.reset();
                      setMode('edit');
                    }}
                  >
                    Modifica
                  </button>
                )}
                <button class="button button--primary" onClick={() => onClose(true)}>
                  Chiudi
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
