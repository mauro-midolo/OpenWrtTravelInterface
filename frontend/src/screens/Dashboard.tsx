import { useEffect, useState } from 'preact/hooks';
import { UbusError } from '../lib/ubus';
import { usePoll } from '../lib/poll';
import { useApply } from '../lib/apply';
import { formatBytes, formatRate, getDashboard, overallState } from '../lib/dashboard';
import type { Dashboard as DashboardData, DashWan, OverallState } from '../lib/dashboard';
import { activeInterfaces, getMwan, modeLabel, statusLabel, trackState } from '../lib/mwan';
import { HealthSheet, MwanCard, MwanSheet, RuleSheet, RulesCard } from './MultiWan';
import type { Mwan, MwanInterface, MwanRule, TrackResult } from '../lib/mwan';
import {
  hostnameFromUci,
  hostnameLabel,
  isValidHostname,
  stageWanHostname,
} from '../lib/hostname';
import type { HostnameChoice } from '../lib/hostname';
import { findSavedOn, listSaved, updateNetwork } from '../lib/networks';
import type { SavedNetwork } from '../lib/networks';
import { HostnamePicker } from '../components/HostnamePicker';
import { ApplyStatus } from '../components/ApplyStatus';
import { MacCloneSheet, PortalMemoryCard, PortalPanel } from './Portal';
import { commonText } from '../i18n/common';
import { dashboardText } from '../i18n/dashboard';

/**
 * Il sommario in cima, in una riga.
 *
 * "Collegato" e "Internet raggiungibile" sono due frasi diverse di proposito:
 * la prima dice che c'e' una rotta, la seconda che una richiesta vera e'
 * uscita ed e' tornata. Con la sola prima, sotto ci
 * stava anche il caso peggiore - una rete d'albergo che ti tiene fuori con una
 * pagina di login mentre tutto sembra a posto.
 */
const OVERALL_TONE: Record<OverallState, string> = {
  online: 'addressed',
  connected: 'addressed',
  portal: 'no-address',
  'no-internet': 'unassociated',
  degraded: 'no-address',
  offline: 'unassociated',
};

/**
 * Il sommario di stato dipende dal tipo: una radio che non aggancia e un cavo
 * scollegato hanno rimedi opposti, e chiamarli allo stesso modo manda a cercare
 * il guasto nel posto sbagliato.
 */
function stateLabel(wan: DashWan): string {
  const t = dashboardText().state;
  switch (wan.state) {
    case 'addressed':
      return t.addressed;
    case 'no-address':
      if (wan.kind === 'wifi') return t.wifiNoAddress;
      // Sul tethering non c'e' nessun cavo di cui parlare: il telefono e'
      // collegato, ma non sta ancora condividendo la connessione.
      if (wan.kind === 'usb') return t.usbNoAddress;
      return t.cableNoAddress;
    case 'unassociated':
      return t.unassociated;
    case 'no-carrier':
      // Zero e "non leggibile" non sono la stessa cosa: nel secondo caso non
      // si puo' affermare che manchi il cavo.
      return wan.carrier === 0 ? t.noCable : t.noLink;
    case 'disabled':
      return t.disabled;
    default:
      return wan.kind === 'wifi' ? t.wifiNone : t.none;
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div class="row">
      <span class="row__label">{label}</span>
      <span class="row__value">{value}</span>
    </div>
  );
}

function trackValue(track: TrackResult): string {
  const t = dashboardText();
  // Latenza e perdita mwan3track le misura solo con `check_quality`: senza,
  // arrivano a zero e "0 ms · 0% persi" sembrerebbe una misura ottima invece
  // di nessuna misura. Zero e zero insieme vuol dire "non misurato".
  const measured = track.latency > 0 || track.packetloss > 0;
  switch (trackState(track.status)) {
    case 'up':
      return measured ? t.trackUp(track.latency, track.packetloss) : t.trackAnswers;
    case 'down':
      return measured ? t.trackDown(track.packetloss) : t.trackNoAnswer;
    case 'skipped':
      return t.trackSkipped;
    default:
      return t.trackUnknown;
  }
}

function wanTitle(wan: DashWan): string {
  const t = dashboardText();
  if (wan.kind === 'wifi') return t.wifi(wan.band || wan.radio);
  // Il nome fisico della porta, non il suo ruolo: OpenWrt le chiama col ruolo
  // di fabbrica (`wan`, `lan1`), che dopo una commutazione dice il contrario
  // di com'e' messa. Il device identifica sempre la stessa presa.
  if (wan.kind === 'usb') return t.usb;
  if (wan.kind === 'ethernet') return wan.device ? t.port(wan.device) : t.ethernet;
  return wan.network;
}

