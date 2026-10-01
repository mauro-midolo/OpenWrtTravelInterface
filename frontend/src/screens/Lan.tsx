import { useCallback, useEffect, useState } from 'preact/hooks';
import { UbusError } from '../lib/ubus';
import { useApply } from '../lib/apply';
import {
  dropOldAddress,
  CLIENT_DNS_OPTIONS,
  ROUTER_DNS_OPTIONS,
  checkPool,
  clientDetail,
  clientLink,
  clientTitle,
  clientDns,
  dnsEditable,
  dnsFieldsOk,
  dnsProvider,
  findConflicts,
  getEthPorts,
  getLan,
  isHostAddress,
  listClients,
  matchDnsProvider,
  matchRaMode,
  prefix24,
  RA_OPTIONS,
  stageEthMac,
  stageEthPort,
  stripPrefix,
  stageLan,
  suggestAddress,
} from '../lib/lan';
import type {
  Conflict,
  DnsProvider,
  EthPort,
  EthPorts,
  LanClient,
  LanConfig,
  LanSettings,
  PortMode,
  PortRole,
  RaMode,
  WanSubnet,
} from '../lib/lan';
import { isValidIp } from '../lib/ip';
import { getUplinks, isValidMac, normalizeMac } from '../lib/wifi';
import type { MacChoice } from '../lib/wifi';
import { ApplyStatus } from '../components/ApplyStatus';
import { MacPicker } from '../components/MacPicker';
import { commonText } from '../i18n/common';
import { lanText } from '../i18n/lan';

/**
 * Finestra lunga: dopo lo spostamento il dispositivo deve rinnovare il DHCP e
 * ritrovare l'interfaccia. Novanta secondi non bastano per farlo con calma.
 */
const LAN_ROLLBACK_SECONDS = 300;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div class="row">
      <span class="row__label">{label}</span>
      <span class="row__value">{value}</span>
    </div>
  );
}


