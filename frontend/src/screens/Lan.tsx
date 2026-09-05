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
  dnsProvider,
  findConflicts,
  getEthPorts,
  getLan,
  isHostAddress,
  isValidIp,
  listClients,
  matchDnsProvider,
  prefix24,
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
  WanSubnet,
} from '../lib/lan';
import { getUplinks } from '../lib/wifi';
import { ApplyStatus } from '../components/ApplyStatus';

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
        <h1>Rete locale</h1>
        <button class="button button--ghost" onClick={reload}>
          Aggiorna
        </button>
      </header>

      {error && <p class="alert alert--error alert--code">{error}</p>}
      {!lan && !error && <p class="muted">Leggo la configurazione…</p>}

      {lan && extra.length > 0 && (
        <section class="card uplink uplink--no-address">
          <h2 class="uplink__title">Transizione in corso</h2>
          <p>
            Il router risponde su <strong>due indirizzi</strong>: quello nuovo e il vecchio,
            tenuto come rete di sicurezza.
          </p>
          <Row label="Nuovo" value={primary} />
          {extra.map((address) => (
            <Row key={address} label="Vecchio" value={address} />
          ))}
          <p class="muted">
            Verifica di raggiungere l'interfaccia su <strong>https://{primary}/travel/</strong>,
            poi togli il vecchio. Finché è lì, hai sempre una via di rientro.
          </p>
          <button
            class="button button--primary"
            disabled={busy}
            onClick={() => void removeOld()}
          >
            Rimuovi il vecchio indirizzo
          </button>
        </section>
      )}

      {lan && conflicts.length > 0 && (
        <section class="card uplink uplink--unassociated">
          <h2 class="uplink__title">Conflitto di sottorete</h2>
          <p>
            La rete locale usa la stessa sottorete di una rete a monte. In questa
            situazione il traffico dei client <strong>non esce</strong>: il router non
            distingue più ciò che è locale da ciò che sta oltre.
          </p>
          {conflicts.map((c) => (
            <Row key={c.label} label={c.label} value={c.ipv4} />
          ))}
          {suggestion && (
            <p class="muted">
              Un intervallo libero: <strong>{suggestion}</strong>. Aprendo la modifica lo
              trovi già proposto.
            </p>
          )}
          <button class="button button--primary" onClick={() => setEditing(true)}>
            Sposta la rete locale
          </button>
        </section>
      )}

      {lan && (
        <section class="card">
          <header class="radio__head">
            <h2 class="uplink__title">Configurazione attuale</h2>
            <button class="button button--ghost" onClick={() => setEditing(true)}>
              Modifica
            </button>
          </header>
          <Row label="Indirizzo del router" value={primary || '—'} />
          <Row label="Rete" value={`${prefix24(primary)}.0 · 254 indirizzi`} />
          <Row label="Interfaccia" value={lan.device || '—'} />
          <Row
            label="Pool DHCP"
            value={
              lan.dhcp.ignore
                ? 'disattivato'
                : `${lan.dhcp.start} → ${Number(lan.dhcp.start) + Number(lan.dhcp.limit) - 1} · lease ${lan.dhcp.leasetime}`
            }
          />
          <Row
            label="DNS dati ai client"
            value={lan.dns_client.length > 0 ? lan.dns_client.join('  ') : 'il router stesso'}
          />
          <Row
            label="Resolver del router"
            value={
              lan.dns_upstream.length > 0 ? lan.dns_upstream.join('  ') : 'quelli della WAN'
            }
          />
        </section>
      )}

      {lan && (
        <p class="footnote">
          Due elenchi di DNS diversi: quelli <em>dati ai client</em> viaggiano nel DHCP,
          quelli del <em>router</em> servono a risolvere i nomi. Confonderli è il modo
          classico di rompere la risoluzione senza capire perché.
        </p>
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

const ROLE_LABEL: Record<PortRole, string> = {
  wan: 'WAN (uplink)',
  lan: 'LAN (bridge)',
  free: 'non assegnata',
};

/**
 * Porte ethernet commutabili (requisito C).
 *
 * Ogni porta puo' fare l'uplink o stare nella rete locale, indipendentemente
 * dalle altre: due connessioni via cavo distinte sono una configurazione
 * legittima, e in Fase 3 diventeranno due WAN per mwan3.
 *
 * E' l'operazione che ti chiude fuori se sbagliata, perche' ci si collega via
 * cavo proprio a quelle porte. Passa da applica-e-conferma con una verifica in
 * piu': il ruolo viene riletto dal router e deve corrispondere a quello
 * chiesto, non basta che risponda.
 */
function EthPortCard() {
  const apply = useApply();
  const [info, setInfo] = useState<EthPorts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<{ port: EthPort; target: PortMode } | null>(null);
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
        <h2 class="uplink__title">Porte ethernet</h2>

        {error && <p class="alert alert--error alert--code">{error}</p>}
        {!info && !error && <p class="muted">Leggo la configurazione…</p>}

        {info && ports.length === 0 && (
          <p class="muted">Nessuna porta ethernet rilevata sul dispositivo.</p>
        )}

        {ports.map((port) => (
          <div key={port.name} class="port">
            <div class="port__main">
              <span class="net__ssid">{port.name}</span>
              <span class="net__meta">
                {ROLE_LABEL[port.role]} ·{' '}
                {port.carrier === 1
                  ? 'cavo collegato'
                  : port.carrier === 0
                    ? 'nessun cavo'
                    : 'cavo non leggibile'}
                {port.network ? ` · ${port.network}` : ''}
              </span>
            </div>
            <button
              class="button button--ghost"
              onClick={() => setPick({ port, target: port.role === 'wan' ? 'lan' : 'wan' })}
            >
              {port.role === 'wan' ? 'Usa come LAN' : 'Usa come WAN'}
            </button>
          </div>
        ))}

        {ports.length > 0 && (
          <p class="muted">
            Come <strong>WAN</strong> la porta è un uplink: ci attacchi la rete del posto.
            Come <strong>LAN</strong> fa parte della tua rete: ci attacchi un computer. Più
            porte WAN insieme sono ammesse, e in Fase 3 diventeranno uplink distinti per il
            bilanciamento.
          </p>
        )}
      </section>

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
                    ? 'La porta entra nel bridge locale e smette di essere un uplink. Il bridge si riconfigura: chi è collegato via cavo perde il collegamento per qualche secondo.'
                    : "La porta esce dal bridge e diventa un uplink in DHCP. Un computer attaccato a questa porta perde la rete: assicurati di essere collegato da un'altra porta o dal WiFi prima di procedere."}
                </p>

                {lastOfKind && (
                  <p class="alert alert--error">
                    {pick.target === 'wan'
                      ? "È l'ultima porta LAN: dopo questa operazione al router ci si collega solo via WiFi."
                      : "È l'ultimo uplink via cavo: dopo questa operazione Internet può arrivare solo dal WiFi o dal tethering."}
                  </p>
                )}

                <p class="muted">
                  Se non riesci a confermare, dopo 90 secondi torna tutto come prima.
                </p>
                <div class="sheet__actions">
                  <button class="button button--ghost" onClick={close}>
                    Annulla
                  </button>
                  <button class="button button--primary" onClick={go}>
                    Procedi
                  </button>
                </div>
              </>
            )}

            <ApplyStatus apply={apply} onClose={close} />

            {done && (
              <>
                <p class="alert alert--ok">
                  Fatto: {pick.port.name} è ora{' '}
                  {pick.target === 'lan' ? 'una porta LAN' : 'un uplink WAN'}.
                </p>
                <div class="sheet__actions">
                  <button class="button button--primary" onClick={close}>
                    Chiudi
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
 * Chi e' collegato alla rete locale (Fase 7).
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
        <h2 class="uplink__title">Dispositivi collegati</h2>
        <button class="button button--ghost" onClick={load}>
          Aggiorna
        </button>
      </header>

      {error && <p class="alert alert--error alert--code">{error}</p>}
      {!clients && !error && <p class="muted">Leggo i dispositivi…</p>}

      {clients && clients.length === 0 && (
        <p class="muted">Nessun dispositivo collegato alla rete locale.</p>
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

      {clients && clients.length > 0 && (
        <p class="muted">
          Chi non ha un <strong>lease DHCP</strong> compare lo stesso, dalla tabella dei
          vicini del kernel: lì un dispositivo resta per qualche minuto anche dopo essersi
          scollegato, e senza un nome da mostrare.
        </p>
      )}
    </section>
  );
}

/** Indirizzi da scrivere per una scelta della tendina. */
function resolveDns(
  mode: string,
  options: DnsProvider[],
  one: string,
  two: string,
): string[] {
  if (mode === 'auto') return [];
  if (mode === 'custom') return [one, two].map((s) => s.trim()).filter((s) => s.length > 0);
  return dnsProvider(mode, options)?.servers ?? [];
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
  autoHint,
}: {
  title: string;
  options: DnsProvider[];
  mode: string;
  onMode: (id: string) => void;
  one: string;
  two: string;
  onOne: (value: string) => void;
  onTwo: (value: string) => void;
  autoHint: string;
}) {
  const chosen = dnsProvider(mode, options);

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

      {mode === 'auto' && <span class="muted">{autoHint}</span>}
      {chosen && chosen.servers.length > 0 && (
        <span class="muted">{chosen.servers.join('  ·  ')}</span>
      )}

      {mode === 'custom' && (
        <>
          <label class="field">
            <span>DNS primario</span>
            <input
              type="text"
              value={one}
              inputMode="decimal"
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => onOne((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="field">
            <span>DNS secondario (facoltativo)</span>
            <input
              type="text"
              value={two}
              inputMode="decimal"
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => onTwo((e.target as HTMLInputElement).value)}
            />
          </label>
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
  const apply = useApply();
  const current = lan.addresses[0] ?? '';

  const [address, setAddress] = useState(suggestion ?? current);
  const [from, setFrom] = useState(String(Number(lan.dhcp.start) || 100));
  const [to, setTo] = useState(
    String((Number(lan.dhcp.start) || 100) + (Number(lan.dhcp.limit) || 150) - 1),
  );

  const [clientMode, setClientMode] = useState(
    matchDnsProvider(lan.dns_client, CLIENT_DNS_OPTIONS),
  );
  const [clientOne, setClientOne] = useState(lan.dns_client[0] ?? '');
  const [clientTwo, setClientTwo] = useState(lan.dns_client[1] ?? '');

  const [routerMode, setRouterMode] = useState(
    matchDnsProvider(lan.dns_upstream, ROUTER_DNS_OPTIONS),
  );
  const [routerOne, setRouterOne] = useState(lan.dns_upstream[0] ?? '');
  const [routerTwo, setRouterTwo] = useState(lan.dns_upstream[1] ?? '');

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

  const dnsOk =
    (clientMode !== 'custom' || (isValidIp(clientOne) && (clientTwo === '' || isValidIp(clientTwo)))) &&
    (routerMode !== 'custom' || (isValidIp(routerOne) && (routerTwo === '' || isValidIp(routerTwo))));

  const save = async (event: Event) => {
    event.preventDefault();

    const settings: LanSettings = {
      address,
      poolFrom: fromN,
      poolTo: toN,
      dnsClient: clientServers,
      dnsUpstream: routerServers,
    };

    const ok = await apply.run(() => stageLan(settings, moves ? current : null, lan), {
      seconds: LAN_ROLLBACK_SECONDS,
      // Non basta che il router risponda: risponde sul vecchio indirizzo, che
      // resta attivo per costruzione. La prova e' che netifd abbia davvero
      // accettato quello nuovo.
      verify: async () => {
        const fresh = await getLan();
        return fresh.addresses.includes(address);
      },
    });

    if (ok) setDone(true);
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>Rete locale</h2>

        {apply.phase === 'idle' && !done && (
          <form onSubmit={save}>
            {suggestion && suggestion === address && (
              <p class="alert alert--info">
                Indirizzo proposto perché quello attuale collide con una rete a monte.
              </p>
            )}

            <label class="field">
              <span>Indirizzo IP del router</span>
              <input
                type="text"
                value={address}
                inputMode="decimal"
                autocomplete="off"
                spellcheck={false}
                placeholder="192.168.10.1"
                onInput={(e) => setAddress(stripPrefix((e.target as HTMLInputElement).value))}
              />
              {addressOk ? (
                <span class="muted">
                  La rete sarà {net}.0 → {net}.254, fino a 254 dispositivi.
                </span>
              ) : (
                address !== '' && (
                  <span class="muted">
                    Serve un indirizzo IPv4 con l'ultimo numero fra 1 e 254, come
                    192.168.10.1.
                  </span>
                )
              )}
            </label>

            <div class="field">
              <span>Indirizzi assegnati automaticamente</span>
              <div class="range">
                <span class="range__label">Da</span>
                <input
                  type="text"
                  class="range__box"
                  value={from}
                  inputMode="numeric"
                  aria-label="primo indirizzo assegnato"
                  onInput={(e) => setFrom((e.target as HTMLInputElement).value)}
                />
                <span class="range__label">A</span>
                <input
                  type="text"
                  class="range__box"
                  value={to}
                  inputMode="numeric"
                  aria-label="ultimo indirizzo assegnato"
                  onInput={(e) => setTo((e.target as HTMLInputElement).value)}
                />
              </div>
              {addressOk && !poolProblem && (
                <span class="muted">
                  {net}.{fromN} → {net}.{toN} · {toN - fromN + 1} dispositivi
                </span>
              )}
              {poolProblem && <span class="alert alert--error">{poolProblem.message}</span>}
            </div>

            <DnsChoice
              title="DNS per i dispositivi della rete"
              options={CLIENT_DNS_OPTIONS}
              mode={clientMode}
              onMode={setClientMode}
              one={clientOne}
              two={clientTwo}
              onOne={setClientOne}
              onTwo={setClientTwo}
              autoHint="I dispositivi useranno il router come DNS."
            />

            <DnsChoice
              title="DNS usati dal router"
              options={ROUTER_DNS_OPTIONS}
              mode={routerMode}
              onMode={setRouterMode}
              one={routerOne}
              two={routerTwo}
              onOne={setRouterOne}
              onTwo={setRouterTwo}
              autoHint="Il router userà i DNS che gli dà la rete a cui è collegato."
            />

            {routerMode !== 'auto' && (
              <p class="alert alert--warn">
                Con DNS fissi, una rete che richiede il login su pagina web potrebbe non
                riuscire a mandarti alla sua pagina: quei portali si appoggiano proprio al
                DNS della rete. Il rilevamento automatico arriva in Fase 5.
              </p>
            )}

            {moves && (
              <p class="alert alert--warn">
                Stai spostando il router da <strong>{current}</strong> a{' '}
                <strong>{address}</strong>. Il vecchio indirizzo <strong>resta attivo</strong>{' '}
                per tutta la finestra di conferma, così non puoi restare chiuso fuori: se
                qualcosa non torna, non confermi e dopo {LAN_ROLLBACK_SECONDS} secondi
                torna tutto come prima. I dispositivi collegati passeranno al nuovo
                indirizzo al rinnovo del DHCP.
              </p>
            )}

            <div class="sheet__actions">
              <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
                Annulla
              </button>
              <button
                class="button button--primary"
                type="submit"
                disabled={!addressOk || poolProblem !== null || !dnsOk}
              >
                Applica
              </button>
            </div>
          </form>
        )}

        <ApplyStatus apply={apply} onClose={() => onClose(true)} />

        {done && (
          <>
            <p class="alert alert--ok">
              Configurazione applicata.
              {moves && (
                <>
                  {' '}
                  L'interfaccia è ora anche su <strong>https://{address}/travel/</strong>. Il
                  vecchio indirizzo <strong>{current}</strong> resta attivo finché non lo
                  rimuovi dalla schermata: verifica prima di raggiungere il nuovo.
                </>
              )}
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
