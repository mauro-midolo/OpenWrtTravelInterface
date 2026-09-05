import { useState } from 'preact/hooks';
import {
  MODE_LABEL,
  applyMwan,
  byPriority,
  setDefaultRule,
  setEnabled,
  setHealth,
  setPriorityOrder,
  setWeight,
  statusLabel,
  addRule,
  deleteRule,
  parsePolicy,
  updateRule,
} from '../lib/mwan';
import type { Mwan, MwanInterface, MwanMode, MwanRule } from '../lib/mwan';
import { blockReason, blocked } from '../lib/vpn';
import { isValidIp } from '../lib/lan';

/**
 * Etichetta di una WAN.
 *
 * Per le porte si usa il nome fisico del device, non quello dell'interfaccia
 * logica: OpenWrt chiama le porte col loro ruolo di fabbrica (`wan`, `lan1`),
 * e dopo averle commutate quel nome direbbe il contrario di com'e' messa. Il
 * device invece resta lo stesso e identifica sempre la stessa presa.
 */
export function wanLabel(network: string, device?: string): string {
  if (network.endsWith('radio0')) return 'WiFi 2.4 GHz';
  if (network.endsWith('radio1')) return 'WiFi 5 GHz';
  if (network === 'wan_usb' || network.includes('usb')) return 'Tethering USB';
  return device ? `Porta ${device}` : network;
}

export function MwanCard({
  mwan,
  onEdit,
}: {
  mwan: Mwan | null;
  onEdit: () => void;
}) {
  if (!mwan) {
    return (
      <section class="card">
        <h2 class="uplink__title">Multi-WAN</h2>
        <p class="muted">Lettura in corso…</p>
      </section>
    );
  }

  if (!mwan.installed) {
    return (
      <section class="card">
        <h2 class="uplink__title">Multi-WAN non installato</h2>
        <p class="muted">
          mwan3 non c'è. Si installa da solo al prossimo <code>deploy</code> fatto con una
          connessione a Internet attiva: serve a scaricare il pacchetto.
        </p>
      </section>
    );
  }

  const ordered = byPriority(mwan);

  return (
    <section class={`card uplink uplink--${mwan.running ? 'addressed' : 'no-address'}`}>
      <header class="radio__head">
        <div>
          <h2 class="uplink__title">Multi-WAN · {MODE_LABEL[mwan.mode]}</h2>
          <p class="muted">
            {mwan.mode === 'failover'
              ? 'Usa la prima WAN disponibile in ordine di priorità.'
              : mwan.mode === 'balance'
                ? 'Distribuisce le connessioni fra le WAN online.'
                : 'Nessuna politica attiva: il traffico segue le rotte di sistema.'}
          </p>
        </div>
        <button class="button button--ghost" onClick={onEdit}>
          Modifica
        </button>
      </header>

      {!mwan.running && (
        <p class="alert alert--warn">
          mwan3 è installato ma non risponde. Le WAN funzionano con le rotte di sistema.
        </p>
      )}

      {ordered.map((iface, index) => (
        <div key={iface.network} class="port">
          <div class="port__main">
            <span class="net__ssid">
              {index + 1}. {wanLabel(iface.network, iface.device)}
            </span>
            <span class="net__meta">
              {iface.enabled ? statusLabel(iface.status) : 'esclusa'}
              {mwan.mode === 'balance' && iface.enabled ? ` · peso ${iface.weight}` : ''}
            </span>
          </div>
        </div>
      ))}

      {mwan.mode === 'balance' && (
        <p class="alert alert--info">
          Il bilanciamento distribuisce le <strong>connessioni</strong>, non somma la banda:
          un singolo scaricamento resta alla velocità di una sola WAN. Serve ad avere più
          capacità totale con molte connessioni insieme, non a rendere veloce un download.
        </p>
      )}

      <p class="muted">
        Sticky sul traffico generale:{' '}
        {mwan.default_sticky ? `attivo, ${mwan.default_timeout}s` : 'disattivo'}. Riguarda
        tutto ciò che non ha una regola sua qui sotto.
      </p>
    </section>
  );
}

