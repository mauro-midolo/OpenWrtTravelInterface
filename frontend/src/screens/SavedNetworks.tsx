/**
 * Le reti WiFi salvate: la voce nella scheda WiFi e la pagina che apre.
 *
 * Stanno in una pagina loro e non in fondo alla scheda WiFi perche' l'elenco
 * cresce senza limite - una rete per albergo, una per bar, due per casa - e
 * finche' stava li' spingeva in basso le radio e la scansione, che sono le cose
 * per cui la scheda si apre. Nella scheda resta una riga sola col totale, come
 * fa Android con le sue reti salvate.
 *
 * L'elenco e' uno solo. Prima erano due, uno per banda, e la stessa rete di
 * casa compariva due volte: due password da correggere, due note da scrivere,
 * due voci da tenere allineate a mano. Adesso ogni riga e' una rete, e le
 * bande su cui va usata sono due caselle dentro la rete.
 */

import { useEffect, useState } from 'preact/hooks';
import { useApply } from '../lib/apply';
import {
  BANDS,
  bandConflicts,
  bandLabel,
  bandList,
  bandValues,
  bandsLabel,
  connectedVia,
  deleteNetwork,
  hasAnyBand,
  hostnameOf,
  macForNewBand,
  markUsed,
  matchesQuery,
  reorder,
  stageConnectSaved,
  updateNetwork,
} from '../lib/networks';
import type { BandSet, MacByBand, SavedNetwork } from '../lib/networks';
import {
  awaitConnection,
  encryptionLabel,
  isValidMac,
  isValidSsid,
  logMark,
  wirelessCameUp,
} from '../lib/wifi';
import type { Band, ConnectOutcome, Radio, Uplink } from '../lib/wifi';
import { getSystem, hostnameLabel, isValidHostname } from '../lib/hostname';
import type { HostnameChoice } from '../lib/hostname';
import { HostnamePicker } from '../components/HostnamePicker';
import { MacPicker } from '../components/MacPicker';
import { ShareSheet } from './ShareNetwork';
import { ApplyStatus } from '../components/ApplyStatus';
import { locale } from '../i18n';
import { commonText } from '../i18n/common';
import { savedText } from '../i18n/saved';

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
  const t = savedText();
  if (!epoch) return t.neverUsed;
  const days = Math.floor((Date.now() / 1000 - epoch) / 86400);
  if (days <= 0) return t.usedToday;
  if (days === 1) return t.usedYesterday;
  if (days < 30) return t.usedDaysAgo(days);
  return t.usedOn(new Date(epoch * 1000).toLocaleDateString(locale()));
}

/** L'esito dell'ultimo tentativo, per esteso: sta nella scheda della rete. */
const resultLabel = (result: string): string | undefined => savedText().result[result];

/**
 * Lo stesso esito, come sta dentro una riga d'elenco.
 *
 * Manca apposta il caso "ok": in un elenco lungo l'occhio cerca le righe da
 * guardare, e se anche quelle andate bene portassero un'etichetta non ci
 * sarebbe piu' niente che spicca.
 */
const resultShort = (result: string): string | undefined => savedText().resultShort[result];

/**
 * Com'e' distribuito l'elenco fra le bande, in una frase.
 *
 * Non e' piu' un conteggio per lista - la lista e' una sola - ma resta la cosa
 * che si vuole sapere senza aprire: quante reti valgono su tutte e due le
 * radio e quante su una sola.
 */
