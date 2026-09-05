import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  applyProfile,
  deleteProfile,
  listProfiles,
  profileSummary,
  saveProfile,
} from '../lib/profiles';
import type { Profile, ProfileList } from '../lib/profiles';
import {
  DEFAULT_NTP,
  WEEKDAYS,
  ZONES,
  downloadBackup,
  exportBackup,
  fileToBase64,
  getReboot,
  getTime,
  importBackup,
  rebootNow,
  scheduleLabel,
  setReboot,
  setTime,
} from '../lib/system';
import type { RebootSchedule, TimeState } from '../lib/system';
import { formatBytes } from '../lib/dashboard';
import { wanLabel } from './MultiWan';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div class="row">
      <span class="row__label">{label}</span>
      <span class="row__value">{value}</span>
    </div>
  );
}

/**
 * Profili (requisito H).
 *
 * Sta in cima a Impostazioni perche' e' la scheda che risponde alla domanda
 * "come deve comportarsi il router qui", che e' la prima che ci si fa quando si
 * arriva in un posto nuovo - prima ancora del nome del router o della porta USB.
 *
 * Applicare un profilo non passa da applica-e-conferma, e non e' una
 * dimenticanza: un profilo non tocca niente da cui si entra nel router
 * (indirizzo della LAN, access point, ruolo delle porte), quindi non puo'
 * chiudere fuori nessuno. E' il motivo per cui puo' essere un pulsante solo.
 */