type Busy = null | 'saving';

export function MwanSheet({
  mwan,
  onClose,
}: {
  mwan: Mwan;
  onClose: (changed: boolean) => void;
}) {
  const [mode, setModeValue] = useState<MwanMode>(mwan.mode === 'balance' ? 'balance' : 'failover');
  // Il router ha gia' deciso: qui si legge, non si ricalcola. La regola vive in
  // un posto solo, e questa schermata e' uno dei tre che la mostrano.
  const balanceBlocked = blocked(mwan.policy, 'balance');
  const [order, setOrder] = useState<MwanInterface[]>(byPriority(mwan));
  const [weights, setWeights] = useState<Record<string, string>>(
    Object.fromEntries(mwan.interfaces.map((i) => [i.network, String(i.weight)])),
  );
  const [enabled, setEnabledMap] = useState<Record<string, boolean>>(
    Object.fromEntries(mwan.interfaces.map((i) => [i.network, i.enabled])),
  );
  const [sticky, setSticky] = useState(mwan.default_sticky);
  const [timeout, setTimeoutValue] = useState(String(mwan.default_timeout || 600));
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const timeoutOk = !sticky || (/^\d+$/.test(timeout) && Number(timeout) >= 1);

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  };

  const weightsOk = Object.values(weights).every((w) => /^\d+$/.test(w) && Number(w) >= 1);
  const anyEnabled = Object.values(enabled).some(Boolean);

  const save = async (event: Event) => {
    event.preventDefault();
    setBusy('saving');
    setError(null);
    try {
      await setDefaultRule(mode, sticky, Number(timeout));
      await setPriorityOrder(order.map((i) => i.network));
      for (const iface of order) {
        await setWeight(iface.network, Number(weights[iface.network]));
        await setEnabled(iface.network, enabled[iface.network]);
      }
      await applyMwan();
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>Multi-WAN</h2>

        <form onSubmit={save}>
          <label class="field">
            <span>Modalità</span>
            <select
              value={mode}
              onChange={(e) => setModeValue((e.target as HTMLSelectElement).value as MwanMode)}
            >
              <option value="failover">Failover — una alla volta, in ordine</option>
              {/* Il bilanciamento sparisce dall'elenco solo quando è bloccato:
                  un'opzione che non si può scegliere e resta selezionabile è
                  un salvataggio che il router poi rifiuta, cioè un giro a
                  vuoto. Il motivo sta scritto qui sotto, perché un'opzione che
                  sparisce senza spiegazione fa cercare dove è finita. */}
              {!balanceBlocked && (
                <option value="balance">Bilanciamento — tutte insieme</option>
              )}
            </select>
            <span class="muted">
              {mode === 'failover'
                ? 'Usa la WAN più in alto fra quelle disponibili; scende di uno quando cade.'
                : 'Distribuisce le connessioni sulle WAN online, in proporzione al peso.'}
            </span>
          </label>

          {balanceBlocked && (
            <p class="alert alert--info">
              Il <strong>bilanciamento</strong> non è disponibile:{' '}
              {blockReason(mwan.policy, 'balance')}. Un tunnel è una connessione sola: il
              bilanciamento non la può distribuire, e spostandola cambierebbe l'indirizzo di
              partenza costringendo a un handshake nuovo su tutto il traffico. Spegni il
              tunnel dalla scheda VPN per poter tornare al bilanciamento.
            </p>
          )}

          {mode === 'balance' && (
            <p class="alert alert--info">
              Il bilanciamento distribuisce le <strong>connessioni</strong>, non somma la
              banda: un singolo scaricamento resta alla velocità di una sola WAN.
            </p>
          )}

          <label class="check">
            <input
              type="checkbox"
              checked={sticky}
              onChange={(e) => setSticky((e.target as HTMLInputElement).checked)}
            />
            <span>
              Sticky sul traffico generale: tieni ogni dispositivo sulla stessa WAN per un
              po', anche in bilanciamento. Vale per tutto ciò che non ha una regola sua fra
              quelle di instradamento qui sotto; evita che una sessione già aperta cambi
              indirizzo di uscita a metà.
            </span>
          </label>

          {sticky && (
            <label class="field">
              <span>Per quanti secondi</span>
              <input
                type="text"
                class="range__box"
                value={timeout}
                inputMode="numeric"
                onInput={(e) => setTimeoutValue((e.target as HTMLInputElement).value)}
              />
            </label>
          )}

          <div class="field">
            <span>{mode === 'failover' ? 'Ordine di priorità' : 'WAN e pesi'}</span>

            {order.map((iface, index) => (
              <div key={iface.network} class="port">
                <div class="port__main">
                  <span class="net__ssid">
                    {index + 1}. {wanLabel(iface.network, iface.device)}
                  </span>
                  <span class="net__meta">{statusLabel(iface.status)}</span>
                </div>

                <div class="wan-controls">
                  {mode === 'balance' && (
                    <input
                      type="text"
                      class="range__box"
                      value={weights[iface.network]}
                      inputMode="numeric"
                      aria-label={`peso di ${wanLabel(iface.network, iface.device)}`}
                      disabled={!enabled[iface.network]}
                      onInput={(e) =>
                        setWeights({
                          ...weights,
                          [iface.network]: (e.target as HTMLInputElement).value,
                        })
                      }
                    />
                  )}
                  {mode === 'failover' && (
                    <>
                      <button
                        type="button"
                        class="button button--ghost"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                        aria-label="sposta su"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        class="button button--ghost"
                        disabled={index === order.length - 1}
                        onClick={() => move(index, 1)}
                        aria-label="sposta giù"
                      >
                        ↓
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}

            {!weightsOk && <span class="muted">I pesi devono essere numeri interi da 1 in su.</span>}
          </div>

          <div class="field">
            <span>WAN incluse</span>
            {order.map((iface) => (
              <label key={iface.network} class="check">
                <input
                  type="checkbox"
                  checked={enabled[iface.network]}
                  onChange={(e) =>
                    setEnabledMap({
                      ...enabled,
                      [iface.network]: (e.target as HTMLInputElement).checked,
                    })
                  }
                />
                <span>
                  {wanLabel(iface.network, iface.device)} — se la togli, mwan3 smette di usarla e di
                  controllarla, ma l'interfaccia resta su.
                </span>
              </label>
            ))}
            {!anyEnabled && (
              <span class="alert alert--error">
                Almeno una WAN deve restare inclusa, altrimenti nessun traffico esce.
              </span>
            )}
          </div>

          {error && <p class="alert alert--error alert--code">{error}</p>}

          <p class="muted">
            Applicando, mwan3 riparte e le interfacce rinnovano l'indirizzo. Le
            associazioni WiFi non vengono toccate.
          </p>

          <div class="sheet__actions">
            <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
              Annulla
            </button>
            <button
              class="button button--primary"
              type="submit"
              disabled={busy !== null || !weightsOk || !anyEnabled || !timeoutOk}
            >
              {busy ? 'Applico…' : 'Applica'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Accetta un indirizzo o una sottorete: "192.168.1.5" oppure "10.0.0.0/8". */
function isValidTarget(value: string): boolean {
  const [address, prefix] = value.split('/');
  if (!isValidIp(address)) return false;
  if (prefix === undefined) return true;
  return /^\d{1,2}$/.test(prefix) && Number(prefix) <= 32;
}

/** Accetta "443" oppure "5000-5100". */
function isValidPortSpec(value: string): boolean {
  const parts = value.split('-');
  if (parts.length > 2) return false;
  return parts.every((p) => /^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535);
}

function ruleSummary(rule: MwanRule, mwan: Mwan): string {
  const bits: string[] = [];
  bits.push(rule.src_ip ? `da ${rule.src_ip}` : 'da chiunque');
  if (rule.dest_ip) bits.push(`verso ${rule.dest_ip}`);
  if (rule.dest_port) bits.push(`porta ${rule.dest_port}`);
  if (rule.proto && rule.proto !== 'all') bits.push(rule.proto.toUpperCase());

  const parsed = parsePolicy(rule.use_policy);
  if (parsed) {
    const iface = mwan.interfaces.find((i) => i.network === parsed.network);
    bits.push(`→ ${wanLabel(parsed.network, iface?.device)}`);
    if (parsed.strict) bits.push('(bloccante)');
  }
  if (rule.sticky) bits.push(`sticky ${rule.timeout}s`);
  return bits.join(' · ');
}

export function RulesCard({
  mwan,
  onAdd,
  onEdit,
}: {
  mwan: Mwan | null;
  onAdd: () => void;
  onEdit: (rule: MwanRule) => void;
}) {
  if (!mwan || !mwan.installed) return null;

  return (
    <section class="card">
      <header class="radio__head">
        <div>
          <h2 class="uplink__title">Regole di instradamento</h2>
          <p class="muted">
            Mandano traffico specifico su una WAN fissa, scavalcando la modalità. Vince la
            prima che combacia.
          </p>
        </div>
        <button class="button button--ghost" onClick={onAdd}>
          Aggiungi
        </button>
      </header>

      {mwan.rules.length === 0 ? (
        <p class="muted">
          Nessuna regola: tutto il traffico segue la modalità {MODE_LABEL[mwan.mode]}.
        </p>
      ) : (
        mwan.rules.map((rule, index) => (
          <button key={rule.section} class="net" onClick={() => onEdit(rule)}>
            <span class="net__main">
              <span class="net__ssid">Regola {index + 1}</span>
              <span class="net__meta">{ruleSummary(rule, mwan)}</span>
            </span>
          </button>
        ))
      )}
    </section>
  );
}

export function RuleSheet({
  mwan,
  rule,
  onClose,
}: {
  mwan: Mwan;
  /** null per una regola nuova. */
  rule: MwanRule | null;
  onClose: (changed: boolean) => void;
}) {
  const existing = rule ? parsePolicy(rule.use_policy) : null;

  const [src, setSrc] = useState(rule?.src_ip ?? '');
  const [dest, setDest] = useState(rule?.dest_ip ?? '');
  const [port, setPort] = useState(rule?.dest_port ?? '');
  const [proto, setProto] = useState(rule?.proto || 'all');
  const [network, setNetwork] = useState(existing?.network ?? mwan.interfaces[0]?.network ?? '');
  const [strict, setStrict] = useState(existing?.strict ?? false);
  const [sticky, setSticky] = useState(rule?.sticky ?? false);
  const [timeout, setTimeoutValue] = useState(String(rule?.timeout || 600));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const srcOk = src === '' || isValidTarget(src);
  const destOk = dest === '' || isValidTarget(dest);
  const portOk = port === '' || isValidPortSpec(port);
  const hasCriteria = src !== '' || dest !== '' || port !== '';
  const timeoutOk = !sticky || (/^\d+$/.test(timeout) && Number(timeout) >= 1);
  const ok = srcOk && destOk && portOk && hasCriteria && timeoutOk && network !== '';

  const save = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input = {
        src_ip: src.trim(),
        dest_ip: dest.trim(),
        dest_port: port.trim(),
        proto,
        network,
        strict,
        sticky,
        timeout: Number(timeout),
      };
      // Lo sticky della regola generale non c'entra con questa regola
      // specifica, ma va preservato: la ricreazione di travel_default lo
      // riscrive per intero.
      const defaults = { mode: mwan.mode, sticky: mwan.default_sticky, timeout: mwan.default_timeout };
      if (rule) await updateRule(rule.section, input, defaults);
      else await addRule(input, defaults);
      await applyMwan();
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!rule) return;
    setBusy(true);
    setError(null);
    try {
      await deleteRule(rule.section);
      await applyMwan();
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{rule ? 'Modifica regola' : 'Nuova regola'}</h2>

        <form onSubmit={save}>
          <p class="muted">
            Serve almeno un criterio. Quelli lasciati vuoti valgono come "qualsiasi".
          </p>

          <label class="field">
            <span>Dispositivo di partenza</span>
            <input
              type="text"
              value={src}
              inputMode="decimal"
              autocomplete="off"
              spellcheck={false}
              placeholder="es. 192.168.10.50 — vuoto = tutti"
              onInput={(e) => setSrc((e.target as HTMLInputElement).value)}
            />
            {!srcOk && <span class="muted">Serve un indirizzo o una sottorete valida.</span>}
          </label>

          <label class="field">
            <span>Destinazione</span>
            <input
              type="text"
              value={dest}
              inputMode="decimal"
              autocomplete="off"
              spellcheck={false}
              placeholder="es. 10.0.0.0/8 — vuoto = ovunque"
              onInput={(e) => setDest((e.target as HTMLInputElement).value)}
            />
            {!destOk && <span class="muted">Serve un indirizzo o una sottorete valida.</span>}
          </label>

          <div class="field">
            <span>Porta e protocollo</span>
            <div class="range">
              <input
                type="text"
                class="range__box"
                value={port}
                inputMode="numeric"
                aria-label="porta di destinazione"
                placeholder="443"
                onInput={(e) => setPort((e.target as HTMLInputElement).value)}
              />
              <select value={proto} onChange={(e) => setProto((e.target as HTMLSelectElement).value)}>
                <option value="all">tutti i protocolli</option>
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
                <option value="icmp">ICMP</option>
              </select>
            </div>
            {!portOk && <span class="muted">Una porta (443) o un intervallo (5000-5100).</span>}
          </div>

          <label class="field">
            <span>Instrada su</span>
            <select
              value={network}
              onChange={(e) => setNetwork((e.target as HTMLSelectElement).value)}
            >
              {mwan.interfaces.map((iface) => (
                <option key={iface.network} value={iface.network}>
                  {wanLabel(iface.network, iface.device)}
                </option>
              ))}
            </select>
          </label>

          <label class="check">
            <input
              type="checkbox"
              checked={strict}
              onChange={(e) => setStrict((e.target as HTMLInputElement).checked)}
            />
            <span>
              Se questa WAN non è disponibile, <strong>ferma</strong> il traffico invece di
              mandarlo sulle altre. Serve quando il punto della regola è non uscire mai da
              un'altra parte; senza, il traffico devia e la regola diventa una preferenza.
            </span>
          </label>

          <label class="check">
            <input
              type="checkbox"
              checked={sticky}
              onChange={(e) => setSticky((e.target as HTMLInputElement).checked)}
            />
            <span>
              Sticky: tieni lo stesso dispositivo sulla stessa WAN per un po', anche in
              bilanciamento. Evita che una sessione già aperta cambi indirizzo di uscita a
              metà.
            </span>
          </label>

          {sticky && (
            <label class="field">
              <span>Per quanti secondi</span>
              <input
                type="text"
                class="range__box"
                value={timeout}
                inputMode="numeric"
                onInput={(e) => setTimeoutValue((e.target as HTMLInputElement).value)}
              />
            </label>
          )}

          {!hasCriteria && (
            <p class="muted">
              Senza nessun criterio la regola prenderebbe tutto il traffico, sostituendo di
              fatto la modalità.
            </p>
          )}

          {error && <p class="alert alert--error alert--code">{error}</p>}

          <div class="sheet__actions">
            <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
              Annulla
            </button>
            {rule && (
              <button
                class="button button--ghost"
                type="button"
                disabled={busy}
                onClick={remove}
              >
                Elimina
              </button>
            )}
            <button class="button button--primary" type="submit" disabled={busy || !ok}>
              {busy ? 'Applico…' : 'Salva'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function HealthSheet({
  iface,
  onClose,
}: {
  iface: MwanInterface;
  onClose: (changed: boolean) => void;
}) {
  const [one, setOne] = useState(iface.track_ip[0] ?? '');
  const [two, setTwo] = useState(iface.track_ip[1] ?? '');
  const [interval, setInterval] = useState(String(iface.interval));
  const [timeout, setTimeoutValue] = useState(String(iface.timeout));
  const [down, setDown] = useState(String(iface.down));
  const [up, setUp] = useState(String(iface.up));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ips = [one, two].map((s) => s.trim()).filter((s) => s.length > 0);
  const ipsOk = ips.length >= 1 && ips.every(isValidIp);
  const numsOk = [interval, timeout, down, up].every((v) => /^\d+$/.test(v) && Number(v) >= 1);

  const save = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await setHealth(iface.network, {
        track_ip: ips,
        interval: Number(interval),
        timeout: Number(timeout),
        count: iface.count,
        up: Number(up),
        down: Number(down),
        reliability: 1,
      });
      await applyMwan();
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>Controllo di salute · {wanLabel(iface.network, iface.device)}</h2>

        <form onSubmit={save}>
          <p class="muted">
            mwan3 verifica questa WAN mandando ping a indirizzi noti. Quando smettono di
            rispondere, la considera giù e passa alla successiva.
          </p>

          <label class="field">
            <span>Indirizzo da controllare</span>
            <input
              type="text"
              value={one}
              inputMode="decimal"
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => setOne((e.target as HTMLInputElement).value)}
            />
          </label>

          <label class="field">
            <span>Secondo indirizzo (facoltativo)</span>
            <input
              type="text"
              value={two}
              inputMode="decimal"
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => setTwo((e.target as HTMLInputElement).value)}
            />
            <span class="muted">
              Tienili <strong>diversi</strong> da quelli delle altre WAN: se controllassero
              tutte lo stesso indirizzo e quello avesse un problema, sembrerebbero cadute
              tutte insieme.
            </span>
          </label>

          {!ipsOk && <span class="muted">Serve almeno un indirizzo IPv4 valido.</span>}

          <div class="field">
            <span>Ogni quanto controllare</span>
            <div class="range">
              <input
                type="text"
                class="range__box"
                value={interval}
                inputMode="numeric"
                aria-label="intervallo in secondi"
                onInput={(e) => setInterval((e.target as HTMLInputElement).value)}
              />
              <span class="range__label">secondi, timeout</span>
              <input
                type="text"
                class="range__box"
                value={timeout}
                inputMode="numeric"
                aria-label="timeout in secondi"
                onInput={(e) => setTimeoutValue((e.target as HTMLInputElement).value)}
              />
              <span class="range__label">s</span>
            </div>
          </div>

          <div class="field">
            <span>Quanti tentativi prima di cambiare stato</span>
            <div class="range">
              <span class="range__label">Giù dopo</span>
              <input
                type="text"
                class="range__box"
                value={down}
                inputMode="numeric"
                aria-label="tentativi falliti prima di dichiarare la WAN giù"
                onInput={(e) => setDown((e.target as HTMLInputElement).value)}
              />
              <span class="range__label">· su dopo</span>
              <input
                type="text"
                class="range__box"
                value={up}
                inputMode="numeric"
                aria-label="tentativi riusciti prima di dichiarare la WAN su"
                onInput={(e) => setUp((e.target as HTMLInputElement).value)}
              />
            </div>
            <span class="muted">
              Con {interval}s di intervallo, una caduta viene rilevata in circa{' '}
              {Number(interval) * Number(down) || '—'} secondi e il ritorno in{' '}
              {Number(interval) * Number(up) || '—'}. Valori bassi reagiscono prima ma
              scambiano per guasto una rete solo lenta.
            </span>
          </div>

          {!numsOk && <span class="muted">I valori devono essere numeri interi da 1 in su.</span>}

          {error && <p class="alert alert--error alert--code">{error}</p>}

          <div class="sheet__actions">
            <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
              Annulla
            </button>
            <button
              class="button button--primary"
              type="submit"
              disabled={busy || !ipsOk || !numsOk}
            >
              {busy ? 'Applico…' : 'Applica'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
