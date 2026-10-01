import { useState } from 'preact/hooks';
import {
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
  modeLabel,
  parsePolicy,
  updateRule,
} from '../lib/mwan';
import type { Mwan, MwanInterface, MwanMode, MwanRule } from '../lib/mwan';
import { blockReason, blocked } from '../lib/vpn';
import { isValidIp, parseCidr } from '../lib/ip';
import { commonText } from '../i18n/common';
import { mwanText } from '../i18n/mwan';

/**
 * Etichetta di una WAN.
 *
 * Per le porte si usa il nome fisico del device, non quello dell'interfaccia
 * logica: OpenWrt chiama le porte col loro ruolo di fabbrica (`wan`, `lan1`),
 * e dopo averle commutate quel nome direbbe il contrario di com'e' messa. Il
 * device invece resta lo stesso e identifica sempre la stessa presa.
 */
export function wanLabel(network: string, device?: string): string {
  const t = mwanText();
  if (network.endsWith('radio0')) return t.wifi24;
  if (network.endsWith('radio1')) return t.wifi5;
  if (network === 'wan_usb' || network.includes('usb')) return t.usb;
  return device ? t.port(device) : network;
}

export function MwanCard({
  mwan,
  onEdit,
}: {
  mwan: Mwan | null;
  onEdit: () => void;
}) {
  const t = mwanText();
  if (!mwan) {
    return (
      <section class="card">
        <h2 class="uplink__title">{t.title}</h2>
        <p class="muted">{t.reading}</p>
      </section>
    );
  }

  if (!mwan.installed) {
    return (
      <section class="card">
        <h2 class="uplink__title">{t.notInstalled}</h2>
      </section>
    );
  }

  const ordered = byPriority(mwan);

  return (
    <section class={`card uplink uplink--${mwan.running ? 'addressed' : 'no-address'}`}>
      <header class="radio__head">
        <h2 class="uplink__title">
          {t.title} · {modeLabel(mwan.mode)}
        </h2>
        <button class="button button--ghost" onClick={onEdit}>
          {t.edit}
        </button>
      </header>

      {!mwan.running && (
        <p class="alert alert--warn">{t.notRunning}</p>
      )}

      {ordered.map((iface, index) => (
        <div key={iface.network} class="port">
          <div class="port__main">
            <span class="net__ssid">
              {index + 1}. {wanLabel(iface.network, iface.device)}
            </span>
            <span class="net__meta">
              {iface.enabled ? statusLabel(iface.status) : t.excluded}
              {mwan.mode === 'balance' && iface.enabled ? t.weight(iface.weight) : ''}
            </span>
          </div>
        </div>
      ))}

      <p class="muted">
        {t.stickyGeneral}:{' '}
        {mwan.default_sticky ? t.stickyOn(mwan.default_timeout) : t.stickyOff}
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
  const t = mwanText();
  const actions = commonText().actions;
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
        <h2>{t.title}</h2>

        <form onSubmit={save}>
          <label class="field">
            <span>{t.modeField}</span>
            <select
              value={mode}
              onChange={(e) => setModeValue((e.target as HTMLSelectElement).value as MwanMode)}
            >
              <option value="failover">{t.failoverOption}</option>
              {/* Il bilanciamento sparisce dall'elenco solo quando è bloccato:
                  un'opzione che non si può scegliere e resta selezionabile è
                  un salvataggio che il router poi rifiuta, cioè un giro a
                  vuoto. Il motivo sta scritto qui sotto, perché un'opzione che
                  sparisce senza spiegazione fa cercare dove è finita. */}
              {!balanceBlocked && (
                <option value="balance">{t.balanceOption}</option>
              )}
            </select>
          </label>

          {balanceBlocked && (
            <p class="alert alert--info">
              {t.balanceBlocked(blockReason(mwan.policy, 'balance'))}
            </p>
          )}

          <label class="check">
            <input
              type="checkbox"
              checked={sticky}
              onChange={(e) => setSticky((e.target as HTMLInputElement).checked)}
            />
            <span>{t.stickyGeneral}</span>
          </label>

          {sticky && (
            <label class="field">
              <span>{t.seconds}</span>
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
            <span>{mode === 'failover' ? t.priority : t.weights}</span>

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
                      aria-label={t.weightOf(wanLabel(iface.network, iface.device))}
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
                        aria-label={t.moveUp}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        class="button button--ghost"
                        disabled={index === order.length - 1}
                        onClick={() => move(index, 1)}
                        aria-label={t.moveDown}
                      >
                        ↓
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}

            {!weightsOk && <span class="muted">{t.badWeights}</span>}
          </div>

          <div class="field">
            <span>{t.included}</span>
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
                <span>{wanLabel(iface.network, iface.device)}</span>
              </label>
            ))}
            {!anyEnabled && (
              <span class="alert alert--error">{t.oneIncluded}</span>
            )}
          </div>

          {error && <p class="alert alert--error alert--code">{error}</p>}

          <div class="sheet__actions">
            <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
              {actions.cancel}
            </button>
            <button
              class="button button--primary"
              type="submit"
              disabled={busy !== null || !weightsOk || !anyEnabled || !timeoutOk}
            >
              {busy ? t.applying : t.apply}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Accetta un indirizzo o una sottorete, in entrambe le famiglie:
 * "192.168.1.5", "10.0.0.0/8", "2001:db8::1", "fd00::/64".
 *
 * Passa da parseCidr e non da una regex sul prefisso: /33 non e' accettato, e
 * il prefisso viene convalidato sulla famiglia dell'indirizzo invece che su un
 * massimo scritto a mano - una regex non saprebbe esprimere /128.
 *
 * Il vincolo a IPv4 e' caduto ora che mwan3 ha le sezioni gemelle: `ruleValues`
 * deduce la famiglia dai criteri invece di scrivere sempre `ipv4`. Quello che
 * resta rifiutato e' una regola che le MESCOLA, e lo rifiuta `ruleFamily`.
 */