function WanCard({
  wan,
  mwan,
  deviceHostname,
  onHealth,
  onHostname,
  onClone,
  onPortal,
}: {
  wan: DashWan;
  mwan: MwanInterface | null;
  /** Nome del router: e' cio' che viene inviato in modalita' "nome del router". */
  deviceHostname: string;
  onHealth: () => void;
  onHostname: () => void;
  onClone: () => void;
  onPortal: () => void;
}) {
  const t = dashboardText();
  return (
    <section class={`card uplink uplink--${wan.state}`}>
      <header class="radio__head">
        <div>
          <h2 class="uplink__title">{wanTitle(wan)}</h2>
          <p class="muted">
            {stateLabel(wan)}
            {wan.ssid ? ` · ${wan.ssid}` : ''}
            {mwan ? ` · mwan3: ${statusLabel(mwan.status)}` : ''}
          </p>
        </div>
        {wan.active && <span class="badge badge--ok">{t.carriesTraffic}</span>}
        {wan.portal?.state === 'portal' && <span class="badge badge--warn">{t.login}</span>}
      </header>

      {/* La verifica dell'uscita sta in alto, prima dei dettagli: e' la
          domanda che ci si fa guardando questa scheda, e la risposta non deve
          stare sotto tre righe di numeri. */}
      {(wan.state === 'addressed' || wan.portal) && (
        <PortalPanel wan={wan} onDone={onPortal} onClone={onClone} />
      )}

      {/* mwan3 controlla con un ping, che un portale lascia passare: puo'
          quindi dichiarare online una WAN da cui non esce niente, e mandarci
          sopra il traffico. Dirlo qui e' l'unico modo di spiegare perche' la
          rete "funziona" e le pagine non si aprono. */}
      {mwan && mwan.status === 'online' && wan.portal?.state === 'portal' && (
        <p class="alert alert--warn">{t.mwanOnlinePortal}</p>
      )}

      {/* Il controllo di salute per singolo IP: e' quello che spiega PERCHE'
          una WAN risulta giu', non solo che lo e'. */}
      {mwan && mwan.enabled && mwan.tracking.length > 0 && (
        <>
          <header class="radio__head">
            <h2>{t.health}</h2>
            <button class="button button--ghost" onClick={onHealth}>
              {t.edit}
            </button>
          </header>
          {mwan.tracking.map((track) => (
            <Row
              key={track.ip}
              label={track.ip}
              value={trackValue(track)}
            />
          ))}
          <Row
            label={t.priorityWeight}
            value={`${mwan.priority} / ${mwan.weight}`}
          />
        </>
      )}
      {mwan && !mwan.enabled && (
        <p class="muted">{t.excluded}</p>
      )}

      {/* Impostazione, non stato: si mostra anche quando la WAN e' giu', ed e'
          proprio li' che serve poterla cambiare prima di riprovare. */}
      <header class="radio__head">
        <h2>{t.dhcp}</h2>
        <button class="button button--ghost" onClick={onHostname}>
          {t.edit}
        </button>
      </header>
      <Row
        label={t.sentName}
        value={hostnameLabel(hostnameFromUci(wan.hostname), deviceHostname)}
      />

      {wan.state === 'addressed' || wan.state === 'no-address' ? (
        <>
          {/* Vedi Wifi.tsx: su un uplink v6-only "nessuno" sarebbe falso. */}
          <Row
            label={wan.ipv6.length > 0 ? t.address4 : t.address}
            value={wan.ipv4 || (wan.ipv6.length > 0 ? '—' : t.none)}
          />
          <Row label={t.gateway} value={wan.gateway || '—'} />
          <Row label={t.dns} value={wan.dns?.length ? wan.dns.join('  ') : '—'} />
          {/* Solo dove IPv6 c'e': vedi la stessa scelta in Wifi.tsx. */}
          {wan.ipv6.length > 0 && (
            <>
              <Row label={t.address6} value={wan.ipv6.join('  ')} />
              {/* Vedi Wifi.tsx: senza rotta predefinita IPv6 non esce dalla
                  rete locale, e un trattino farebbe sospettare un guasto che
                  non c'e'. Di IPv4 non si dice niente, perche' questa riga non
                  lo sa. */}
              <Row
                label={t.gateway6}
                value={wan.gateway6 || t.none}
              />
              {wan.dns6.length > 0 && <Row label={t.dns6} value={wan.dns6.join('  ')} />}
              {wan.prefix6 && <Row label={t.prefix6} value={wan.prefix6} />}
            </>
          )}
          <Row label={t.mac} value={wan.mac || '—'} />
          {wan.kind === 'usb' && (
            <>
              <Row
                label={t.device}
                value={
                  wan.device
                    ? `${wan.device}${wan.driver ? ` · ${wan.driver}` : ''}`
                    : t.noDevice
                }
              />
            </>
          )}
          {wan.kind === 'wifi' && (
            <>
              <Row
                label={t.signal}
                value={typeof wan.signal === 'number' ? `${wan.signal} dBm` : '—'}
              />
              <Row
                label={t.channelRate}
                value={`ch ${wan.channel || '—'}${wan.bitrate ? ` · ${Math.round(wan.bitrate / 1000)} Mbit/s` : ''}`}
              />
              <Row label="BSSID" value={wan.bssid || '—'} />
            </>
          )}

          <h2>{t.traffic}</h2>
          <Row
            label={t.now}
            value={`↓ ${formatRate(wan.rx_rate)}   ↑ ${formatRate(wan.tx_rate)}`}
          />
          <Row
            label={t.session}
            value={`↓ ${formatBytes(wan.rx_session)}   ↑ ${formatBytes(wan.tx_session)}`}
          />
        </>
      ) : null}
    </section>
  );
}