function ProfileSheet({
  profile,
  onClose,
}: {
  profile: Profile;
  onClose: (changed: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const run = async (what: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await what();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>{profile.name}</h2>
        <p class="muted">{profileSummary(profile)}</p>

        <h2>Ordine delle WAN</h2>
        {profile.wans.length === 0 ? (
          <p class="muted">Nessuna WAN salvata in questo profilo.</p>
        ) : (
          [...profile.wans]
            .sort((a, b) => a.priority - b.priority)
            .map((wan) => (
              <Row
                key={wan.network}
                label={wanLabel(wan.network)}
                value={
                  wan.enabled
                    ? `priorità ${wan.priority}${profile.mode === 'balance' ? ` · peso ${wan.weight}` : ''}`
                    : 'esclusa'
                }
              />
            ))
        )}

        {note && <p class="alert alert--warn">{note}</p>}
        {error && <p class="alert alert--error alert--code">{error}</p>}

        {confirmDelete ? (
          <>
            <p class="alert alert--warn">
              Elimino <strong>{profile.name}</strong>? La configurazione attuale del router
              non cambia: sparisce solo il profilo.
            </p>
            <div class="sheet__actions">
              <button
                class="button button--ghost"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
              >
                Annulla
              </button>
              <button
                class="button button--primary"
                disabled={busy}
                onClick={() => run(async () => {
                  await deleteProfile(profile.section);
                  onClose(true);
                })}
              >
                Elimina
              </button>
            </div>
          </>
        ) : (
          <>
            <div class="sheet__actions">
              <button class="button button--ghost" disabled={busy} onClick={() => onClose(false)}>
                Chiudi
              </button>
              <button
                class="button button--ghost"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                Elimina
              </button>
              <button
                class="button button--primary"
                disabled={busy}
                onClick={() => run(async () => {
                  const result = await applyProfile(profile.section);
                  if (result) {
                    // Il router ha corretto qualcosa: si resta aperti a
                    // mostrarlo, invece di chiudere su una modifica che non e'
                    // andata come il profilo diceva.
                    setNote(result);
                    setBusy(false);
                  } else {
                    onClose(true);
                  }
                })}
              >
                {busy ? 'Applico…' : 'Applica'}
              </button>
            </div>

            <button
              class="button button--ghost"
              disabled={busy}
              onClick={() => run(async () => {
                await saveProfile(profile.name, profile.section);
                onClose(true);
              })}
            >
              Aggiorna con lo stato di adesso
            </button>
            <p class="muted">
              Sovrascrive i valori salvati con quelli attivi in questo momento, tenendo il
              nome.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function ProfileSaveSheet({ onClose }: { onClose: (changed: boolean) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = /^[A-Za-z0-9 _-]{1,24}$/.test(name.trim());

  const save = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await saveProfile(name.trim());
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>Nuovo profilo</h2>
        <form onSubmit={save}>
          <p class="muted">
            Salva com'è messo il router adesso: modalità multi-WAN, ordine e pesi delle WAN,
            riconnessione automatica, verifica dei portali, kill switch.
          </p>

          <label class="field">
            <span>Nome</span>
            <input
              type="text"
              value={name}
              placeholder="es. hotel"
              autocomplete="off"
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
            <span class="muted">Lettere, cifre, spazi, trattini. Fino a 24 caratteri.</span>
          </label>

          {error && <p class="alert alert--error alert--code">{error}</p>}

          <div class="sheet__actions">
            <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
              Annulla
            </button>
            <button class="button button--primary" type="submit" disabled={busy || !valid}>
              {busy ? 'Salvo…' : 'Salva'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ProfilesCard() {
  const [data, setData] = useState<ProfileList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Profile | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    listProfiles()
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(load, [load]);

  return (
    <section class="card">
      <header class="radio__head">
        <div>
          <h2 class="uplink__title">Profili</h2>
          <p class="muted">Come deve comportarsi il router in un posto.</p>
        </div>
        <button class="button button--ghost" onClick={() => setSaving(true)}>
          Salva stato
        </button>
      </header>

      {error && <p class="alert alert--error alert--code">{error}</p>}
      {!data && !error && <p class="muted">Leggo i profili…</p>}

      {data && data.profiles.length === 0 && (
        <p class="muted">
          Nessun profilo. “Salva stato” mette da parte com'è messo il router adesso, e da lì
          ci si torna con un tocco: <em>hotel</em> con il tethering escluso e il kill switch
          acceso, <em>casa</em> con il bilanciamento e la riconnessione automatica.
        </p>
      )}

      {data?.profiles.map((profile) => (
        <button key={profile.section} class="net" onClick={() => setOpen(profile)}>
          <span class="net__main">
            <span class="net__ssid">{profile.name}</span>
            <span class="net__meta">{profileSummary(profile)}</span>
          </span>
          {/* Quale profilo e' quello di adesso lo decide il router confrontando
              i valori: senza, un profilo resterebbe evidenziato anche dopo aver
              cambiato una cosa a mano. */}
          {data.current === profile.section && <span class="badge badge--ok">adesso</span>}
        </button>
      ))}

      {data && data.profiles.length > 0 && !data.current && (
        <p class="muted">
          Nessun profilo corrisponde alla configurazione di adesso: qualcosa è stato
          cambiato a mano dopo averne applicato uno.
        </p>
      )}

      {data && data.profiles.length > 0 && (
        <p class="muted">
          Un profilo non tocca l'indirizzo della LAN, gli access point né il ruolo delle
          porte: sono le cose da cui si <strong>entra</strong> nel router, e applicarne uno
          non deve poterti chiudere fuori.
        </p>
      )}

      {open && (
        <ProfileSheet
          profile={open}
          onClose={(changed) => {
            setOpen(null);
            if (changed) load();
          }}
        />
      )}

      {saving && (
        <ProfileSaveSheet
          onClose={(changed) => {
            setSaving(false);
            if (changed) load();
          }}
        />
      )}
    </section>
  );
}

/**
 * Backup (requisito H).
 *
 * E' il backup vero di OpenWrt - lo stesso archivio che fa LuCI - e non un
 * formato nostro: un formato che solo questa interfaccia sa rimettere sarebbe
 * inutile proprio nel giorno in cui serve, cioe' quando questa interfaccia non
 * parte.
 *
 * Passa dentro le risposte ubus in base64, perche' /ubus e' l'unico canale che
 * c'e': non esiste un secondo endpoint da cui scaricare un file.
 */
export function BackupCard() {
  const [busy, setBusy] = useState<null | 'export' | 'import'>(null);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<File | null>(null);

  const save = async () => {
    setBusy('export');
    setError(null);
    setDone(null);
    try {
      const backup = await exportBackup();
      downloadBackup(backup);
      setDone(`${backup.name} · ${formatBytes(backup.size)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    if (!pending) return;
    setBusy('import');
    setError(null);
    setDone(null);
    try {
      const base64 = await fileToBase64(pending);
      await importBackup(base64, (sent, total) => setProgress(Math.round((sent / total) * 100)));
      setPending(null);
      setDone('Configurazione ripristinata: il router si sta riavviando.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setProgress(0);
    }
  };

  return (
    <section class="card">
      <h2 class="uplink__title">Backup della configurazione</h2>
      <p class="muted">
        L'archivio standard di OpenWrt: contiene tutto <code>/etc/config</code>, quindi
        anche le password del WiFi e le chiavi della VPN. Tienilo come terresti quelle.
      </p>

      <button class="button button--ghost" disabled={busy !== null} onClick={save}>
        {busy === 'export' ? 'Preparo…' : 'Scarica il backup'}
      </button>

      <div class="field">
        <span>Ripristina da un file</span>
        <input
          type="file"
          accept=".tar.gz,.gz,application/gzip"
          disabled={busy !== null}
          onChange={(e) => {
            const files = (e.target as HTMLInputElement).files;
            setPending(files && files.length > 0 ? files[0] : null);
            setDone(null);
            setError(null);
          }}
        />
      </div>

      {pending && busy === null && (
        <>
          <p class="alert alert--warn">
            Ripristinare <strong>{pending.name}</strong> sovrascrive tutta la configurazione
            e <strong>riavvia il router</strong>. Se il backup viene da un altro dispositivo
            o da un'altra versione di OpenWrt, il router può tornare su con una rete diversa
            da quella che stai usando adesso: tieni a portata di mano il cavo e la procedura
            di recupero che hai salvato sul telefono.
          </p>
          <div class="sheet__actions">
            <button class="button button--ghost" onClick={() => setPending(null)}>
              Annulla
            </button>
            <button class="button button--primary" onClick={restore}>
              Ripristina e riavvia
            </button>
          </div>
        </>
      )}

      {busy === 'import' && (
        <p class="muted">
          Carico l'archivio… {progress}%. Non chiudere la pagina: il file sale a pezzi, e
          uno che manca lo rende inutilizzabile.
        </p>
      )}

      {done && <p class="alert alert--ok">{done}</p>}
      {error && <p class="alert alert--error alert--code">{error}</p>}
    </section>
  );
}

/**
 * Orologio (Fase 8).
 *
 * Su questo router non c'e' un orologio a batteria: staccata la corrente, l'ora
 * riparte da quella del firmware. Con l'orologio indietro di mesi ogni
 * certificato HTTPS risulta non ancora valido, quindi non si apre niente - e la
 * spiegazione che viene in mente e' "la rete dell'albergo non funziona".
 *
 * E' anche il motivo per cui il fuso sta qui accanto ai server: quando l'ora
 * non torna si vuole vedere tutte e tre le cose insieme, non cercarle in tre
 * posti.
 */
function TimeSheet({ time, onClose }: { time: TimeState; onClose: (changed: boolean) => void }) {
  const known = ZONES.find((z) => z.tz === time.timezone);
  const [zone, setZone] = useState(known ? known.name : 'custom');
  const [custom, setCustom] = useState(known ? '' : time.timezone);
  const [servers, setServers] = useState((time.servers.length ? time.servers : DEFAULT_NTP).join('\n'));
  const [enabled, setEnabled] = useState(time.ntp_enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = servers
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const serversOk = list.length > 0 && list.every((s) => /^[A-Za-z0-9.-]{1,64}$/.test(s));
  const tzOk = zone !== 'custom' || custom.trim().length > 0;

  const save = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const picked = ZONES.find((z) => z.name === zone);
      await setTime({
        timezone: picked ? picked.tz : custom.trim(),
        zonename: picked ? picked.name : '',
        servers: list,
        enabled,
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
        <h2>Ora e fuso</h2>

        <form onSubmit={save}>
          <label class="field">
            <span>Dove sei</span>
            <select value={zone} onChange={(e) => setZone((e.target as HTMLSelectElement).value)}>
              {ZONES.map((z) => (
                <option key={z.name} value={z.name}>
                  {z.label}
                </option>
              ))}
              <option value="custom">Altro — stringa POSIX</option>
            </select>
            <span class="muted">
              L'elenco è corto di proposito: il database completo dei fusi non è installato
              su questo router, e la stringa POSIX è quella che il sistema usa comunque.
            </span>
          </label>

          {zone === 'custom' && (
            <label class="field">
              <span>Stringa del fuso</span>
              <input
                type="text"
                value={custom}
                placeholder="es. CET-1CEST,M3.5.0,M10.5.0/3"
                autocapitalize="none"
                autocomplete="off"
                spellcheck={false}
                onInput={(e) => setCustom((e.target as HTMLInputElement).value)}
              />
            </label>
          )}

          <label class="check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled((e.target as HTMLInputElement).checked)}
            />
            <span>
              Sincronizza l'ora dalla rete. Senza, e senza orologio a batteria, il router
              resta all'ora del firmware: l'HTTPS smette di funzionare.
            </span>
          </label>

          <label class="field">
            <span>Server NTP, uno per riga</span>
            <textarea
              rows={4}
              value={servers}
              autocapitalize="none"
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => setServers((e.target as HTMLTextAreaElement).value)}
            />
            {!serversOk && (
              <span class="muted">Serve almeno un nome valido (lettere, cifre, punti).</span>
            )}
          </label>

          {error && <p class="alert alert--error alert--code">{error}</p>}

          <div class="sheet__actions">
            <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
              Annulla
            </button>
            <button
              class="button button--primary"
              type="submit"
              disabled={busy || !serversOk || !tzOk}
            >
              {busy ? 'Salvo…' : 'Salva'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function TimeCard() {
  const [time, setTimeState] = useState<TimeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    getTime()
      .then((result) => {
        setTimeState(result);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(load, [load]);

  const zone = time ? ZONES.find((z) => z.tz === time.timezone) : undefined;

  return (
    <section class="card">
      <header class="radio__head">
        <div>
          <h2 class="uplink__title">Ora e fuso</h2>
          <p class="muted">Serve più di quanto sembri: l'HTTPS dipende dall'orologio.</p>
        </div>
        <button class="button button--ghost" onClick={() => setEditing(true)} disabled={!time}>
          Modifica
        </button>
      </header>

      {error && <p class="alert alert--error alert--code">{error}</p>}
      {!time && !error && <p class="muted">Leggo l'ora del router…</p>}

      {time && (
        <>
          <Row label="Ora del router" value={time.local} />
          <Row label="Fuso" value={zone ? zone.label : time.zonename || time.timezone || '—'} />
          <Row
            label="Sincronizzazione"
            value={
              !time.ntp_enabled
                ? 'spenta'
                : time.ntpd_running
                  ? 'attiva'
                  : 'accesa, ma il servizio non gira'
            }
          />
          <Row label="Server" value={time.servers.length ? String(time.servers.length) : 'nessuno'} />

          {/* "Plausibile" e non "sincronizzata": nessuno qui ha parlato con un
              server NTP: si sta solo guardando se l'ora e' un numero possibile.
              Affermare una sincronizzazione non misurata sarebbe l'errore che
              questo progetto evita altrove. */}
          {!time.plausible && (
            <p class="alert alert--warn">
              L'orologio è indietro di parecchio: finché non si sincronizza, i siti in HTTPS
              non si aprono e sembra un guasto della rete. Serve una connessione che esca
              davvero — se sei dietro un captive portal, prima il login.
            </p>
          )}

          {!time.rtc && (
            <p class="muted">
              Questo router non ha un orologio a batteria: a ogni distacco di corrente
              riparte dall'ora del firmware e la recupera solo dalla rete.
            </p>
          )}
        </>
      )}

      {editing && time && (
        <TimeSheet
          time={time}
          onClose={(changed) => {
            setEditing(false);
            if (changed) load();
          }}
        />
      )}
    </section>
  );
}

/**
 * Riavvio, subito o a un'ora (Fase 8).
 *
 * Il riavvio pianificato non e' manutenzione preventiva generica: e' il rimedio
 * a guasti che questo progetto ha gia' incontrato - una WAN che non torna su, il
 * driver dell'hub USB che si arrende. Un router acceso per settimane in valigia
 * li accumula, e riavviarlo di notte li toglie prima che si notino.
 */
function RebootSheet({
  schedule,
  onClose,
}: {
  schedule: RebootSchedule;
  onClose: (changed: boolean) => void;
}) {
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [hour, setHour] = useState(String(schedule.hour));
  const [minute, setMinute] = useState(String(schedule.minute));
  const [weekday, setWeekday] = useState(schedule.weekday);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hourOk = /^\d{1,2}$/.test(hour) && Number(hour) <= 23;
  const minuteOk = /^\d{1,2}$/.test(minute) && Number(minute) <= 59;

  const save = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await setReboot({ enabled, hour: Number(hour), minute: Number(minute), weekday });
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet__panel card">
        <h2>Riavvio pianificato</h2>

        <form onSubmit={save}>
          <label class="check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled((e.target as HTMLInputElement).checked)}
            />
            <span>Riavvia il router da solo, all'ora scelta.</span>
          </label>

          <label class="field">
            <span>Quando</span>
            <select value={weekday} onChange={(e) => setWeekday((e.target as HTMLSelectElement).value)}>
              {WEEKDAYS.map((day) => (
                <option key={day.value} value={day.value}>
                  {day.label}
                </option>
              ))}
            </select>
          </label>

          <div class="field">
            <span>A che ora</span>
            <div class="range">
              <input
                type="text"
                class="range__box"
                value={hour}
                inputMode="numeric"
                aria-label="ora"
                onInput={(e) => setHour((e.target as HTMLInputElement).value)}
              />
              <span class="range__label">:</span>
              <input
                type="text"
                class="range__box"
                value={minute}
                inputMode="numeric"
                aria-label="minuti"
                onInput={(e) => setMinute((e.target as HTMLInputElement).value)}
              />
            </div>
            {(!hourOk || !minuteOk) && (
              <span class="muted">Ora fra 0 e 23, minuti fra 0 e 59.</span>
            )}
          </div>

          <p class="muted">
            L'ora è quella del router: se il fuso è sbagliato, il riavvio cade a un'ora
            diversa da quella che hai in mente.
          </p>

          {error && <p class="alert alert--error alert--code">{error}</p>}

          <div class="sheet__actions">
            <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
              Annulla
            </button>
            <button
              class="button button--primary"
              type="submit"
              disabled={busy || !hourOk || !minuteOk}
            >
              {busy ? 'Salvo…' : 'Salva'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function RebootCard() {
  const [schedule, setSchedule] = useState<RebootSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [going, setGoing] = useState(false);

  const load = useCallback(() => {
    getReboot()
      .then((result) => {
        setSchedule(result);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(load, [load]);

  return (
    <section class="card">
      <header class="radio__head">
        <div>
          <h2 class="uplink__title">Riavvio</h2>
          <p class="muted">
            {schedule?.enabled
              ? `Pianificato: ${scheduleLabel(schedule)}.`
              : 'Nessun riavvio pianificato.'}
          </p>
        </div>
        <button class="button button--ghost" onClick={() => setEditing(true)} disabled={!schedule}>
          Pianifica
        </button>
      </header>

      {error && <p class="alert alert--error alert--code">{error}</p>}

      {/* Una riga scritta e non applicata sarebbe il caso peggiore: la scheda
          direbbe "riavvia ogni notte" e non riavvierebbe mai. */}
      {schedule?.enabled && !schedule.cron_running && (
        <p class="alert alert--warn">
          Il servizio cron non sta girando: la pianificazione è scritta ma non verrà
          eseguita.
        </p>
      )}

      {confirm ? (
        <>
          <p class="alert alert--warn">
            Il router riparte adesso: la rete cade per un minuto o due, e questa pagina si
            ricarica da sola quando torna.
          </p>
          <div class="sheet__actions">
            <button class="button button--ghost" onClick={() => setConfirm(false)}>
              Annulla
            </button>
            <button
              class="button button--primary"
              disabled={going}
              onClick={async () => {
                setGoing(true);
                try {
                  await rebootNow();
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                  setGoing(false);
                  setConfirm(false);
                }
              }}
            >
              {going ? 'Riavvio…' : 'Riavvia adesso'}
            </button>
          </div>
        </>
      ) : (
        <button class="button button--ghost" onClick={() => setConfirm(true)}>
          Riavvia adesso
        </button>
      )}

      {going && (
        <p class="muted">
          Il router si sta riavviando. Se non torna in un paio di minuti, controlla di
          essere ancora collegato al suo WiFi.
        </p>
      )}

      {editing && schedule && (
        <RebootSheet
          schedule={schedule}
          onClose={(changed) => {
            setEditing(false);
            if (changed) load();
          }}
        />
      )}
    </section>
  );
}