function isValidTarget(value: string): boolean {
  return parseCidr(value) !== null;
}

/** Accetta "443" oppure "5000-5100". */
function isValidPortSpec(value: string): boolean {
  const parts = value.split('-');
  if (parts.length > 2) return false;
  return parts.every((p) => /^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535);
}

function ruleSummary(rule: MwanRule, mwan: Mwan): string {
  const t = mwanText().rule;
  const bits: string[] = [];
  bits.push(rule.src_ip ? t.from(rule.src_ip) : t.fromAnyone);
  if (rule.dest_ip) bits.push(t.to(rule.dest_ip));
  if (rule.dest_port) bits.push(t.port(rule.dest_port));
  if (rule.proto && rule.proto !== 'all') bits.push(rule.proto.toUpperCase());

  const parsed = parsePolicy(rule.use_policy);
  if (parsed) {
    const iface = mwan.interfaces.find((i) => i.network === parsed.network);
    bits.push(`→ ${wanLabel(parsed.network, iface?.device)}`);
    if (parsed.strict) bits.push(t.strict);
  }
  if (rule.sticky) bits.push(t.sticky(rule.timeout));
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
  const t = mwanText();

  return (
    <section class="card">
      <header class="radio__head">
        <h2 class="uplink__title">{t.rules}</h2>
        <button class="button button--ghost" onClick={onAdd}>
          {t.add}
        </button>
      </header>

      {mwan.rules.length === 0 ? (
        <p class="muted">{t.noRules}</p>
      ) : (
        mwan.rules.map((rule, index) => (
          <button key={rule.section} class="net" onClick={() => onEdit(rule)}>
            <span class="net__main">
              <span class="net__ssid">{t.ruleN(index + 1)}</span>
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
  const t = mwanText();
  const actions = commonText().actions;
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
        <h2>{rule ? t.editRule : t.newRule}</h2>

        <form onSubmit={save}>
          <label class="field">
            <span>{t.source}</span>
            <input
              type="text"
              value={src}
              inputMode="decimal"
              autocomplete="off"
              spellcheck={false}
              placeholder={t.sourcePlaceholder}
              onInput={(e) => setSrc((e.target as HTMLInputElement).value)}
            />
            {!srcOk && <span class="muted">{t.badTarget}</span>}
          </label>

          <label class="field">
            <span>{t.destination}</span>
            <input
              type="text"
              value={dest}
              inputMode="decimal"
              autocomplete="off"
              spellcheck={false}
              placeholder={t.destPlaceholder}
              onInput={(e) => setDest((e.target as HTMLInputElement).value)}
            />
            {!destOk && <span class="muted">{t.badTarget}</span>}
          </label>

          <div class="field">
            <span>{t.portProto}</span>
            <div class="range">
              <input
                type="text"
                class="range__box"
                value={port}
                inputMode="numeric"
                aria-label={t.destPort}
                placeholder="443"
                onInput={(e) => setPort((e.target as HTMLInputElement).value)}
              />
              <select value={proto} onChange={(e) => setProto((e.target as HTMLSelectElement).value)}>
                <option value="all">{t.allProtocols}</option>
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
                <option value="icmp">ICMP</option>
              </select>
            </div>
            {!portOk && <span class="muted">{t.badPort}</span>}
          </div>

          <label class="field">
            <span>{t.routeVia}</span>
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
            <span>{t.strictField}</span>
          </label>

          <label class="check">
            <input
              type="checkbox"
              checked={sticky}
              onChange={(e) => setSticky((e.target as HTMLInputElement).checked)}
            />
            <span>{t.sticky}</span>
          </label>

          {sticky && (
            <label class="field">
              <span>{t.seconds}</span>
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
            <p class="muted">{t.needsCriteria}</p>
          )}

          {error && <p class="alert alert--error alert--code">{error}</p>}

          <div class="sheet__actions">
            <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
              {actions.cancel}
            </button>
            {rule && (
              <button
                class="button button--ghost"
                type="button"
                disabled={busy}
                onClick={remove}
              >
                {t.remove}
              </button>
            )}
            <button class="button button--primary" type="submit" disabled={busy || !ok}>
              {busy ? t.applying : actions.save}
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
  const t = mwanText();
  const actions = commonText().actions;
  const [one, setOne] = useState(iface.track_ip[0] ?? '');
  const [two, setTwo] = useState(iface.track_ip[1] ?? '');
  const [interval, setInterval] = useState(String(iface.interval));
  const [timeout, setTimeoutValue] = useState(String(iface.timeout));
  const [down, setDown] = useState(String(iface.down));
  const [up, setUp] = useState(String(iface.up));
  // Quanti IP devono rispondere. mwan3track li pinga in ordine e si ferma
  // appena ne hanno risposto abbastanza: con 1 il secondo e' una riserva,
  // pingata solo quando il primo tace; con 2 si pingano sempre tutti e due.
  const [both, setBoth] = useState(iface.reliability >= 2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ips = [one, two].map((s) => s.trim()).filter((s) => s.length > 0);
  // La lambda non e' rumore: `ips.every(isValidIp)` passerebbe a isValidIp
  // l'INDICE come secondo argomento, cioe' convaliderebbe il primo indirizzo
  // contro la "famiglia 0" e il secondo contro la "famiglia 1", rifiutandoli
  // entrambi.
  //
  // E la famiglia resta IPv4 anche ora che mwan3 e' dual-stack, perche' questi
  // indirizzi finiscono in `mwan3.<net>`, che e' la sezione `family=ipv4`: un
  // indirizzo v6 li' dentro verrebbe pingato con `ping` e la WAN risulterebbe
  // caduta per sempre. Le sonde v6 stanno nella gemella `<net>6` e le sceglie
  // `mwan3-setup.sh` da un pool suo, perche' devono restare diverse fra le WAN
  // e non c'e' niente da chiedere a chi guarda.
  const ipsOk = ips.length >= 1 && ips.every((ip) => isValidIp(ip, 4));
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
        reliability: both && ips.length >= 2 ? 2 : 1,
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
        <h2>{t.healthOf(wanLabel(iface.network, iface.device))}</h2>

        <form onSubmit={save}>
          <label class="field">
            <span>{t.trackIp}</span>
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
            <span>{t.trackIp2}</span>
            <input
              type="text"
              value={two}
              inputMode="decimal"
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => setTwo((e.target as HTMLInputElement).value)}
            />
          </label>

          {!ipsOk && <span class="muted">{t.badTrackIp}</span>}

          {/* Solo con due indirizzi: con uno la domanda non esiste. */}
          {ips.length >= 2 && (
            <label class="field">
              <span>{t.reliability}</span>
              <select
                value={both ? 'both' : 'any'}
                onChange={(e) => setBoth((e.target as HTMLSelectElement).value === 'both')}
              >
                <option value="any">{t.reliabilityAny}</option>
                <option value="both">{t.reliabilityBoth}</option>
              </select>
              <span class="muted">{both ? t.reliabilityBothHint : t.reliabilityAnyHint}</span>
            </label>
          )}

          <div class="field">
            <span>{t.every}</span>
            <div class="range">
              <input
                type="text"
                class="range__box"
                value={interval}
                inputMode="numeric"
                aria-label={t.intervalLabel}
                onInput={(e) => setInterval((e.target as HTMLInputElement).value)}
              />
              <span class="range__label">{t.secondsTimeout}</span>
              <input
                type="text"
                class="range__box"
                value={timeout}
                inputMode="numeric"
                aria-label={t.timeoutLabel}
                onInput={(e) => setTimeoutValue((e.target as HTMLInputElement).value)}
              />
              <span class="range__label">s</span>
            </div>
          </div>

          <div class="field">
            <span>{t.attempts}</span>
            <div class="range">
              <span class="range__label">{t.downAfter}</span>
              <input
                type="text"
                class="range__box"
                value={down}
                inputMode="numeric"
                aria-label={t.downLabel}
                onInput={(e) => setDown((e.target as HTMLInputElement).value)}
              />
              <span class="range__label">{t.upAfter}</span>
              <input
                type="text"
                class="range__box"
                value={up}
                inputMode="numeric"
                aria-label={t.upLabel}
                onInput={(e) => setUp((e.target as HTMLInputElement).value)}
              />
            </div>
            <span class="muted">
              {t.detection(Number(interval) * Number(down) || '—', Number(interval) * Number(up) || '—')}
            </span>
          </div>

          {!numsOk && <span class="muted">{t.badNumbers}</span>}

          {error && <p class="alert alert--error alert--code">{error}</p>}

          <div class="sheet__actions">
            <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
              {actions.cancel}
            </button>
            <button
              class="button button--primary"
              type="submit"
              disabled={busy || !ipsOk || !numsOk}
            >
              {busy ? t.applying : t.apply}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