export function Lan({ onLogout }: { onLogout: () => void }) {
  const t = lanText();
  const [lan, setLan] = useState<LanConfig | null>(null);
  const [wans, setWans] = useState<WanSubnet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    setError(null);
    getLan()
      .then(setLan)
      .catch((err) => {
        if (err instanceof UbusError && err.isAuthError) return onLogout();
        setError(err instanceof Error ? err.message : String(err));
      });
    getUplinks()
      .then((list) =>
        setWans(
          list
            .filter((u) => u.ipv4)
            .map((u) => ({
              label: u.band ? `WiFi ${u.band} GHz` : u.network,
              ipv4: u.ipv4 ?? '',
              netmask: u.netmask ?? '255.255.255.0',
            })),
        ),
      )
      .catch(() => setWans([]));
  }, [onLogout]);

  useEffect(reload, [reload]);

  const primary = lan?.addresses[0] ?? '';
  const extra = (lan?.addresses ?? []).slice(1);
  const conflicts: Conflict[] = lan ? findConflicts(primary, lan.netmask, wans) : [];
  const suggestion = lan ? suggestAddress(primary, wans) : null;

  /**
   * Toglie gli indirizzi di sicurezza, lasciando solo quello nuovo.
   *
   * Senza ritorno indietro: la configurazione ha gia' dimostrato di funzionare,
   * ed e' quella su cui si vuole restare. Chi sta ancora usando il vecchio
   * indirizzo perde la pagina in questo momento, ed e' scritto prima.
   */
  const removeOld = async () => {
    setBusy(true);
    try {
      await dropOldAddress(primary);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="screen">
      <header class="topbar">
        <h1>{t.title}</h1>
        <button class="button button--ghost" onClick={reload}>
          {commonText().actions.refresh}
        </button>
      </header>

      {error && <p class="alert alert--error alert--code">{error}</p>}
      {!lan && !error && <p class="muted">{t.loading}</p>}

      {lan && extra.length > 0 && (
        <section class="card uplink uplink--no-address">
          <h2 class="uplink__title">{t.transition}</h2>
          <Row label={t.newAddress} value={primary} />
          {extra.map((address) => (
            <Row key={address} label={t.oldAddress} value={address} />
          ))}
          <p class="muted">{t.checkNew(primary)}</p>
          <button
            class="button button--primary"
            disabled={busy}
            onClick={() => void removeOld()}
          >
            {t.removeOld}
          </button>
        </section>
      )}

      {lan && conflicts.length > 0 && (
        <section class="card uplink uplink--unassociated">
          <h2 class="uplink__title">{t.conflict}</h2>
          <p>{t.conflictText}</p>
          {conflicts.map((c) => (
            <Row key={c.label} label={c.label} value={c.ipv4} />
          ))}
          {suggestion && (
            <p class="muted">{t.freeRange(suggestion)}</p>
          )}
          <button class="button button--primary" onClick={() => setEditing(true)}>
            {t.moveLan}
          </button>
        </section>
      )}

      {lan && (
        <section class="card">
          <header class="radio__head">
            <h2 class="uplink__title">{t.current}</h2>
            <button class="button button--ghost" onClick={() => setEditing(true)}>
              {t.edit}
            </button>
          </header>
          <Row label={t.routerAddress} value={primary || '—'} />
          <Row label={t.network} value={t.networkValue(prefix24(primary))} />
          {/* Solo dove IPv6 c'e': su una LAN senza, righe con un trattino
              direbbero che manca qualcosa invece che "qui non c'e'". */}
          {lan.addresses6.length > 0 && (
            <Row label={t.address6} value={lan.addresses6.join('  ')} />
          )}
          {lan.ula && <Row label={t.ula} value={lan.ula} />}
          <Row label={t.ra} value={raModeLabel(matchRaMode(lan))} />
          <Row label={t.device} value={lan.device || '—'} />
          <Row
            label={t.pool}
            value={
              lan.dhcp.ignore
                ? t.disabled
                : `${lan.dhcp.start} → ${Number(lan.dhcp.start) + Number(lan.dhcp.limit) - 1} · lease ${lan.dhcp.leasetime}`
            }
          />
          <Row
            label={t.clientDns}
            value={lan.dns_client.length > 0 ? lan.dns_client.join('  ') : t.routerItself}
          />
          {lan.dns_client6.length > 0 && (
            <Row label={t.clientDns6} value={lan.dns_client6.join('  ')} />
          )}
          <Row
            label={t.resolver}
            value={lan.dns_upstream.length > 0 ? lan.dns_upstream.join('  ') : t.wanOnes}
          />
        </section>
      )}

      <EthPortCard />

      <ClientsCard />

      {editing && lan && (
        <LanSheet
          lan={lan}
          suggestion={conflicts.length > 0 ? suggestion : null}
          onClose={(changed) => {
            setEditing(false);
            if (changed) reload();
          }}
        />
      )}
    </main>
  );
}

/**
 * Quanto si ha per confermare un cambio di MAC su una porta.
 *
 * Piu' dei novanta secondi soliti, per lo stesso motivo per cui ne servono di
 * piu' cambiando il MAC della STA: l'indirizzo nuovo fa cadere il collegamento
 * e obbliga a rifare il DHCP, e chi sta guardando la pagina proprio da quella
 * porta deve avere il tempo di tornare dentro.
 */
const MAC_ROLLBACK_SECONDS = 150;

const roleLabel = (role: PortRole): string => lanText().role[role];

/**
 * MAC di una porta ethernet.
 *
 * Stessa scelta e stesso controllo del MAC di una rete WiFi - \`MacPicker\` e'
 * lo stesso componente - perche' e' la stessa decisione presa su un'altra
 * interfaccia: cambiare i quattro modi o il loro aspetto fra una scheda e
 * l'altra farebbe pensare a due impostazioni diverse.
 *
 * Passa da applica-e-conferma con una verifica in piu', come il cambio di
 * ruolo della porta: il MAC viene riletto dal router e deve corrispondere a
 * quello chiesto. "Il router risponde" non basta come prova, perche' da
 * un'altra porta o dal WiFi risponde comunque anche se netifd non ha applicato
 * niente.
 */
