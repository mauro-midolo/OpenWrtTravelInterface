import { useState } from 'preact/hooks';
import { UbusError } from '../lib/ubus';
import { usePoll } from '../lib/poll';
import { useApply } from '../lib/apply';
import { WireGuardCard } from './WireGuard';
import {
  allNodes,
  blockReason,
  blocked,
  exitNodeLabel,
  exitNodeValue,
  exitNodes,
  getVpn,
  killSwitchHasTunnel,
  minutesLeft,
  resumeKillSwitch,
  saveTailscale,
  stageKillSwitch,
  suspendKillSwitch,
  tsAuthenticated,
  tsDown,
  tsLogin,
  tsLogout,
  tsStateLabel,
  tsUp,
} from '../lib/vpn';
import type { TailNode, VpnState } from '../lib/vpn';
import { getWg } from '../lib/vpn';
import { safeHttpUrl } from '../lib/portal';
import type { WgState } from '../lib/vpn';
import { ApplyStatus } from '../components/ApplyStatus';

/** Per quanto si apre il varco per il login a un portale. */
const SUSPEND_MINUTES = 10;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div class="row">
      <span class="row__label">{label}</span>
      <span class="row__value">{value}</span>
    </div>
  );
}

/**
 * Un dispositivo del tailnet.
 *
 * Il pallino e' l'unico modo compatto di dire "c'e' / non c'e'" in un elenco
 * che puo' essere lungo, ma da solo non basta: chi non distingue i colori
 * vedrebbe due cerchi uguali, quindi lo stato e' scritto anche a parole
 * nell'etichetta di accessibilita'.
 *
 * Chi e' in linea lo dice il coordinamento di Tailscale, che lo sa gia': da qui
 * non parte nessun ping.
 */
function Node({ node }: { node: TailNode }) {
  return (
    <div class="node">
      <span
        class={node.online ? 'dot dot--on' : 'dot'}
        role="img"
        aria-label={node.online ? 'in linea' : 'non in linea'}
      />
      <span class="node__name">{node.short}</span>
      {node.exit && <span class="badge">uscita</span>}
      <span class="node__ip">{node.ip || '—'}</span>
    </div>
  );
}

/**
 * La catena che fa funzionare l'exit node, un anello per riga.
 *
 * Esiste perche' dall'esterno ogni anello rotto ha lo stesso sintomo - il
 * telefono sceglie il router e non passa niente - e senza questa lista si va
 * a tentativi. L'ordine e' quello del pacchetto: entra dal tunnel, il kernel
 * lo inoltra, il firewall lo lascia passare, il tailnet ci ha autorizzati a
 * riceverlo. Ogni riga dice cosa fare quando manca, perche' i rimedi sono
 * quattro diversi.
 */
