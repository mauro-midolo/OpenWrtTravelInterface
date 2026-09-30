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
import { commonText } from '../i18n/common';
import { vpnText } from '../i18n/vpn';

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
  const t = vpnText();
  return (
    <div class="node">
      <span
        class={node.online ? 'dot dot--on' : 'dot'}
        role="img"
        aria-label={node.online ? t.online : t.offline}
      />
      <span class="node__name">{node.short}</span>
      {node.exit && <span class="badge">{t.exitBadge}</span>}
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
  const t = vpnText().check;

  const steps: Array<{ ok: boolean; label: string; fix: string }> = [
    {
      ok: check.iface_present,
      label: t.iface,
      fix: t.ifaceFix,
    },
    {
      ok: ts.ip_forward !== false,
      label: t.forward,
      fix: t.forwardFix(ts.ip_forward_raw ?? ''),
    },
    {
      ok: check.iface_forward,
      label: t.ifaceForward,
      fix: t.ifaceForwardFix,
    },
    {
      ok: check.fw_out,
      label: t.fwOut,
      fix: t.fwOutFix,
    },
    {
      ok: check.fw_loaded,
      label: t.fwLoaded,
      fix: t.fwLoadedFix,
    },
    {
      ok: check.route_present,
      label: t.route,
      fix: t.routeFix,
    },
    {
      ok: check.route_rule,
      label: t.routeRule,
      fix: t.routeRuleFix,
    },
    {
      ok: ts.self_exit_node,
      label: t.approved,
      fix: t.approvedFix,
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
        label: t.wgFw,
        fix: t.wgFwFix,
      },
      {
        ok: check.wg_fw_loaded,
        label: t.wgFwLoaded,
        fix: t.wgFwLoadedFix,
      },
      {
        ok: check.wg_route_rule,
        label: t.wgRule,
        fix: t.wgRuleFix,
      },
    );
  }

  const broken = steps.filter((s) => !s.ok);

  return (
    <>
      <h2>{t.title}</h2>

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
              aria-label={step.ok ? t.ok : t.missing}
            />
            <span class="node__name">{step.label}</span>
          </div>
        ))}

      {broken.length === 0 ? (
        <>
          <p class="alert alert--ok">{t.working(check.wg_up === true)}</p>
          {/* Il buco va detto proprio qui, dove qualcuno ha appena letto che
              va tutto bene: il kill switch guarda i client della LAN, non chi
              arriva dal tailnet. */}
          {check.wg_up && (
            <p class="muted">{t.wgDrops}</p>
          )}
        </>
      ) : (
        <p class="alert alert--warn">
          {t.broken(broken.length)}:{' '}
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
  const t = vpnText();
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
          {/* Un link vero: l'accesso avviene nel browser di chi guarda, con la
              sua sessione Tailscale. Il router non puo' farlo al posto suo. */}
          <a class="button button--primary" href={authUrl} target="_blank" rel="noreferrer">
            {t.authorize}
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
            {busy ? t.starting : t.signIn}
          </button>
          <button class="button button--ghost" onClick={() => setWithKey(!withKey)}>
            {withKey ? commonText().actions.cancel : t.haveKey}
          </button>
        </div>
      )}

      {withKey && !authUrl && (
        <label class="field">
          <span>{t.authKey}</span>
          <input
            type="password"
            value={authkey}
            placeholder="tskey-auth-…"
            autocapitalize="none"
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => setAuthkey((e.target as HTMLInputElement).value)}
          />
          <button
            class="button button--primary"
            disabled={busy || authkey.trim() === ''}
            onClick={() => void go(authkey.trim())}
          >
            {busy ? t.linking : t.linkWithKey}
          </button>
        </label>
      )}

      {busy && !authUrl && (
        <p class="muted">{t.startingTs}</p>
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
  const t = vpnText();
  const actions = commonText().actions;
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
        <h2>{t.settingsTitle}</h2>

        {/* Un elenco e non dei chip: gli exit node possono essere parecchi, e
            in fila orizzontale finiscono fuori dallo schermo con i nomi
            tagliati a meta'. In colonna ci sta anche l'indirizzo, che e' cio'
            che distingue due nodi chiamati quasi uguale. */}
        {exitBlocked && (
          <p class="alert alert--info">{t.exitBlocked(blockReason(vpn.policy, 'ts_exit'))}</p>
        )}

        <div class="field">
          <span>{t.exitNode}</span>
          <ul class="list list--flush">
            <li>
              <button class="net" type="button" onClick={() => setExitNode('')}>
                <span class="net__main">
                  <span class="net__ssid">{t.none}</span>
                </span>
                <span class="net__side">
                  {exitNode === '' && <span class="badge badge--ok">{t.chosen}</span>}
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
                        {node.online ? '' : t.offlineSuffix}
                      </span>
                    </span>
                    <span class="net__side">
                      {chosen && <span class="badge badge--ok">{t.chosen}</span>}
                      <span
                        class={node.online ? 'dot dot--on' : 'dot'}
                        role="img"
                        aria-label={node.online ? t.online : t.offline}
                      />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {nodes.length === 0 && (
            <span class="muted">{t.noExitNodes}</span>
          )}
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
          <span>{t.offerExit}</span>
        </label>

        {advertiseExit && (
          <p class="alert alert--info">{t.approveInConsole}</p>
        )}

        <label class="check">
          <input
            type="checkbox"
            checked={acceptRoutes}
            onChange={(e) => setAcceptRoutes((e.target as HTMLInputElement).checked)}
          />
          <span>{t.acceptRoutes}</span>
        </label>

        <label class="check">
          <input
            type="checkbox"
            checked={acceptDns}
            onChange={(e) => setAcceptDns((e.target as HTMLInputElement).checked)}
          />
          <span>{t.acceptDns}</span>
        </label>

        <label class="check">
          <input
            type="checkbox"
            checked={advertiseLan}
            onChange={(e) => setAdvertiseLan((e.target as HTMLInputElement).checked)}
          />
          <span>
            {t.advertiseLan}
            {/* Entrambe le famiglie, se ci sono: sapere che cosa viene
                annunciato e' la meta' del motivo per cui questa riga esiste,
                e con IPv6 le sottoreti sono due. */}
            {[vpn.settings.lan_cidr, vpn.settings.lan_cidr6].filter(Boolean).length > 0
              ? ` (${[vpn.settings.lan_cidr, vpn.settings.lan_cidr6].filter(Boolean).join(', ')})`
              : ''}

          </span>
        </label>

        {error && <p class="alert alert--error alert--code">{error}</p>}

        <div class="sheet__actions">
          <button class="button button--ghost" disabled={busy} onClick={() => onClose(false)}>
            {actions.cancel}
          </button>
          <button class="button button--primary" disabled={busy} onClick={() => void save()}>
            {busy ? t.applying : actions.save}
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
  const t = vpnText();
  const actions = commonText().actions;
  const apply = useApply();
  const [done, setDone] = useState(false);

  const go = async () => {
    if (await apply.run(() => stageKillSwitch(on))) setDone(true);
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{on ? t.ksOnTitle : t.ksOffTitle}</h2>

        {apply.phase === 'idle' && (
          <>
            <p class="alert alert--warn">
              {on
                ? t.ksOnWarn
                : t.ksOffWarn}
            </p>
            <div class="sheet__actions">
              <button class="button button--ghost" onClick={() => onClose(false)}>
                {actions.cancel}
              </button>
              <button class="button button--primary" onClick={() => void go()}>
                {actions.proceed}
              </button>
            </div>
          </>
        )}

        <ApplyStatus apply={apply} onClose={() => onClose(true)} />

        {done && (
          <>
            <p class="alert alert--ok">{actions.done}</p>
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

export function Vpn({ onLogout }: { onLogout: () => void }) {
  const t = vpnText();
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
          <h1>{t.title}</h1>
        </header>
        {poll.loading ? (
          <p class="muted">{t.loading}</p>
        ) : (
          <section class="card">
            <p class="muted">{t.noAnswer}</p>
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
        <h1>{t.title}</h1>
        <button class="button button--ghost" onClick={poll.refresh}>
          {commonText().actions.refresh}
        </button>
      </header>

      <section class={`card uplink uplink--${ts.state === 'Running' ? 'addressed' : 'no-address'}`}>
        <header class="radio__head">
          <div>
            <h2 class="uplink__title">Tailscale</h2>
            <p class="muted">
              {!ts.installed ? t.notInstalled : tsStateLabel(ts.state)}
              {ts.self_short ? ` · ${ts.self_short}` : ''}
            </p>
          </div>
          {ts.state === 'Running' && ts.exit_node_id !== '' && (
            <span class="badge badge--ok">{t.viaTunnel}</span>
          )}
          {ts.state === 'Running' && ts.self_exit_node && (
            <span class="badge badge--ok">{t.exitForOthers}</span>
          )}
        </header>

        {!ts.installed && (
          <p class="alert alert--warn">{t.missingPackage}</p>
        )}

        {/* Giu' ma non fuori: l'account c'e' ancora, il tunnel no. Qui non si
            offre un accesso - non c'e' niente da fare di nuovo - si dice che
            manca solo riaccendere, e l'interruttore sta con gli altri comandi
            in fondo alla scheda, dove sta anche quello di WireGuard. */}
        {ts.installed && ts.state !== 'Running' && authed && (
          <p class="muted">{t.tunnelOff(ts.self_short)}</p>
        )}

        {ts.installed && ts.state !== 'Running' && !authed && (
          <Login vpn={vpn} onDone={poll.refresh} />
        )}

        {ts.installed && ts.state === 'NeedsMachineAuth' && (
          <p class="alert alert--warn">{t.needsMachineAuth}</p>
        )}

        {ts.state === 'Running' && (
          <>
            <Row label={t.tailnetName} value={ts.self_short || '—'} />
            <Row label={t.address} value={ts.self_ip || '—'} />
            <Row
              label={t.exitNode}
              value={
                vpn.settings.exit_node
                  ? `${exitNodeLabel(vpn)}${ts.exit_node_id ? '' : t.notActive}`
                  : t.noneLower
              }
            />
            <Row
              label={t.offered}
              value={
                !vpn.settings.advertise_exit
                  ? t.no
                  : ts.self_exit_node
                    ? t.yesApproved
                    : t.yesPending
              }
            />
            <Row label={t.version} value={ts.version || '—'} />

            {/* Annunciato ma non ancora visibile agli altri: e' quasi sempre
                l'approvazione che manca, ed e' il passaggio che non sta nel
                router e quindi non si puo' fare da qui. */}
            {vpn.settings.advertise_exit && !ts.self_exit_node && (
              <p class="alert alert--warn">{t.exitNeedsApproval}</p>
            )}

            {/* La catena che fa funzionare l'exit node, un anello per riga.
                Compare solo se il router la sa raccontare: un campo assente
                vale "non lo so", non "è rotto" - un avviso rosso su una misura
                mancante è già successo qui una volta. */}
            {vpn.settings.advertise_exit && ts.exit_check && (
              <ExitChecklist ts={ts} />
            )}

            {!ts.boot && (
              <p class="alert alert--warn">{t.noBoot}</p>
            )}
            {vpn.settings.exit_node !== '' && ts.exit_node_id === '' && (
              <p class="alert alert--warn">{t.exitUnused(exitNodeLabel(vpn))}</p>
            )}
          </>
        )}

        {ts.installed && (
          <div class="radio__actions">
            <button class="button button--ghost" onClick={() => setEditing(true)}>
              {t.settings}
            </button>
            {ts.state === 'Running' && (
              <button class="button button--ghost" disabled={busy} onClick={() => void run(tsDown)}>
                {t.disconnect}
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
                {busy ? t.turningOn : t.turnOn}
              </button>
            )}
            {ts.installed && ts.state !== 'NoState' && (
              <button class="button button--ghost" disabled={busy} onClick={() => void run(tsLogout)}>
                {t.signOut}
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
            <h2>{t.devices}</h2>
            {allNodes(vpn).length === 0 ? (
              <p class="muted">{t.noDevices}</p>
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
            <h2 class="uplink__title">{t.ks}</h2>
            <p class="muted">
              {!ks.on ? t.ksOff : suspended ? t.ksSuspended(left) : t.ksOn}
            </p>
          </div>
          {ks.on && !suspended && <span class="badge badge--ok">{t.ksBlocks}</span>}
        </header>

        {!ks.ready && (
          <p class="alert alert--warn">{t.ksMissing}</p>
        )}

        {/* Il caso che rende un kill switch peggio che inutile: acceso, e con
            niente da proteggere. Con Tailscale senza exit node il traffico
            normale non passa dal tunnel, quindi bloccare la WAN non protegge -
            toglie Internet e basta. Vale se non porta il traffico *nessuno* dei
            due: WireGuard da solo basta e avanza, e dirgli di no mentre lavora
            è il modo più rapido di insegnare a ignorare gli avvisi. */}
        {ks.on && knowTunnels && !protecting && (
          <p class="alert alert--warn">{t.ksNoTunnel}</p>
        )}

        {suspended && (
          <p class="alert alert--warn">{t.ksSuspendedWarn(left)}</p>
        )}

        <div class="radio__actions">
          <button
            class="button button--ghost"
            disabled={!ks.ready}
            onClick={() => setKillSwitch(!ks.on)}
          >
            {ks.on ? t.turnOff : t.turnOn}
          </button>

          {ks.on && !suspended && (
            <button
              class="button button--ghost"
              disabled={busy}
              onClick={() => void run(() => suspendKillSwitch(SUSPEND_MINUTES))}
            >
              {t.suspend(SUSPEND_MINUTES)}
            </button>
          )}

          {suspended && (
            <button class="button button--ghost" disabled={busy} onClick={() => void run(resumeKillSwitch)}>
              {t.resume}
            </button>
          )}
        </div>

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