function bandSummary(saved: SavedNetwork[]): string {
  const both = saved.filter((n) => n.bands['2.4'] && n.bands['5']).length;
  const only24 = saved.filter((n) => n.bands['2.4'] && !n.bands['5']).length;
  const only5 = saved.filter((n) => !n.bands['2.4'] && n.bands['5']).length;
  const none = saved.filter((n) => !hasAnyBand(n.bands)).length;

  const t = savedText();
  return [
    both > 0 ? t.both(both) : '',
    only24 > 0 ? t.only24(only24) : '',
    only5 > 0 ? t.only5(only5) : '',
    none > 0 ? t.noBandCount(none) : '',
  ]
    .filter(Boolean)
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
  const t = savedText();
  return (
    <section class="card">
      <button class="net net--link" onClick={onOpen}>
        <span class="net__main">
          <span class="net__ssid">
            {t.entry}
            {saved.length > 0 ? ` (${saved.length})` : ''}
          </span>
          <span class="net__meta">
            {saved.length === 0
              ? t.entryEmpty
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

/** Le targhette delle bande di una rete: si leggono senza aprire la riga. */
function BandBadges({ bands }: { bands: BandSet }) {
  if (!hasAnyBand(bands)) {
    return <span class="badge badge--warn">{savedText().noBand}</span>;
  }
  return (
    <>
      {bandList(bands).map((band) => (
        <span class="badge badge--band" key={band}>
          {band}
        </span>
      ))}
    </>
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
  /** Posizione per priorita' nell'elenco, a partire da 1. */
  rank: number;
  connected: boolean;
  onPick: () => void;
}) {
  // Le bande non stanno qui ma nelle targhette a destra: sono la prima cosa da
  // vedere, e in fondo a una riga troncata sarebbero sparite proprio sulle
  // reti con la nota lunga.
  const meta = [
    encryptionLabel(net.encryption),
    whenUsed(net.last_used),
    resultShort(net.last_result),
    net.note,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <li>
      <button class="net" onClick={onPick}>
        <span class="net__main">
          <span class="net__ssid saved__ssid">
            <span class="saved__rank">{rank}</span> {net.ssid}
          </span>
          <span class="net__meta saved__meta">{meta}</span>
        </span>
        <span class="net__side saved__badges">
          <BandBadges bands={net.bands} />
          {connected && <span class="badge badge--ok">{savedText().connected}</span>}
          {/* Una rete che non annuncia il nome non comparira' mai in una
              scansione: questo elenco e' l'unico posto da cui si sa che c'e'. */}
          {net.hidden && <span class="badge badge--muted">{savedText().hidden}</span>}
          {net.disabled && <span class="badge badge--warn">{savedText().disabled}</span>}
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
  const t = savedText();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<SavedNetwork | null>(null);

  // La casella sparisce se le reti scendono sotto la soglia: con lei sparisce
  // anche il filtro, altrimenti resterebbe attivo un testo che non si vede
  // piu' e l'elenco sembrerebbe aver perso delle voci.
  const searchable = saved.length >= SEARCH_FROM;
  const needle = searchable ? query.trim() : '';
  const filtering = needle !== '';

  // La posizione si calcola prima di filtrare: "3." deve continuare a dire
  // terza per priorita', non terza fra i risultati mostrati.
  const rows = saved
    .map((net, index) => ({ net, rank: index + 1 }))
    .filter(({ net }) => matchesQuery(net, needle));

  return (
    <main class="screen">
      <header class="topbar">
        <div class="topbar__left">
          <button
            class="button button--ghost button--icon"
            onClick={onBack}
            aria-label={t.back}
          >
            ←
          </button>
          <h1>{t.title}</h1>
        </div>
        <button class="button button--ghost" onClick={onReload}>
          {commonText().actions.refresh}
        </button>
      </header>

      {saved.length === 0 ? (
        <section class="card">
          <p class="muted">{t.empty}</p>
        </section>
      ) : (
        <>
          {searchable && (
            <label class="field">
              <input
                type="search"
                value={query}
                placeholder={t.search}
                aria-label={t.searchLabel}
                onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              />
            </label>
          )}

          {filtering && rows.length === 0 && (
            <section class="card">
              <p class="muted">{t.noMatch(needle)}</p>
            </section>
          )}

          {rows.length > 0 && (
            <section class="card">
              <ul class="list list--flush">
                {rows.map(({ net, rank }) => (
                  <SavedRow
                    key={net.section}
                    net={net}
                    rank={rank}
                    connected={connectedVia(uplinks, net) !== undefined}
                    onPick={() => setPicked(net)}
                  />
                ))}
              </ul>
            </section>
          )}
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
  const t = savedText();
  const actions = commonText().actions;
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
  const [bands, setBands] = useState<BandSet>({ ...net.bands });
  const [mac, setMac] = useState<MacByBand>({ ...net.mac });
  /**
   * Le bande il cui MAC e' gia' stato deciso.
   *
   * Accendendo una banda mai usata prima, il suo MAC parte da quello
   * dell'altra: e' cio' che significa "la stessa rete anche di la'". Ma solo
   * la prima volta - dopo, quel campo e' una scelta di chi guarda lo schermo, e
   * spegnere e riaccendere la casella non deve buttarla via.
   */
  const [seeded, setSeeded] = useState<BandSet>({ ...net.bands });
  const [hostname, setHostname] = useState<HostnameChoice>(() => hostnameOf(net));
  const [deviceHostname, setDeviceHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Com'e' finita la connessione appena chiesta, quando si sa. */
  const [outcome, setOutcome] = useState<ConnectOutcome | null>(null);
  /** La riga di log che spiega l'esito, se il router ne ha trovata una. */
  const [detail, setDetail] = useState('');
  const [checking, setChecking] = useState(false);
  const [sharing, setSharing] = useState(false);

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
  const macOk = bandList(bands).every(
    (band) => mac[band].mode === 'device' || isValidMac(mac[band].value),
  );

  /**
   * Le bande gia' occupate da un'altra voce con lo stesso nome.
   *
   * Si guarda prima di salvare, non dopo: due configurazioni con lo stesso SSID
   * sulla stessa radio sono un doppione, e la seconda non verrebbe mai provata.
   * Qui ci si ferma e si dice quale voce c'e' gia', senza toccarla.
   */
  const conflicts = bandConflicts(saved, net.hidden ? ssid.trim() : net.ssid, bands, net.section);

  const index = saved.findIndex((n) => n.section === net.section);

  /**
   * Le radio su cui questa rete puo' andare: quelle della sua banda.
   *
   * Con tutte e due le bande accese si sceglie, e si parte dai 5 GHz: piu'
   * veloci, ed e' quello che si vuole quando la rete c'e' su entrambe. Con una
   * banda sola non c'e' niente da scegliere e i pulsanti non compaiono.
   */
  // Dalle bande salvate, non da quelle del modulo di modifica: "Connetti" usa
  // la configurazione che sta sul router, e una casella spuntata ma non ancora
  // salvata non la cambia.
  const candidates = radios.filter((r) => r.band !== null && net.bands[r.band]);
  const [radioName, setRadioName] = useState('');
  const target =
    candidates.find((r) => r.name === radioName) ??
    candidates.find((r) => r.band === '5') ??
    candidates[0];

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

  /** Accende o spegne una banda, seminando il MAC la prima volta che si accende. */
  const toggleBand = (band: Band, on: boolean) => {
    setBands({ ...bands, [band]: on });
    if (!on || seeded[band]) return;

    const other = BANDS.find((b) => b !== band) as Band;
    setMac({ ...mac, [band]: macForNewBand(mac[other]) });
    setSeeded({ ...seeded, [band]: true });
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
      setError(t.noRadio);
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

  if (sharing) {
    return <ShareSheet net={net} onClose={() => setSharing(false)} />;
  }

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{net.ssid}</h2>

        {mode === 'menu' && (
          <>
            <p class="muted">
              {net.hidden ? t.hiddenPrefix : ''}
              {encryptionLabel(net.encryption)} · {bandsLabel(net.bands)} ·{' '}
              {whenUsed(net.last_used)}
              {net.last_result && resultLabel(net.last_result)
                ? ` · ${resultLabel(net.last_result)}`
                : ''}
            </p>

            {!hasAnyBand(net.bands) && (
              <p class="alert alert--warn">{t.noBandEnabled}</p>
            )}

            {/* Con la rete su tutte e due le bande la radio e' una scelta, e
                farla qui evita di doverla indovinare: la voce e' una sola, ma
                le radio restano due e ognuna si aggancia per conto suo. */}
            {candidates.length > 1 && (
              <div class="field">
                <span id="radio-connessione">{t.connectUsing}</span>
                <div class="chips" role="group" aria-labelledby="radio-connessione">
                  {candidates.map((r) => (
                    <button
                      key={r.name}
                      type="button"
                      class={target?.name === r.name ? 'chip chip--on' : 'chip'}
                      aria-pressed={target?.name === r.name}
                      onClick={() => setRadioName(r.name)}
                    >
                      {bandLabel(r.band ?? r.name)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {candidates.length === 1 && target && (
              <p class="muted">{t.radio(bandLabel(target.band ?? target.name))}</p>
            )}

            <p class="muted">{t.dhcpName(hostnameLabel(hostnameOf(net), deviceHostname))}</p>

            {error && <p class="alert alert--error alert--code">{error}</p>}

            <div class="radio__actions">
              <button
                class="button button--primary"
                disabled={busy || !target}
                onClick={connect}
              >
                {t.connect}
              </button>
              <button class="button button--ghost" disabled={busy} onClick={() => setMode('edit')}>
                {t.edit}
              </button>
              <button class="button button--ghost" disabled={busy} onClick={() => setSharing(true)}>
                {t.share}
              </button>
              <button
                class="button button--ghost"
                disabled={busy || index <= 0}
                onClick={() => void guard(() => reorder(saved, net.section, -1))}
              >
                {t.moveUp}
              </button>
              <button
                class="button button--ghost"
                disabled={busy || index < 0 || index >= saved.length - 1}
                onClick={() => void guard(() => reorder(saved, net.section, 1))}
              >
                {t.moveDown}
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
                {net.disabled ? t.enable : t.disable}
              </button>
              <button
                class="button button--ghost"
                disabled={busy}
                onClick={() => void guard(() => deleteNetwork(net.section))}
              >
                {t.remove}
              </button>
            </div>

            <div class="sheet__actions">
              <button class="button button--ghost" onClick={() => onClose(false)}>
                {actions.close}
              </button>
            </div>
          </>
        )}

        {mode === 'edit' && (
          <>
            {net.hidden && (
              <label class="field">
                <span>{t.ssid}</span>
                <input
                  type="text"
                  value={ssid}
                  autocomplete="off"
                  autocapitalize="none"
                  spellcheck={false}
                  onInput={(e) => setSsid((e.target as HTMLInputElement).value)}
                />
              </label>
            )}

            {net.hidden && ssid !== '' && !ssidOk && (
              <p class="alert alert--error">{t.ssidTooLong}</p>
            )}

            {/* Le bande sono una proprietà della rete, non due reti: la
                password e la cifratura qui sotto valgono per tutte e due. */}
            <div class="field">
              <span id="bande-rete">{t.bands}</span>
              <div role="group" aria-labelledby="bande-rete">
                {BANDS.map((band) => (
                  <label class="check" key={band}>
                    <input
                      type="checkbox"
                      checked={bands[band]}
                      onChange={(e) =>
                        toggleBand(band, (e.target as HTMLInputElement).checked)
                      }
                    />
                    <span>{bandLabel(band)}</span>
                  </label>
                ))}
              </div>
            </div>

            {!hasAnyBand(bands) && (
              <p class="alert alert--error">{t.pickBand}</p>
            )}

            {conflicts.map(({ band, net: other }) => (
              <p class="alert alert--error" key={band}>
                {t.conflict(other.ssid, bandLabel(band), other.note)}
              </p>
            ))}

            <label class="field">
              <span>{t.password}</span>
              <input
                type="password"
                value={password}
                autocomplete="new-password"
                placeholder={
                  net.has_key ? t.keepPassword : t.minPassword
                }
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
              />
            </label>

            {/* Un MAC per banda, e solo per quelle accese: e' l'indirizzo della
                stazione su quella radio, quindi due radio hanno due indirizzi.
                Cambiarne uno non tocca l'altro. */}
            {bandList(bands).map((band) => (
              <MacPicker
                key={band}
                choice={mac[band]}
                label={t.macOn(bandLabel(band))}
                onChange={(choice) => setMac({ ...mac, [band]: choice })}
              />
            ))}

            <HostnamePicker
              choice={hostname}
              deviceHostname={deviceHostname}
              onChange={setHostname}
            />

            <label class="field">
              <span>{t.note}</span>
              <input
                type="text"
                value={note}
                placeholder={t.notePlaceholder}
                onInput={(e) => setNote((e.target as HTMLInputElement).value)}
              />
            </label>

            {error && <p class="alert alert--error alert--code">{error}</p>}

            <div class="sheet__actions">
              <button class="button button--ghost" onClick={() => setMode('menu')}>
                {actions.back}
              </button>
              <button
                class="button button--primary"
                disabled={
                  busy ||
                  !hostnameOk ||
                  !ssidOk ||
                  !hasAnyBand(bands) ||
                  !macOk ||
                  conflicts.length > 0 ||
                  (password !== '' && password.length < 8)
                }
                onClick={() =>
                  void guard(() =>
                    updateNetwork(net.section, {
                      note,
                      ...bandValues(bands, mac),
                      hostname_mode: hostname.mode,
                      hostname_value: hostname.mode === 'custom' ? hostname.value.trim() : '',
                      ...(password ? { key: password } : {}),
                      ...(net.hidden ? { ssid: ssid.trim() } : {}),
                    }),
                  )
                }
              >
                {actions.save}
              </button>
            </div>
          </>
        )}

        {mode === 'connecting' && (
          <>
            <ApplyStatus apply={apply} onClose={() => onClose(true)} />

            {checking && (
              <p class="muted">{t.connecting}</p>
            )}

            {outcome === 'ok' && (
              <p class="alert alert--ok">{t.ok(net.ssid)}</p>
            )}

            {outcome === 'no-address' && (
              <p class="alert alert--warn">{t.noAddress(net.ssid)}</p>
            )}

            {outcome === 'wrong-key' && (
              <p class="alert alert--error">{t.wrongKey(net.ssid)}</p>
            )}

            {outcome === 'not-found' && (
              <p class="alert alert--warn">{t.notFound(net.ssid)}</p>
            )}

            {outcome === 'unassociated' && (
              <p class="alert alert--warn">{t.unassociated(net.ssid)}</p>
            )}

            {/* Non un fallimento: un'assenza di misura. Dirlo com'è evita di
                annotare nella storia della rete un guasto che nessuno ha
                visto - il router potrebbe essersi agganciato benissimo. */}
            {outcome === 'unknown' && (
              <p class="alert alert--warn">{t.unknown}</p>
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
                    {t.edit}
                  </button>
                )}
                <button class="button button--primary" onClick={() => onClose(true)}>
                  {actions.close}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