function ExitChecklist({ ts }: { ts: VpnState['tailscale'] }) {
  const check = ts.exit_check;
  if (!check) return null;

  const steps: Array<{ ok: boolean; label: string; fix: string }> = [
    {
      ok: check.iface_present,
      label: 'Interfaccia del tunnel (tailscale0)',
      fix: 'Non c’è: tailscaled non l’ha creata. Riprova l’accesso.',
    },
    {
      ok: ts.ip_forward !== false,
      label: 'Inoltro IP del kernel',
      fix: `Spento${ts.ip_forward_raw ? ` (vale "${ts.ip_forward_raw}")` : ''}. Da SSH: sh /usr/share/travel/vpn-setup.sh forwarding`,
    },
    {
      ok: check.iface_forward,
      label: 'Inoltro sull’interfaccia del tunnel',
      fix: 'Spento su tailscale0: è quello che conta, perché il pacchetto entra da lì. Salva di nuovo le impostazioni Tailscale — lo riscrive.',
    },
    {
      ok: check.fw_out,
      label: 'Inoltro del firewall verso la WAN',
      fix: 'La sezione travel_vpn_out è spenta. Salva di nuovo le impostazioni Tailscale con l’annuncio attivo.',
    },
    {
      ok: check.fw_loaded,
      label: 'Regole fw4 caricate per tailscale0',
      fix: 'Il firewall in esecuzione non conosce il tunnel. Da SSH: /etc/init.d/firewall reload',
    },
    {
      ok: check.route_present,
      label: 'Rotta verso il tailnet (100.64.0.0/10 via tailscale0)',
      fix: 'Manca: senza, il router non raggiunge nessun peer e le risposte non hanno da dove rientrare nel tunnel. Salva di nuovo le impostazioni Tailscale, o da SSH: sh /usr/share/travel/vpn-setup.sh runtime',
    },
    {
      ok: check.route_rule,
      label: 'Risposte instradate nel tunnel (sopra mwan3)',
      fix: 'Manca la regola di instradamento: mwan3 manda le risposte ai nodi del tailnet fuori dalla WAN. Salva di nuovo le impostazioni Tailscale, o da SSH: sh /usr/share/travel/vpn-setup.sh runtime',
    },
    {
      ok: ts.self_exit_node,
      label: 'Autorizzato dal tailnet',
      fix: 'Va approvato dalla console di Tailscale, fra le rotte del nodo.',
    },
  ];

  // Con il tunnel WireGuard su, chi ci usa come uscita non esce piu' dalla WAN
  // ma da li' dentro: l'indirizzo che vede Internet diventa quello del
  // fornitore VPN. Sono tre anelli in piu', e compaiono solo quando il tunnel
  // c'e' - senza, sarebbero tre righe rosse per una cosa che nessuno ha chiesto.
  if (check.wg_up) {
    steps.push(
      {
        ok: check.wg_fw,
        label: 'Uscita del tailnet dentro WireGuard',
        fix: 'La sezione travel_vpn_wg è spenta: il pacchetto viene instradato nel tunnel e lì il firewall lo rifiuta, perché i due tunnel stanno nella stessa zona. Salva di nuovo le impostazioni Tailscale con l’annuncio attivo.',
      },
      {
        ok: check.wg_fw_loaded,
        label: 'Regola fw4 caricata (travel-exit-via-wg)',
        fix: 'Scritta in uci ma assente dal firewall in esecuzione. Da SSH: /etc/init.d/firewall reload, e se non compare nemmeno così è fw4 che scarta la regola — allora serve un’altra strada.',
      },
      {
        ok: check.wg_route_rule,
        label: 'Traffico instradato in WireGuard (pref 901)',
        fix: 'Manca la regola: il traffico esce lo stesso, ma dalla WAN — l’indirizzo finale sarebbe quello di qui, non quello della VPN. Da SSH: sh /usr/share/travel/vpn-setup.sh runtime',
      },
    );
  }

  const broken = steps.filter((s) => !s.ok);

  return (
    <>
      <h2>Uscita per gli altri</h2>

      {/* La lista compare solo quando c'e' un anello rotto.
          Tutta verde non dice niente che la riga qui sotto non dica meglio:
          e' una diagnosi, e una diagnosi si legge quando qualcosa non va. Otto
          righe di conferma su una schermata di telefono spingono in basso i
          comandi veri per ripetere che va tutto bene. */}
      {broken.length > 0 &&
        steps.map((step) => (
          <div key={step.label} class="node">
            <span
              class={step.ok ? 'dot dot--on' : 'dot'}
              role="img"
              aria-label={step.ok ? 'a posto' : 'manca'}
            />
            <span class="node__name">{step.label}</span>
          </div>
        ))}

      {broken.length === 0 ? (
        <>
          <p class="alert alert--ok">
            Tutta la catena è a posto: dal telefono il router deve comparire fra le uscite.
            {check.wg_up &&
              ' Il traffico esce dentro WireGuard: l’indirizzo che vede Internet è quello del tunnel, non quello di questa rete.'}
          </p>
          {/* Il buco va detto proprio qui, dove qualcuno ha appena letto che
              va tutto bene: il kill switch guarda i client della LAN, non chi
              arriva dal tailnet. */}
          {check.wg_up && (
            <p class="muted">
              Se il tunnel WireGuard cade, chi ti usa come uscita torna a uscire da questa
              rete in chiaro: il kill switch ferma i dispositivi collegati al router, non
              quelli che arrivano dal tailnet.
            </p>
          )}
        </>
      ) : (
        <p class="alert alert--warn">
          {broken.length === 1 ? 'Manca un anello' : `Mancano ${broken.length} anelli`}:{' '}
          {broken.map((s) => `${s.label} — ${s.fix}`).join(' · ')}
        </p>
      )}
    </>
  );
}