/**
 * Nome inviato nella richiesta DHCP di una WAN.
 *
 * Vive sull'interfaccia logica, quindi la stessa scheda serve per il WiFi, per
 * le porte ethernet e per il tethering. Passa da applica-e-conferma come ogni
 * scrittura su `network`: cambiare il nome fa rinnovare il DHCP, e una WAN che
 * non torna su deve poter essere annullata da sola.
 *
 * Su una WAN WiFi si aggiorna anche la rete salvata corrispondente: senza,
 * alla prima riconnessione automatica travelD rimetterebbe il nome di prima e
 * la modifica sembrerebbe sparita da sola.
 */
function HostnameSheet({
  wan,
  deviceHostname,
  onClose,
}: {
  wan: DashWan;
  deviceHostname: string;
  onClose: (changed: boolean) => void;
}) {
  const actions = commonText().actions;
  const apply = useApply();
  const [choice, setChoice] = useState<HostnameChoice>(() => hostnameFromUci(wan.hostname));
  const [saved, setSaved] = useState<SavedNetwork | null>(null);
  const [done, setDone] = useState(false);

  // La voce salvata di questa rete, se c'e': serve solo per il WiFi.
  useEffect(() => {
    if (wan.kind !== 'wifi' || !wan.ssid) return;
    let cancelled = false;
    void listSaved()
      .then((list) => {
        if (!cancelled) setSaved(findSavedOn(list, wan.ssid, wan.band) ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [wan.kind, wan.ssid, wan.band]);

  const valid = choice.mode !== 'custom' || isValidHostname(choice.value.trim());

  const go = async () => {
    const ok = await apply.run(() => stageWanHostname(wan.network, choice));
    if (!ok) return;

    if (saved) {
      try {
        await updateNetwork(saved.section, {
          hostname_mode: choice.mode,
          hostname_value: choice.mode === 'custom' ? choice.value.trim() : '',
        });
      } catch {
        // La WAN e' gia' cambiata: non averlo scritto anche fra le reti
        // salvate si vede alla prossima riconnessione, non adesso.
      }
    }
    setDone(true);
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{wanTitle(wan)}</h2>

        {apply.phase === 'idle' && (
          <>
            <HostnamePicker
              choice={choice}
              deviceHostname={deviceHostname}
              onChange={setChoice}
            />

            <div class="sheet__actions">
              <button class="button button--ghost" onClick={() => onClose(false)}>
                {actions.cancel}
              </button>
              <button class="button button--primary" disabled={!valid} onClick={go}>
                {actions.save}
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


export function Dashboard({ onLogout }: { onLogout: () => void }) {
  const t = dashboardText();
  // Due secondi come previsto dal budget di polling, e il timer si ferma
  // quando la scheda non e' visibile: sul router il costo scende a zero.
  const poll = usePoll<DashboardData>(() => getDashboard(), 2000);
  // Lo stato di mwan3 cambia lentamente (il controllo gira ogni 5s) e la sua
  // lettura costa parecchi processi: ogni 10s basta.
  const mwanPoll = usePoll<Mwan>(() => getMwan(), 10000);

  if (poll.error instanceof UbusError && poll.error.isAuthError) {
    onLogout();
  }

  const data = poll.data;
  const mwan = mwanPoll.data;
  const [editingMwan, setEditingMwan] = useState(false);
  const [health, setHealth] = useState<MwanInterface | null>(null);
  const [rule, setRule] = useState<{ value: MwanRule | null } | null>(null);
  const [hostnameWan, setHostnameWan] = useState<DashWan | null>(null);
  const [cloneWan, setCloneWan] = useState<DashWan | null>(null);
  const mwanOf = (wan: DashWan): MwanInterface | null =>
    mwan?.interfaces.find((i) => i.network === wan.network) ?? null;

  if (!data) {
    return (
      <main class="screen">
        <header class="topbar">
          <h1>{t.title}</h1>
        </header>
        {poll.loading ? (
          <p class="muted">{t.loading}</p>
        ) : (
          <section class="card">
            <p class="muted">{t.noDaemon}</p>
            {poll.error && <p class="alert alert--warn alert--code">{poll.error.message}</p>}
          </section>
        )}
      </main>
    );
  }

  const overallKey = overallState(data.wans);
  const overall = { text: t.overall[overallKey], tone: OVERALL_TONE[overallKey] };
  const active = data.wans.find((w) => w.active);
  return (
    <main class="screen">
      <header class="topbar">
        <h1>{t.title}</h1>
        <button class="button button--ghost" onClick={onLogout}>
          {commonText().actions.logout}
        </button>
      </header>

      <section class={`card uplink uplink--${overall.tone}`}>
        <h2 class="uplink__title">{overall.text}</h2>
        <p class="muted">
          {active
            ? t.exitsVia(`${wanTitle(active)}${active.ssid ? ` · ${active.ssid}` : ''}`)
            : t.noActive}
        </p>
        <p class="muted">
          {t.autoreconnect(data.autoreconnect)}{' '}
          {data.portal_check === false ? t.portalOff : ''}
          {mwan === null
            ? t.mwanReading
            : !mwan.installed
              ? t.mwanMissing
              : !mwan.running
                ? t.mwanDown
                : t.mwanMode(modeLabel(mwan.mode).toLowerCase()) +
                  (activeInterfaces(mwan).length > 0
                    ? t.mwanOnline(
                        activeInterfaces(mwan)
                          .map((i) => i.network)
                          .join(', '),
                      )
                    : t.mwanNoneOnline)}
        </p>
      </section>

      {/* Un kill switch sospeso e' l'unica cosa della VPN che sta anche qui.
          Non e' duplicazione: durante una sospensione il traffico esce in
          chiaro, e chi sta guardando questa schermata sta guardando proprio
          come esce il traffico. Scoprirlo solo aprendo un'altra scheda
          sarebbe il momento sbagliato. */}
      {data.killswitch?.on && data.killswitch.resume_at > 0 && (
        <p class="alert alert--warn">
          {t.killSwitch(Math.max(0, Math.ceil((data.killswitch.resume_at - data.at) / 60)))}
        </p>
      )}

      <MwanCard mwan={mwan} onEdit={() => setEditingMwan(true)} />

      <RulesCard
        mwan={mwan}
        onAdd={() => setRule({ value: null })}
        onEdit={(r) => setRule({ value: r })}
      />

      {data.wans.map((wan) => (
        <WanCard
          key={wan.network}
          wan={wan}
          mwan={mwanOf(wan)}
          deviceHostname={data.system.hostname}
          onHealth={() => setHealth(mwanOf(wan))}
          onHostname={() => setHostnameWan(wan)}
          onClone={() => setCloneWan(wan)}
          onPortal={poll.refresh}
        />
      ))}

      <PortalMemoryCard />

      {data.wans.length === 0 && (
        <section class="card">
          <p class="muted">{t.noWans}</p>
        </section>
      )}

      {data.last_error && <p class="alert alert--warn alert--code">{data.last_error}</p>}

      {editingMwan && mwan && (
        <MwanSheet
          mwan={mwan}
          onClose={(changed) => {
            setEditingMwan(false);
            if (changed) mwanPoll.refresh();
          }}
        />
      )}

      {rule && mwan && (
        <RuleSheet
          mwan={mwan}
          rule={rule.value}
          onClose={(changed) => {
            setRule(null);
            if (changed) mwanPoll.refresh();
          }}
        />
      )}

      {cloneWan && (
        <MacCloneSheet
          wan={cloneWan}
          onClose={(changed) => {
            setCloneWan(null);
            if (changed) poll.refresh();
          }}
        />
      )}

      {hostnameWan && (
        <HostnameSheet
          wan={hostnameWan}
          deviceHostname={data.system.hostname}
          onClose={(changed) => {
            setHostnameWan(null);
            if (changed) poll.refresh();
          }}
        />
      )}

      {health && (
        <HealthSheet
          iface={health}
          onClose={(changed) => {
            setHealth(null);
            if (changed) mwanPoll.refresh();
          }}
        />
      )}
    </main>
  );
}