function EthMacSheet({
  port,
  onClose,
}: {
  port: EthPort;
  onClose: (changed: boolean) => void;
}) {
  const t = lanText();
  const actions = commonText().actions;
  const apply = useApply();
  // Si riparte da com'e' adesso: un MAC gia' imposto compare nella casella
  // manuale, pronto da correggere invece che da ridigitare.
  //
  // Normalizzato anche qui, e non solo quando esce dal controllo: uci conserva
  // il maiuscolo di un macaddr scritto a mano, e un valore ripreso cosi' com'e'
  // risulterebbe diverso da se stesso appena confrontato con l'indirizzo in
  // uso, che il kernel riporta minuscolo. Il foglio si aprirebbe con "Applica"
  // gia' attivo senza che nulla sia cambiato, e quell'applicazione non
  // potrebbe mai essere confermata.
  const [mac, setMac] = useState<MacChoice>(() =>
    port.mac_config
      ? { mode: 'manual', value: normalizeMac(port.mac_config) }
      : { mode: 'device', value: '' },
  );
  const [done, setDone] = useState(false);

  // Entrambi in forma canonica: e' l'unico modo perche' il confronto fra il
  // MAC scritto e quello in uso voglia dire qualcosa.
  const want = mac.mode === 'device' ? '' : normalizeMac(mac.value);
  const before = normalizeMac(port.mac_config);
  const valid = mac.mode === 'device' || isValidMac(want);
  const changed = want !== before;

  const go = async () => {
    const confirmed = await apply.run(() => stageEthMac(port, want), {
      verify: async () => {
        const fresh = await getEthPorts();
        const now = fresh.ports.find((p) => p.name === port.name);
        if (!now) return false;
        // Si controlla l'indirizzo in uso, non quello scritto: la scrittura in
        // uci l'ha gia' garantita `uci apply`, mentre quello che interessa e'
        // che netifd lo abbia davvero messo sulla porta.
        if (want) return normalizeMac(now.mac) === want;
        // Ritorno a quello di fabbrica: non lo si conosce in anticipo, ma si sa
        // che non deve piu' esserci l'opzione e che l'indirizzo non deve piu'
        // essere quello che si era imposto.
        return now.mac_config === '' && normalizeMac(now.mac) !== before;
      },
      seconds: MAC_ROLLBACK_SECONDS,
    });
    if (confirmed) setDone(true);
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{t.macOf(port.name)}</h2>

        {apply.phase === 'idle' && !done && (
          <>
            <p class="muted">{t.macNow(port.mac || '—', Boolean(port.mac_config))}</p>

            <MacPicker
              choice={mac}
              onChange={setMac}
            />

            {/* L'avviso dipende da cosa fa la porta adesso, perche' le
                conseguenze sono opposte: da una parte la rete del posto ti
                vede come un dispositivo nuovo, dall'altra si muove la rete
                locale sotto ai tuoi. */}
            <p class="alert alert--warn">
              {port.role === 'wan'
                ? t.macWarnWan
                : port.role === 'lan'
                  ? t.macWarnLan
                  : t.macWarnFree}
            </p>

            <div class="sheet__actions">
              <button class="button button--ghost" onClick={() => onClose(false)}>
                {actions.cancel}
              </button>
              <button
                class="button button--primary"
                disabled={!valid || !changed}
                onClick={go}
              >
                {want ? t.apply : t.removeMac}
              </button>
            </div>
          </>
        )}

        <ApplyStatus apply={apply} onClose={() => onClose(true)} />

        {done && (
          <>
            <p class="alert alert--ok">
              {want ? t.macSet(port.name, want) : t.macReset(port.name)}
            </p>
            <div class="sheet__actions">
              <button class="button button--primary" onClick={() => onClose(true)}>
                {actions.close}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Porte ethernet commutabili (requisito C).
 *
 * Ogni porta puo' fare l'uplink o stare nella rete locale, indipendentemente
 * dalle altre: due connessioni via cavo distinte sono una configurazione
 * legittima, e per mwan3 diventano due WAN.
 *
 * E' l'operazione che ti chiude fuori se sbagliata, perche' ci si collega via
 * cavo proprio a quelle porte. Passa da applica-e-conferma con una verifica in
 * piu': il ruolo viene riletto dal router e deve corrispondere a quello
 * chiesto, non basta che risponda.
 */
function EthPortCard() {
  const t = lanText();
  const actions = commonText().actions;
  const apply = useApply();
  const [info, setInfo] = useState<EthPorts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<{ port: EthPort; target: PortMode } | null>(null);
  /** Porta di cui si sta cambiando il MAC, o nessuna. */
  const [macPort, setMacPort] = useState<EthPort | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(() => {
    getEthPorts()
      .then((i) => {
        setInfo(i);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(load, [load]);

  const go = async () => {
    if (!info || !pick) return;
    const { port, target } = pick;
    const ok = await apply.run(() => stageEthPort(info, port, target), {
      verify: async () => {
        const fresh = await getEthPorts();
        return fresh.ports.find((p) => p.name === port.name)?.role === target;
      },
    });
    if (ok) setDone(true);
  };

  const close = () => {
    setPick(null);
    setDone(false);
    apply.reset();
    load();
  };

  const ports = info?.ports ?? [];
  const lanCount = ports.filter((p) => p.role === 'lan').length;
  const wanCount = ports.filter((p) => p.role === 'wan').length;

  // Avvisi che dipendono da cosa resta dopo l'operazione, non dall'operazione
  // in se': togliere l'ultima porta LAN o l'ultimo uplink via cavo cambia
  // parecchio cosa puoi fare dopo.
  const lastOfKind =
    pick &&
    ((pick.target === 'wan' && pick.port.role === 'lan' && lanCount === 1) ||
      (pick.target === 'lan' && pick.port.role === 'wan' && wanCount === 1));

  return (
    <>
      <section class="card">
        <h2 class="uplink__title">{t.ports}</h2>

        {error && <p class="alert alert--error alert--code">{error}</p>}
        {!info && !error && <p class="muted">{t.loading}</p>}

        {info && ports.length === 0 && (
          <p class="muted">{t.noPorts}</p>
        )}

        {ports.map((port) => (
          <div key={port.name} class="port">
            <div class="port__main">
              <span class="net__ssid">{port.name}</span>
              <span class="net__meta">
                {roleLabel(port.role)} ·{' '}
                {port.carrier === 1 ? t.cable : port.carrier === 0 ? t.noCable : t.cableUnknown}
                {port.network ? ` · ${port.network}` : ''}
              </span>
              {/* Il MAC su una riga sua: e' lungo quanto il resto messo
                  insieme, e in coda alla prima riga la manderebbe a capo su
                  ogni porta. Quando quello impostato non e' ancora quello in
                  uso lo si dice, perche' e' la spia di una configurazione
                  scritta che netifd non ha applicato. */}
              <span class="net__meta">
                MAC {port.mac || '—'}
                {port.mac_config === ''
                  ? t.factory
                  : normalizeMac(port.mac_config) === normalizeMac(port.mac)
                    ? t.macConfigured
                    : t.macPending(port.mac_config)}
              </span>
            </div>
            <div class="port__controls">
              <button class="button button--ghost" onClick={() => setMacPort(port)}>
                {t.changeMac}
              </button>
              <button
                class="button button--ghost"
                onClick={() => setPick({ port, target: port.role === 'wan' ? 'lan' : 'wan' })}
              >
                {port.role === 'wan' ? t.useAsLan : t.useAsWan}
              </button>
            </div>
          </div>
        ))}

      </section>

      {macPort && (
        <EthMacSheet
          port={macPort}
          onClose={(applied) => {
            setMacPort(null);
            if (applied) load();
          }}
        />
      )}

      {pick && info && (
        <div class="sheet" role="dialog" aria-modal="true">
          <div class="sheet__panel card">
            <h2>
              {pick.port.name} → {pick.target === 'lan' ? 'LAN' : 'WAN'}
            </h2>

            {apply.phase === 'idle' && !done && (
              <>
                <p class="alert alert--warn">
                  {pick.target === 'lan'
                    ? t.toLanWarn
                    : t.toWanWarn}
                </p>

                {lastOfKind && (
                  <p class="alert alert--error">
                    {pick.target === 'wan'
                      ? t.lastLan
                      : t.lastWan}
                  </p>
                )}

                <div class="sheet__actions">
                  <button class="button button--ghost" onClick={close}>
                    {actions.cancel}
                  </button>
                  <button class="button button--primary" onClick={go}>
                    {actions.proceed}
                  </button>
                </div>
              </>
            )}

            <ApplyStatus apply={apply} onClose={close} />

            {done && (
              <>
                <p class="alert alert--ok">
                  {t.portDone(pick.port.name, pick.target === 'lan')}
                </p>
                <div class="sheet__actions">
                  <button class="button button--primary" onClick={close}>
                    {actions.close}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Chi e' collegato alla rete locale.
 *
 * Sta sotto le porte ethernet perche' risponde alla domanda successiva: capito
 * come sono messe le prese, si vuole sapere chi c'e' dietro. Per la stessa
 * ragione la colonna a destra usa il nome vero della porta - lo stesso che
 * compare nella scheda qui sopra - e non un'etichetta inventata: e' quello che
 * permette di collegare la riga a un cavo da staccare.
 *
 * Non e' in polling: un elenco che si riordina da solo mentre lo si legge e'
 * peggio di uno fermo, e chi ha appena collegato un dispositivo sa di doverlo
 * cercare. Il pulsante rilegge.
 */
function ClientsCard() {
  const t = lanText();
  const [clients, setClients] = useState<LanClient[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listClients()
      .then((list) => {
        setClients(list);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(load, [load]);

  return (
    <section class="card">
      <header class="radio__head">
        <h2 class="uplink__title">{t.clients}</h2>
        <button class="button button--ghost" onClick={load}>
          {commonText().actions.refresh}
        </button>
      </header>

      {error && <p class="alert alert--error alert--code">{error}</p>}
      {!clients && !error && <p class="muted">{t.loadingClients}</p>}

      {clients && clients.length === 0 && (
        <p class="muted">{t.noClients}</p>
      )}

      {(clients ?? []).map((client) => (
        <div key={client.mac} class="port">
          <div class="port__main">
            <span class={client.name ? 'net__ssid' : 'net__ssid net__ssid--hidden'}>
              {clientTitle(client)}
            </span>
            <span class="net__meta">{clientDetail(client)}</span>
          </div>
          <span class="port__from">{clientLink(client)}</span>
        </div>
      ))}

    </section>
  );
}

/** Indirizzi da scrivere per una scelta della tendina. */
/**
 * Un elenco di DNS che questa schermata non sa modificare.
 *
 * Piu' di due indirizzi scelti a mano non entrano nei due campi: mostrarne solo
 * i primi due e poi salvare cancellerebbe gli altri senza dirlo. Si mostrano
 * tutti e si lasciano stare - stessa regola della modalita' RA che non si
 * riconosce.
 */
function DnsUntouched({ title, servers }: { title: string; servers: string[] }) {
  return (
    <div class="field">
      <span>{title}</span>
      <span class="row__value">{servers.join('  ')}</span>
      <span class="muted">{lanText().luciOnly}</span>
    </div>
  );
}

/** Etichetta della modalita' RA, compreso lo stato che non si puo' scegliere. */
function raModeLabel(mode: RaMode): string {
  if (mode === 'custom') return lanText().raCustom;
  return RA_OPTIONS.find((o) => o.id === mode)?.label ?? mode;
}

/**
 * I DNS scelti, divisi per famiglia.
 *
 * Divisi e non in un elenco solo perche' finiscono in due posti diversi: i v4
 * in `dhcp_option 6`, i v6 in `dhcp.lan.dns`. Mescolarli e' esattamente
 * l'errore che rompe anche i DNS v4 (vedi il commento in `stageLan`).
 *
 * Un fornitore porta con se' entrambe le meta'; nei campi liberi si guarda cosa
 * e' stato scritto, cosi' due caselle bastano per una coppia mista.
 */
function resolveDns(
  mode: string,
  options: DnsProvider[],
  one: string,
  two: string,
): { v4: string[]; v6: string[] } {
  if (mode === 'auto') return { v4: [], v6: [] };
  if (mode === 'custom') {
    const typed = [one, two].map((s) => s.trim()).filter((s) => s.length > 0);
    return {
      v4: typed.filter((s) => isValidIp(s, 4)),
      v6: typed.filter((s) => isValidIp(s, 6)),
    };
  }
  const provider = dnsProvider(mode, options);
  return { v4: provider?.servers ?? [], v6: provider?.servers6 ?? [] };
}

/**
 * Scelta dei DNS: un fornitore noto, l'automatico, oppure due campi.
 *
 * Gli indirizzi dei fornitori si vedono ma non si toccano: sono la definizione
 * della voce scelta, non un valore da modificare - e poterli cambiare senza che
 * l'etichetta cambi renderebbe la tendina bugiarda.
 */
function DnsChoice({
  title,
  options,
  mode,
  onMode,
  one,
  two,
  onOne,
  onTwo,
  ipv6,
}: {
  title: string;
  options: DnsProvider[];
  mode: string;
  onMode: (id: string) => void;
  one: string;
  two: string;
  onOne: (value: string) => void;
  onTwo: (value: string) => void;
  /** Se questa lista accetta anche indirizzi IPv6. Cambia tastiera e avviso. */
  ipv6: boolean;
}) {
  const t = lanText();
  const chosen = dnsProvider(mode, options);
  // Un tastierino numerico non ha i due punti ne' le lettere: su un telefono
  // renderebbe impossibile scrivere un indirizzo v6 nel campo che lo accetta.
  const keyboard = ipv6 ? 'text' : 'decimal';

  return (
    <div class="field">
      <span>{title}</span>
      <select value={mode} onChange={(e) => onMode((e.target as HTMLSelectElement).value)}>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>

      {chosen && chosen.servers.length > 0 && (
        <span class="muted">{chosen.servers.join('  ·  ')}</span>
      )}

      {mode === 'custom' && (
        <>
          <label class="field">
            <span>{t.dnsPrimary}</span>
            <input
              type="text"
              value={one}
              inputMode={keyboard}
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => onOne((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="field">
            <span>{t.dnsSecondary}</span>
            <input
              type="text"
              value={two}
              inputMode={keyboard}
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => onTwo((e.target as HTMLInputElement).value)}
            />
          </label>
          {!ipv6 && <span class="muted">{t.ipv4Only}</span>}
        </>
      )}
    </div>
  );
}

function LanSheet({
  lan,
  suggestion,
  onClose,
}: {
  lan: LanConfig;
  suggestion: string | null;
  onClose: (changed: boolean) => void;
}) {
  const t = lanText();
  const actions = commonText().actions;
  const apply = useApply();
  const current = lan.addresses[0] ?? '';

  const [address, setAddress] = useState(suggestion ?? current);
  const [from, setFrom] = useState(String(Number(lan.dhcp.start) || 100));
  const [to, setTo] = useState(
    String((Number(lan.dhcp.start) || 100) + (Number(lan.dhcp.limit) || 150) - 1),
  );

  // Tutte e due le famiglie, non la sola v4: quello che non finisce qui dentro
  // non esiste per la schermata, e il salvataggio lo cancellerebbe.
  const clientCurrent = clientDns(lan);
  const [clientMode, setClientMode] = useState(
    matchDnsProvider(clientCurrent, CLIENT_DNS_OPTIONS),
  );
  const [clientOne, setClientOne] = useState(clientCurrent[0] ?? '');
  const [clientTwo, setClientTwo] = useState(clientCurrent[1] ?? '');

  // Piu' di due indirizzi scelti a mano non entrano in due campi. Mostrarne
  // solo i primi due e poi salvare butterebbe via il resto in silenzio: si
  // guarda e basta, come per la modalita' RA che non si riconosce.
  const clientEditable = dnsEditable(clientCurrent, CLIENT_DNS_OPTIONS);
  const routerEditable = dnsEditable(lan.dns_upstream, ROUTER_DNS_OPTIONS);

  const [routerMode, setRouterMode] = useState(
    matchDnsProvider(lan.dns_upstream, ROUTER_DNS_OPTIONS),
  );
  const [routerOne, setRouterOne] = useState(lan.dns_upstream[0] ?? '');
  const [routerTwo, setRouterTwo] = useState(lan.dns_upstream[1] ?? '');

  // `custom` non e' fra le scelte offerte: e' lo stato in cui il router si
  // trova quando la sua configurazione non e' nessuna delle tre. In quel caso
  // la schermata mostra i valori grezzi e non li sovrascrive.
  const currentRa = matchRaMode(lan);
  const [raMode, setRaMode] = useState<RaMode>(currentRa);

  const [done, setDone] = useState(false);

  const moves = address !== current;
  const addressOk = isHostAddress(address);
  const net = prefix24(address);

  const fromN = Number(from);
  const toN = Number(to);
  const poolProblem = addressOk ? checkPool(address, fromN, toN) : null;

  // Il secondario e' facoltativo: si scartano i campi vuoti invece di
  // pretenderli, perche' un DNS solo e' una configurazione legittima.
  const clientServers = resolveDns(clientMode, CLIENT_DNS_OPTIONS, clientOne, clientTwo);
  const routerServers = resolveDns(routerMode, ROUTER_DNS_OPTIONS, routerOne, routerTwo);

  // Entrambe le liste accettano ora tutte e due le famiglie: quelle annunciate
  // ai dispositivi non finiscono piu' tutte in `dhcp_option 6` - i v6 vanno in
  // `dhcp.lan.dns`, che li annuncia davvero - e quelle del router in
  // `dhcp.<sezione>.server`, che dnsmasq accetta senza sintassi speciale.
  // Solo gli elenchi che si possono davvero modificare entrano nel controllo.
  // Uno che la schermata mostra e non tocca non deve poter bloccare il
  // salvataggio del resto: i suoi valori non vengono scritti, e non c'e'
  // nemmeno un campo dove correggerli.
  const dnsOk =
    dnsFieldsOk(clientEditable, clientMode, clientOne, clientTwo) &&
    dnsFieldsOk(routerEditable, routerMode, routerOne, routerTwo);

  const save = async (event: Event) => {
    event.preventDefault();

    const settings: LanSettings = {
      address,
      poolFrom: fromN,
      poolTo: toN,
      // `null` dove la schermata non ha saputo rappresentare la lista: si
      // lascia com'e' invece di riscriverne una versione troncata.
      dnsClient: clientEditable ? clientServers.v4 : null,
      dnsClient6: clientEditable ? clientServers.v6 : null,
      // I resolver del router stanno in una lista sola: dnsmasq le mescola
      // senza problemi, ed e' `matchDnsProvider` a guardare la sola meta' v4
      // quando la rilegge.
      dnsUpstream: routerEditable ? [...routerServers.v4, ...routerServers.v6] : null,
      raMode,
    };

    const ok = await apply.run(() => stageLan(settings, moves ? current : null, lan), {
      seconds: LAN_ROLLBACK_SECONDS,
      // Non basta che il router risponda: risponde sul vecchio indirizzo, che
      // resta attivo per costruzione. La prova e' che netifd abbia davvero
      // accettato quello nuovo.
      verify: async () => {
        const fresh = await getLan();
        // Anche la modalita' RA: e' una scrittura su `dhcp` e non su `network`,
        // quindi puo' fallire per conto suo mentre l'indirizzo prende. Senza
        // questo controllo la conferma direbbe di si' a una meta' del lavoro.
        const raOk = raMode === 'custom' || matchRaMode(fresh) === raMode;
        return fresh.addresses.includes(address) && raOk;
      },
    });

    if (ok) setDone(true);
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{t.title}</h2>

        {apply.phase === 'idle' && !done && (
          <form onSubmit={save}>
            <label class="field">
              <span>{t.routerIp}</span>
              <input
                type="text"
                value={address}
                inputMode="decimal"
                autocomplete="off"
                spellcheck={false}
                placeholder="192.168.10.1"
                onInput={(e) => setAddress(stripPrefix((e.target as HTMLInputElement).value))}
              />
              {!addressOk && address !== '' && (
                <span class="muted">{t.badIp}</span>
              )}
            </label>

            <div class="field">
              <span>{t.poolField}</span>
              <div class="range">
                <span class="range__label">{t.from}</span>
                <input
                  type="text"
                  class="range__box"
                  value={from}
                  inputMode="numeric"
                  aria-label={t.firstAssigned}
                  onInput={(e) => setFrom((e.target as HTMLInputElement).value)}
                />
                <span class="range__label">{t.to}</span>
                <input
                  type="text"
                  class="range__box"
                  value={to}
                  inputMode="numeric"
                  aria-label={t.lastAssigned}
                  onInput={(e) => setTo((e.target as HTMLInputElement).value)}
                />
              </div>
              {addressOk && !poolProblem && (
                <span class="muted">{t.poolSummary(net, fromN, toN)}</span>
              )}
              {poolProblem && <span class="alert alert--error">{poolProblem.message}</span>}
            </div>

            <div class="field">
              <span>{t.raField}</span>
              {currentRa === 'custom' ? (
                <>
                  {/* Il router e' in una configurazione che non e' nessuna
                      delle tre. Mostrarla come una delle tre sarebbe dire una
                      cosa falsa, e salvarla la butterebbe via: si guarda e
                      basta, come fa la scelta dei DNS con un fornitore che non
                      riconosce. */}
                  <span class="muted">
                    ra <strong>{lan.ra || '—'}</strong>, dhcpv6 <strong>{lan.dhcpv6 || '—'}</strong>
                    {lan.ra_flags.length > 0 && <> , flag <strong>{lan.ra_flags.join(' ')}</strong></>}
                    {t.raLuciOnly}
                  </span>
                </>
              ) : (
                <>
                  <select
                    value={raMode}
                    onChange={(e) => setRaMode((e.target as HTMLSelectElement).value as RaMode)}
                  >
                    {RA_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>

            {clientEditable ? (
              <DnsChoice
                title={t.clientDnsField}
                options={CLIENT_DNS_OPTIONS}
                mode={clientMode}
                onMode={setClientMode}
                one={clientOne}
                two={clientTwo}
                onOne={setClientOne}
                onTwo={setClientTwo}
                ipv6
              />
            ) : (
              <DnsUntouched title={t.clientDnsField} servers={clientCurrent} />
            )}

            {routerEditable ? (
              <DnsChoice
                title={t.routerDnsField}
                options={ROUTER_DNS_OPTIONS}
                mode={routerMode}
                onMode={setRouterMode}
                one={routerOne}
                two={routerTwo}
                onOne={setRouterOne}
                onTwo={setRouterTwo}
                ipv6
              />
            ) : (
              <DnsUntouched title={t.routerDnsField} servers={lan.dns_upstream} />
            )}

            {routerMode !== 'auto' && (
              <p class="alert alert--warn">{t.fixedDnsWarn}</p>
            )}

            {moves && (
              <p class="alert alert--warn">
                {t.moving(current, address)}
              </p>
            )}

            <div class="sheet__actions">
              <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
                {actions.cancel}
              </button>
              <button
                class="button button--primary"
                type="submit"
                disabled={!addressOk || poolProblem !== null || !dnsOk}
              >
                {t.apply}
              </button>
            </div>
          </form>
        )}

        <ApplyStatus apply={apply} onClose={() => onClose(true)} />

        {done && (
          <>
            <p class="alert alert--ok">
              {t.applied}
              {moves && (
                <>
                  {' '}
                  {t.nowOn(address)}
                </>
              )}
            </p>
            <div class="sheet__actions">
              <button class="button button--primary" onClick={() => onClose(true)}>
                {actions.close}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