/**
 * Accesso a Tailscale.
 *
 * Due strade, perche' sul telefono non si equivalgono. Quella normale e' il
 * link: lo tocchi, ti autentichi dove sei gia' loggato, torni indietro - niente
 * da copiare. L'auth key serve a chi ce l'ha gia' o a chi non vuole aprire il
 * browser sul sito di Tailscale, ed e' un segreto: si scrive e non si rilegge.
 */
function Login({ vpn, onDone }: { vpn: VpnState; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withKey, setWithKey] = useState(false);
  const [authkey, setAuthkey] = useState('');
  const [url, setUrl] = useState('');

  // Quello appena ottenuto vince su quello dello stato finche' il polling non
  // ricicla: altrimenti il link sfarfallerebbe appena premuto il pulsante.
  // Anche questo finisce in un link: passa dallo stesso filtro dei portali,
  // perche' un indirizzo che non e' http(s) in un `href` e' codice eseguito.
  const authUrl = safeHttpUrl(url || vpn.tailscale.auth_url);

  const go = async (key: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await tsLogin(key);
      setUrl(result.auth_url);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {authUrl && (
        <>
          <p class="alert alert--info">
            Apri questa pagina e autorizza il router. Quando hai finito torna qui: lo stato
            cambia da solo.
          </p>
          {/* Un link vero: l'accesso avviene nel browser di chi guarda, con la
              sua sessione Tailscale. Il router non puo' farlo al posto suo. */}
          <a class="button button--primary" href={authUrl} target="_blank" rel="noreferrer">
            Autorizza il router
          </a>
        </>
      )}

      {!authUrl && (
        <div class="radio__actions">
          <button
            class="button button--primary"
            disabled={busy}
            onClick={() => void go('')}
          >
            {busy ? 'Avvio…' : 'Accedi'}
          </button>
          <button class="button button--ghost" onClick={() => setWithKey(!withKey)}>
            {withKey ? 'Annulla' : 'Ho una auth key'}
          </button>
        </div>
      )}

      {withKey && !authUrl && (
        <label class="field">
          <span>Auth key</span>
          <input
            type="password"
            value={authkey}
            placeholder="tskey-auth-…"
            autocapitalize="none"
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => setAuthkey((e.target as HTMLInputElement).value)}
          />
          <span class="muted">
            La generi dalla console di Tailscale. Viene usata una volta e non viene salvata
            né riletta: come la password del WiFi, esce dal browser e non torna più indietro.
          </span>
          <button
            class="button button--primary"
            disabled={busy || authkey.trim() === ''}
            onClick={() => void go(authkey.trim())}
          >
            {busy ? 'Collego…' : 'Collega con la chiave'}
          </button>
        </label>
      )}

      {busy && !authUrl && (
        <p class="muted">
          Avvio il servizio e chiedo l'indirizzo di autorizzazione: può richiedere una
          ventina di secondi.
        </p>
      )}

      {error && <p class="alert alert--error alert--code">{error}</p>}
    </>
  );
}

/**
 * Le impostazioni del tunnel.
 *
 * L'exit node si sceglie da un elenco e non si digita: i nomi nel tailnet sono
 * quelli che sono, e sbagliarne uno da' un tunnel che sembra su e non porta da
 * nessuna parte.
 */
