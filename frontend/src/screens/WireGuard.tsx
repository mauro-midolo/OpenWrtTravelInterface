import { useState } from 'preact/hooks';
import {
  blockReason,
  blocked,
  formatWgBytes,
  handshakeAge,
  wgAlive,
  wgCarrying,
  wgImport,
  wgRoutingSteps,
  wgToggle,
} from '../lib/vpn';
import type { WgState } from '../lib/vpn';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div class="row">
      <span class="row__label">{label}</span>
      <span class="row__value">{value}</span>
    </div>
  );
}

/**
 * Importazione di una configurazione WireGuard.
 *
 * Si incolla il file del provider così com'è. Non è una comodità: è il formato
 * in cui la configurazione viene consegnata, e l'unico modo per non far
 * ridigitare due chiavi base64 da 44 caratteri su un telefono, in piedi, con
 * una mano. A leggerlo è il router — la chiave privata non deve fare il giro
 * due volte, e la validazione deve stare dalla stessa parte del controllo.
 */
function ImportSheet({ onClose }: { onClose: (changed: boolean) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await wgImport(text);
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>Importa configurazione</h2>

        <label class="field">
          <span>Incolla il file .conf del provider</span>
          <textarea
            rows={10}
            value={text}
            placeholder={'[Interface]\nPrivateKey = …\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = …\nEndpoint = vpn.example.com:51820\nAllowedIPs = 0.0.0.0/0'}
            autocapitalize="none"
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          />
          <span class="muted">
            La chiave privata resta sul router: viene scritta e non riletta più, come la
            password del WiFi.
          </span>
        </label>

        <p class="alert alert--info">
          Il tunnel viene importato <strong>spento</strong>. Accenderlo è un passo a parte,
          così anche la prima accensione passa dai controlli di compatibilità.
        </p>

        {error && <p class="alert alert--error alert--code">{error}</p>}

        <div class="sheet__actions">
          <button class="button button--ghost" disabled={busy} onClick={() => onClose(false)}>
            Annulla
          </button>
          <button
            class="button button--primary"
            disabled={busy || text.trim() === ''}
            onClick={() => void go()}
          >
            {busy ? 'Importo…' : 'Importa'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Accensione e spegnimento del tunnel.
 *
 * **Niente applica-e-conferma**, per la stessa ragione già scritta per le
 * modifiche multi-WAN: questa cambia il routing dei *client*, non l'accesso al
 * router. La LAN, il suo indirizzo e le regole che fanno passare il traffico
 * verso l'interfaccia di gestione non vengono toccati, quindi non ci si può
 * chiudere fuori. Il rischio è restare senza Internet, non senza router.
 *
 * C'era, in una prima versione, ed era un errore di forma prima che di
 * sostanza: `useApply` vuole che il passo di preparazione lasci le modifiche
 * *in sospeso* nella sessione, mentre `wg_toggle` è un metodo che fa `uci
 * commit` da sé. Arrivati a `uci apply` non restava niente da applicare, e il
 * router rispondeva "nessun dato". Due schemi che non si mescolano: o si
 * preparano modifiche uci e le applica il browser, o si chiama un metodo che
 * fa tutto lui.
 */
function ToggleSheet({ on, onClose }: { on: boolean; onClose: (c: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await wgToggle(on);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{on ? 'Accendi WireGuard' : 'Spegni WireGuard'}</h2>

        {!done && (
          <>
            <p class="alert alert--warn">
              {on
                ? 'Da adesso tutto il traffico dei client esce dal tunnel. Se il tunnel non sale, senza kill switch il traffico torna a uscire dalla rete a cui sei collegato.'
                : 'Il traffico torna a uscire direttamente dalla rete a cui sei collegato.'}
            </p>
            <p class="muted">
              L'accesso al router non viene toccato: questa schermata resta raggiungibile in
              ogni caso.
            </p>

            {error && <p class="alert alert--error alert--code">{error}</p>}

            <div class="sheet__actions">
              <button class="button button--ghost" disabled={busy} onClick={() => onClose(false)}>
                {error ? 'Chiudi' : 'Annulla'}
              </button>
              <button class="button button--primary" disabled={busy} onClick={() => void go()}>
                {busy ? 'Applico…' : 'Procedi'}
              </button>
            </div>
          </>
        )}

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

/**
 * La scheda WireGuard.
 *
 * Sta accanto a Tailscale e non in una schermata sua: sono due risposte alla
 * stessa domanda - da dove esce il traffico - e vederle insieme è ciò che
 * rende evidente perché non possono essere accese tutte e due.
 */
export function WireGuardCard({
  wg,
  onChanged,
}: {
  wg: WgState;
  onChanged: () => void;
}) {
  const [importing, setImporting] = useState(false);
  const [toggling, setToggling] = useState<boolean | null>(null);

  const isBlocked = blocked(wg.policy, 'wireguard');
  const alive = wgAlive(wg.status);

  // Gli anelli fra "il tunnel è su" e "i client ci passano dentro", e il
  // giudizio che ne segue. Stanno in vpn.ts perché la stessa domanda la fa
  // anche il kill switch, che senza una risposta condivisa gridava al vuoto su
  // un tunnel perfettamente funzionante.
  const steps = wgRoutingSteps(wg);
  const broken = steps.filter((s) => !s.ok);
  const carrying = wgCarrying(wg);
  const tone = !wg.enabled ? 'unassociated' : carrying ? 'addressed' : 'no-address';

  return (
    <section class={`card uplink uplink--${tone}`}>
      <header class="radio__head">
        <div>
          <h2 class="uplink__title">WireGuard</h2>
          <p class="muted">
            {!wg.installed
              ? 'non installato'
              : !wg.configured
                ? 'nessun tunnel configurato'
                : !wg.enabled
                  ? 'configurato, spento'
                  : carrying
                    ? 'attivo'
                    : alive
                      ? 'acceso, ma il traffico non ci entra'
                      : 'acceso, ma il peer non risponde'}
            {wg.configured && wg.config.endpoint ? ` · ${wg.config.endpoint}` : ''}
          </p>
        </div>
        {carrying && <span class="badge badge--ok">porta il traffico</span>}
      </header>

      {!wg.installed && (
        <p class="alert alert--warn">
          Il pacchetto <code>wireguard-tools</code> non è sul router. Si installa da solo al
          prossimo deploy fatto con Internet funzionante.
        </p>
      )}

      {/* Il vincolo, detto prima che si provi. Il router lo rifiuterebbe
          comunque, ma scoprirlo dopo aver premuto è un giro a vuoto. */}
      {isBlocked && (
        <p class="alert alert--info">
          Non si può accendere WireGuard adesso: {blockReason(wg.policy, 'wireguard')}. Al
          massimo una cosa alla volta può decidere da dove esce il traffico.
        </p>
      )}

      {wg.configured && (
        <>
          <Row label="Endpoint" value={wg.config.endpoint ? `${wg.config.endpoint}:${wg.config.port}` : '—'} />
          <Row label="Indirizzi" value={wg.config.addresses || '—'} />
          <Row label="Instradato nel tunnel" value={wg.config.allowed_ips || '—'} />
          <Row label="Chiave privata" value={wg.config.has_private_key ? 'presente' : 'mancante'} />
          {wg.enabled && (
            <>
              <Row label="Ultimo handshake" value={handshakeAge(wg.status)} />
              <Row
                label="Traffico"
                value={`↓ ${formatWgBytes(wg.status.rx)}   ↑ ${formatWgBytes(wg.status.tx)}`}
              />
            </>
          )}

          {/* Handshake a posto ma traffico che non entra: è il guasto più
              ingannevole di tutti, perché la scheda direbbe "attivo" e i
              client uscirebbero lo stesso dalla WAN. Si mostra solo quando
              c'è qualcosa che non va: quando la catena è intera, non serve. */}
          {wg.enabled && wg.routing && broken.length > 0 && (
            <>
              <h2>Il traffico entra nel tunnel?</h2>
              {steps.map((step) => (
                <div key={step.label} class="node">
                  <span
                    class={step.ok ? 'dot dot--on' : 'dot'}
                    role="img"
                    aria-label={step.ok ? 'a posto' : 'manca'}
                  />
                  <span class="node__name">{step.label}</span>
                </div>
              ))}
              <p class="alert alert--warn">
                Il tunnel è su ma <strong>il traffico dei client non ci entra</strong>:{' '}
                {broken.map((s) => s.fix).join(' · ')}
              </p>
            </>
          )}

          {/* Acceso e senza handshake recente: il device è su, la
              configurazione sembra a posto, e non passa niente. È la stessa
              distinzione fra "collegato" e "funziona" che regge il resto
              dell'interfaccia. */}
          {wg.enabled && !alive && (
            <p class="alert alert--warn">
              Il tunnel è acceso ma <strong>l'ultimo handshake non è recente</strong>: il peer
              non sta rispondendo. Di solito è l'endpoint irraggiungibile dalla rete in cui
              ti trovi, oppure una chiave che non combacia.
            </p>
          )}
        </>
      )}

      <div class="radio__actions">
        <button class="button button--ghost" onClick={() => setImporting(true)}>
          {wg.configured ? 'Reimporta' : 'Importa configurazione'}
        </button>
        {wg.configured && (
          <button
            class="button button--ghost"
            disabled={!wg.installed || (!wg.enabled && isBlocked)}
            onClick={() => setToggling(!wg.enabled)}
          >
            {wg.enabled ? 'Spegni' : 'Accendi'}
          </button>
        )}
      </div>

      {importing && (
        <ImportSheet
          onClose={(changed) => {
            setImporting(false);
            if (changed) onChanged();
          }}
        />
      )}

      {toggling !== null && (
        <ToggleSheet
          on={toggling}
          onClose={(changed) => {
            setToggling(null);
            if (changed) onChanged();
          }}
        />
      )}
    </section>
  );
}