function TailscaleSheet({ vpn, onClose }: { vpn: VpnState; onClose: (c: boolean) => void }) {
  const [exitNode, setExitNode] = useState(vpn.settings.exit_node);
  const [acceptRoutes, setAcceptRoutes] = useState(vpn.settings.accept_routes);
  const [acceptDns, setAcceptDns] = useState(vpn.settings.accept_dns);
  const [advertiseLan, setAdvertiseLan] = useState(vpn.settings.advertise_lan);
  const [advertiseExit, setAdvertiseExit] = useState(vpn.settings.advertise_exit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nodes = exitNodes(vpn);
  // Il router ha gia' deciso: qui si legge soltanto. Quando l'exit node e'
  // bloccato l'elenco resta visibile ma non si sceglie - nasconderlo farebbe
  // credere che il tailnet non ne abbia.
  const exitBlocked = blocked(vpn.policy, 'ts_exit');

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveTailscale({
        exit_node: exitNode,
        accept_routes: acceptRoutes,
        accept_dns: acceptDns,
        advertise_lan: advertiseLan,
        advertise_exit: advertiseExit,
      });
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>Impostazioni Tailscale</h2>

        {/* Un elenco e non dei chip: gli exit node possono essere parecchi, e
            in fila orizzontale finiscono fuori dallo schermo con i nomi
            tagliati a meta'. In colonna ci sta anche l'indirizzo, che e' cio'
            che distingue due nodi chiamati quasi uguale. */}
        {exitBlocked && (
          <p class="alert alert--info">
            L'exit node non è selezionabile: {blockReason(vpn.policy, 'ts_exit')}. Resta
            possibile scegliere <strong>Nessuno</strong>, che è come toglierlo.
          </p>
        )}

        <div class="field">
          <span>Exit node</span>
          <ul class="list list--flush">
            <li>
              <button class="net" type="button" onClick={() => setExitNode('')}>
                <span class="net__main">
                  <span class="net__ssid">Nessuno</span>
                  <span class="net__meta">il traffico esce dalla rete a cui sei collegato</span>
                </span>
                <span class="net__side">
                  {exitNode === '' && <span class="badge badge--ok">scelto</span>}
                </span>
              </button>
            </li>
            {nodes.map((node) => {
              const value = exitNodeValue(node);
              // Si confrontano tutte le forme: una configurazione scritta prima
              // di questa versione ha salvato il nome intero, e non deve
              // smettere di risultare selezionata.
              const chosen =
                exitNode === value || exitNode === node.name || exitNode === node.short;

              return (
                <li key={node.id}>
                  <button
                    class="net"
                    type="button"
                    disabled={exitBlocked}
                    onClick={() => setExitNode(value)}
                  >
                    <span class="net__main">
                      <span class="net__ssid">{node.short}</span>
                      <span class="net__meta">
                        {node.ip}
                        {node.online ? '' : ' · non in linea'}
                      </span>
                    </span>
                    <span class="net__side">
                      {chosen && <span class="badge badge--ok">scelto</span>}
                      <span
                        class={node.online ? 'dot dot--on' : 'dot'}
                        role="img"
                        aria-label={node.online ? 'in linea' : 'non in linea'}
                      />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <span class="muted">
            Con un exit node <strong>tutto</strong> il traffico dei client esce da quel nodo
            invece che dalla rete a cui sei collegato. È la modalità che rende utile il kill
            switch: senza, Tailscale serve solo a raggiungere i tuoi dispositivi.
            {exitBlocked &&
              ' Non è selezionabile adesso: al massimo una cosa alla volta può decidere da dove esce il traffico.'}
            {nodes.length === 0 &&
              ' Nel tuo tailnet non ce n’è nessuno: va abilitato sul nodo che vuoi usare, e poi autorizzato dalla console.'}
          </span>
        </div>

        {/* Il rovescio dell'exit node: non "esco da un'altra parte" ma "faccio
            uscire gli altri da qui". Sono indipendenti e possono stare accesi
            insieme. */}
        <label class="check">
          <input
            type="checkbox"
            checked={advertiseExit}
            onChange={(e) => setAdvertiseExit((e.target as HTMLInputElement).checked)}
          />
          <span>
            <strong>Offri questo router come exit node</strong>: gli altri tuoi dispositivi
            possono far uscire tutto il loro traffico da qui. In viaggio è il modo per avere
            un'uscita <em>vicina</em> — il telefono fuori dall'albergo passa dal router in
            camera invece che da casa, con la latenza di qui e non di mezz'Europa.
          </span>
        </label>

        {advertiseExit && (
          <p class="alert alert--info">
            Va <strong>autorizzato dalla console di Tailscale</strong>: finché non lo
            approvi, il router si annuncia e nessuno lo vede fra le uscite disponibili. È il
            passaggio che salta sempre.
          </p>
        )}

        {advertiseExit && (
          <p class="muted">
            Il traffico degli altri nodi esce sulla rete a cui è collegato il router: li
            protegge dalla rete in cui si trovano <em>loro</em>, non dall'albergo dove sei
            tu. Se non ti fidi della rete d'albergo, quello che serve è un exit node altrove
            — le due cose si accendono insieme senza darsi fastidio.
          </p>
        )}

        <label class="check">
          <input
            type="checkbox"
            checked={acceptRoutes}
            onChange={(e) => setAcceptRoutes((e.target as HTMLInputElement).checked)}
          />
          <span>
            <strong>Accetta le rotte annunciate</strong> dagli altri nodi: serve per
            raggiungere la rete di casa, non solo i dispositivi con Tailscale installato.
          </span>
        </label>

        <label class="check">
          <input
            type="checkbox"
            checked={acceptDns}
            onChange={(e) => setAcceptDns((e.target as HTMLInputElement).checked)}
          />
          <span>
            <strong>Usa il DNS del tailnet</strong> (MagicDNS). Comodo per chiamare i tuoi
            dispositivi per nome; cambia però il resolver del router, quindi se la
            risoluzione dei nomi smette di funzionare è il primo posto dove guardare.
          </span>
        </label>

        <label class="check">
          <input
            type="checkbox"
            checked={advertiseLan}
            onChange={(e) => setAdvertiseLan((e.target as HTMLInputElement).checked)}
          />
          <span>
            <strong>Annuncia la LAN del router</strong>
            {/* Entrambe le famiglie, se ci sono: sapere che cosa viene
                annunciato e' la meta' del motivo per cui questa riga esiste,
                e con IPv6 le sottoreti sono due. */}
            {[vpn.settings.lan_cidr, vpn.settings.lan_cidr6].filter(Boolean).length > 0
              ? ` (${[vpn.settings.lan_cidr, vpn.settings.lan_cidr6].filter(Boolean).join(', ')})`
              : ''}
            : gli altri nodi possono raggiungere i dispositivi collegati qui. Va poi
            approvata dalla console di Tailscale, altrimenti resta annunciata e
            inutilizzata.
          </span>
        </label>

        {error && <p class="alert alert--error alert--code">{error}</p>}

        <div class="sheet__actions">
          <button class="button button--ghost" disabled={busy} onClick={() => onClose(false)}>
            Annulla
          </button>
          <button class="button button--primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Applico…' : 'Salva'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Accensione e spegnimento del kill switch.
 *
 * Passa da applica-e-conferma perche' tocca il firewall - e' uno dei casi che
 * la decisione D5 elenca per nome. In pratica non puo' chiudere fuori nessuno,
 * perche' il traffico verso il router non viene toccato, ma la regola sta
 * dov'e' proprio per non doverlo verificare a mano ogni volta.
 */
function KillSwitchSheet({
  on,
  onClose,
}: {
  on: boolean;
  onClose: (changed: boolean) => void;
}) {
  const apply = useApply();
  const [done, setDone] = useState(false);

  const go = async () => {
    if (await apply.run(() => stageKillSwitch(on))) setDone(true);
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{on ? 'Accendi il kill switch' : 'Spegni il kill switch'}</h2>

        {apply.phase === 'idle' && (
          <>
            <p class="alert alert--warn">
              {on
                ? 'Da adesso i dispositivi collegati al router escono su Internet solo dentro il tunnel. Se il tunnel cade non passa più niente, ed è il punto: meglio senza rete che in chiaro su una rete d’albergo.'
                : 'I dispositivi torneranno a uscire direttamente sulla rete a cui sei collegato, tunnel o non tunnel.'}
            </p>
            <p class="muted">
              L'accesso al router non viene toccato: questa schermata resta raggiungibile in
              ogni caso.
            </p>
            <div class="sheet__actions">
              <button class="button button--ghost" onClick={() => onClose(false)}>
                Annulla
              </button>
              <button class="button button--primary" onClick={() => void go()}>
                Procedi
              </button>
            </div>
          </>
        )}

        <ApplyStatus apply={apply} onClose={() => onClose(true)} />

        {done && (
          <>
            <p class="alert alert--ok">Fatto.</p>
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

export function Vpn({ onLogout }: { onLogout: () => void }) {
  // Leggere lo stato costa un `tailscale status`: quattro secondi bastano a far
  // sembrare vivo il login interattivo senza pesare, e il timer si ferma da solo
  // quando la scheda non e' visibile.
  const poll = usePoll<VpnState>(() => getVpn(), 4000);
  // WireGuard ha una lettura sua: `wg show` costa poco e cambia lentamente.
  // Tenerla separata da quella di Tailscale evita che una risposta lenta di uno
  // faccia sparire l'altro dallo schermo.
  const wgPoll = usePoll<WgState>(() => getWg(), 6000);
  const [editing, setEditing] = useState(false);
  const [killSwitch, setKillSwitch] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (poll.error instanceof UbusError && poll.error.isAuthError) {
    onLogout();
  }

  const vpn = poll.data;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      poll.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!vpn) {
    return (
      <main class="screen">
        <header class="topbar">
          <h1>VPN</h1>
        </header>
        {poll.loading ? (
          <p class="muted">Caricamento…</p>
        ) : (
          <section class="card">
            <p class="muted">Il router non ha risposto.</p>
            {poll.error && <p class="alert alert--warn alert--code">{poll.error.message}</p>}
          </section>
        )}
      </main>
    );
  }

  const ts = vpn.tailscale;
  // L'account c'e' gia': quello che manca e' riaccendere, non accedere. Fa
  // eccezione l'attesa di approvazione, dove non c'e' niente da premere perche'
  // la cosa che manca la deve fare un amministratore, altrove.
  const authed = tsAuthenticated(ts) && ts.state !== 'NeedsMachineAuth';
  const ks = vpn.killswitch;
  const suspended = ks.on && !ks.blocking;
  const left = minutesLeft(ks.resume_at);
  // I tunnel sono due e il kill switch dipende da tutti e due: guardarne uno
  // solo faceva comparire "non c'è nessun tunnel" sopra un WireGuard che stava
  // portando il traffico. Finché la risposta su WireGuard non è arrivata non si
  // sa abbastanza per accusare nessuno, e si tace.
  const protecting = killSwitchHasTunnel(vpn, wgPoll.data);
  const knowTunnels = wgPoll.data != null;

  return (
    <main class="screen">
      <header class="topbar">
        <h1>VPN</h1>
        <button class="button button--ghost" onClick={poll.refresh}>
          Aggiorna
        </button>
      </header>

      <section class={`card uplink uplink--${ts.state === 'Running' ? 'addressed' : 'no-address'}`}>
        <header class="radio__head">
          <div>
            <h2 class="uplink__title">Tailscale</h2>
            <p class="muted">
              {!ts.installed ? 'non installato' : tsStateLabel(ts.state)}
              {ts.self_short ? ` · ${ts.self_short}` : ''}
            </p>
          </div>
          {ts.state === 'Running' && ts.exit_node_id !== '' && (
            <span class="badge badge--ok">esce dal tunnel</span>
          )}
          {ts.state === 'Running' && ts.self_exit_node && (
            <span class="badge badge--ok">uscita per gli altri</span>
          )}
        </header>

        {!ts.installed && (
          <p class="alert alert--warn">
            Il pacchetto <code>tailscale</code> non è sul router. Si installa da solo al
            prossimo deploy fatto con Internet funzionante — oppure a mano, con{' '}
            <code>apk add tailscale</code>.
          </p>
        )}

        {/* Giu' ma non fuori: l'account c'e' ancora, il tunnel no. Qui non si
            offre un accesso - non c'e' niente da fare di nuovo - si dice che
            manca solo riaccendere, e l'interruttore sta con gli altri comandi
            in fondo alla scheda, dove sta anche quello di WireGuard. */}
        {ts.installed && ts.state !== 'Running' && authed && (
          <p class="muted">
            L'accesso {ts.self_short ? <>a nome <strong>{ts.self_short}</strong></> : ''} è
            ancora valido: il tunnel è soltanto staccato. Con <strong>Accendi</strong> torna
            su senza rifare il login.
          </p>
        )}

        {ts.installed && ts.state !== 'Running' && !authed && (
          <Login vpn={vpn} onDone={poll.refresh} />
        )}

        {ts.installed && ts.state === 'NeedsMachineAuth' && (
          <p class="alert alert--warn">
            Il nodo è registrato ma aspetta l'approvazione di un amministratore del tailnet:
            va autorizzato dalla console di Tailscale.
          </p>
        )}

        {ts.state === 'Running' && (
          <>
            <Row label="Nome nel tailnet" value={ts.self_short || '—'} />
            <Row label="Indirizzo" value={ts.self_ip || '—'} />
            <Row
              label="Exit node"
              value={
                vpn.settings.exit_node
                  ? `${exitNodeLabel(vpn)}${ts.exit_node_id ? '' : ' · non attivo'}`
                  : 'nessuno'
              }
            />
            <Row
              label="Offerto come uscita"
              value={
                !vpn.settings.advertise_exit
                  ? 'no'
                  : ts.self_exit_node
                    ? 'sì, autorizzato'
                    : 'sì, da autorizzare'
              }
            />
            <Row label="Versione" value={ts.version || '—'} />

            {/* Annunciato ma non ancora visibile agli altri: e' quasi sempre
                l'approvazione che manca, ed e' il passaggio che non sta nel
                router e quindi non si puo' fare da qui. */}
            {vpn.settings.advertise_exit && !ts.self_exit_node && (
              <p class="alert alert--warn">
                Il router si annuncia come exit node ma il tailnet non lo offre ancora agli
                altri dispositivi: va <strong>approvato dalla console di Tailscale</strong>,
                fra le rotte del nodo. Finché non lo fai, dal telefono non comparirà fra le
                uscite disponibili.
              </p>
            )}

            {/* La catena che fa funzionare l'exit node, un anello per riga.
                Compare solo se il router la sa raccontare: un campo assente
                vale "non lo so", non "è rotto" - un avviso rosso su una misura
                mancante è già successo qui una volta. */}
            {vpn.settings.advertise_exit && ts.exit_check && (
              <ExitChecklist ts={ts} />
            )}

            {!ts.boot && (
              <p class="alert alert--warn">
                Il servizio non è abilitato all'avvio: dopo un riavvio del router la VPN non
                torna su da sola. Rifai l'accesso da qui per rimetterlo a posto.
              </p>
            )}
            {vpn.settings.exit_node !== '' && ts.exit_node_id === '' && (
              <p class="alert alert--warn">
                L'exit node <strong>{exitNodeLabel(vpn)}</strong> è impostato ma non è in
                uso: di solito è spento, oppure non è più autorizzato come uscita dalla
                console di Tailscale.
              </p>
            )}
          </>
        )}

        {ts.installed && (
          <div class="radio__actions">
            <button class="button button--ghost" onClick={() => setEditing(true)}>
              Impostazioni
            </button>
            {ts.state === 'Running' && (
              <button class="button button--ghost" disabled={busy} onClick={() => void run(tsDown)}>
                Disconnetti
              </button>
            )}
            {/* La coppia accendi/spegni di WireGuard, con le stesse parole: da
                qui in poi Tailscale e' un interruttore, non una procedura. In
                avvio resta visibile ma spento - premerlo di nuovo non
                aggiungerebbe niente a quello che sta gia' succedendo. */}
            {ts.state !== 'Running' && authed && (
              <button
                class="button button--primary"
                disabled={busy || ts.state === 'Starting'}
                onClick={() => void run(tsUp)}
              >
                {busy ? 'Accendo…' : 'Accendi'}
              </button>
            )}
            {ts.installed && ts.state !== 'NoState' && (
              <button class="button button--ghost" disabled={busy} onClick={() => void run(tsLogout)}>
                Esci dall'account
              </button>
            )}
          </div>
        )}

        {/* I dispositivi del tailnet, in fondo alla scheda: sono la meta' del
            motivo per cui Tailscale sta su un router da viaggio - sapere se il
            NAS di casa si raggiunge da qui. Chi c'e' viene prima, perche' un
            nodo spento in mezzo agli altri si fa cercare. */}
        {ts.state === 'Running' && (
          <>
            <h2>Dispositivi</h2>
            {allNodes(vpn).length === 0 ? (
              <p class="muted">
                Nessun altro dispositivo nel tailnet. Installa Tailscale su un telefono o su un
                computer e comparirà qui.
              </p>
            ) : (
              allNodes(vpn).map((node) => <Node key={node.id} node={node} />)
            )}
          </>
        )}

        {error && <p class="alert alert--error alert--code">{error}</p>}
      </section>

      {/* WireGuard accanto a Tailscale, non in una schermata sua: sono due
          risposte alla stessa domanda - da dove esce il traffico - e vederle
          vicine è ciò che rende evidente perché non possono essere accese tutte
          e due. */}
      {wgPoll.data && (
        <WireGuardCard
          wg={wgPoll.data}
          onChanged={() => {
            wgPoll.refresh();
            poll.refresh();
          }}
        />
      )}

      <section class={`card uplink uplink--${ks.on ? (suspended ? 'no-address' : 'addressed') : 'unassociated'}`}>
        <header class="radio__head">
          <div>
            <h2 class="uplink__title">Kill switch</h2>
            <p class="muted">
              {!ks.on ? 'spento' : suspended ? `sospeso, si riarma fra ${left} min` : 'attivo'}
            </p>
          </div>
          {ks.on && !suspended && <span class="badge badge--ok">blocca</span>}
        </header>

        <p class="muted">
          Quando è acceso, i dispositivi collegati al router escono su Internet
          <strong> solo dentro il tunnel</strong>. Se il tunnel cade non passa più niente:
          è il modo per non ritrovarsi in chiaro sulla rete di un albergo senza accorgersene.
          Il router resta raggiungibile in ogni caso.
        </p>

        {!ks.ready && (
          <p class="alert alert--warn">
            La regola di firewall non c'è: rilancia il deploy, che la crea. Finché manca,
            l'interruttore qui sotto non avrebbe niente da accendere.
          </p>
        )}

        {/* Il caso che rende un kill switch peggio che inutile: acceso, e con
            niente da proteggere. Con Tailscale senza exit node il traffico
            normale non passa dal tunnel, quindi bloccare la WAN non protegge -
            toglie Internet e basta. Vale se non porta il traffico *nessuno* dei
            due: WireGuard da solo basta e avanza, e dirgli di no mentre lavora
            è il modo più rapido di insegnare a ignorare gli avvisi. */}
        {ks.on && knowTunnels && !protecting && (
          <p class="alert alert--warn">
            Attenzione: <strong>non c'è nessun tunnel che porti il traffico</strong>. Senza
            un exit node, Tailscale serve a raggiungere i tuoi dispositivi e il traffico
            normale esce comunque dalla WAN — che adesso è bloccata. Il risultato è che i
            client non hanno Internet e non stanno guadagnando nessuna protezione.
            {ts.state === 'Running'
              ? ' Scegli un exit node dalle impostazioni qui sopra, oppure accendi WireGuard.'
              : ' Collega Tailscale con un exit node, oppure accendi WireGuard.'}
          </p>
        )}

        {suspended && (
          <p class="alert alert--warn">
            Sospeso per il login a un portale: il traffico esce in chiaro. Si riarma da solo
            fra <strong>{left} min</strong>, e il router lo rimette a posto anche se chiudi
            questa pagina.
          </p>
        )}

        <div class="radio__actions">
          <button
            class="button button--ghost"
            disabled={!ks.ready}
            onClick={() => setKillSwitch(!ks.on)}
          >
            {ks.on ? 'Spegni' : 'Accendi'}
          </button>

          {ks.on && !suspended && (
            <button
              class="button button--ghost"
              disabled={busy}
              onClick={() => void run(() => suspendKillSwitch(SUSPEND_MINUTES))}
            >
              Sospendi {SUSPEND_MINUTES} min
            </button>
          )}

          {suspended && (
            <button class="button button--ghost" disabled={busy} onClick={() => void run(resumeKillSwitch)}>
              Riarma adesso
            </button>
          )}
        </div>

        {ks.on && !suspended && (
          <p class="muted">
            La sospensione serve per il login a un captive portal, che attraverso un kill
            switch non si può fare: la pagina non si carica. Apre davvero, per il tempo
            dichiarato, e poi si richiude da sola.
          </p>
        )}
      </section>

      {editing && (
        <TailscaleSheet
          vpn={vpn}
          onClose={(changed) => {
            setEditing(false);
            if (changed) poll.refresh();
          }}
        />
      )}

      {killSwitch !== null && (
        <KillSwitchSheet
          on={killSwitch}
          onClose={(changed) => {
            setKillSwitch(null);
            if (changed) poll.refresh();
          }}
        />
      )}
    </main>
  );
}
