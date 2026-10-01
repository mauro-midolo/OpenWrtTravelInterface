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
import { commonText } from '../i18n/common';
import { settingsText } from '../i18n/settings';

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
  const t = settingsText().profiles;
  const actions = commonText().actions;
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

        <h2>{t.wanOrder}</h2>
        {profile.wans.length === 0 ? (
          <p class="muted">{t.noWans}</p>
        ) : (
          [...profile.wans]
            .sort((a, b) => a.priority - b.priority)
            .map((wan) => (
              <Row
                key={wan.network}
                label={wanLabel(wan.network)}
                value={
                  wan.enabled
                    ? `${t.priority(wan.priority)}${profile.mode === 'balance' ? t.weight(wan.weight) : ''}`
                    : t.excluded
                }
              />
            ))
        )}

        {note && <p class="alert alert--warn">{note}</p>}
        {error && <p class="alert alert--error alert--code">{error}</p>}

        {confirmDelete ? (
          <>
            <p class="alert alert--warn">{t.confirmDelete(profile.name)}</p>
            <div class="sheet__actions">
              <button
                class="button button--ghost"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
              >
                {actions.cancel}
              </button>
              <button
                class="button button--primary"
                disabled={busy}
                onClick={() => run(async () => {
                  await deleteProfile(profile.section);
                  onClose(true);
                })}
              >
                {t.remove}
              </button>
            </div>
          </>
        ) : (
          <>
            <div class="sheet__actions">
              <button class="button button--ghost" disabled={busy} onClick={() => onClose(false)}>
                {actions.close}
              </button>
              <button
                class="button button--ghost"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                {t.remove}
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
                {busy ? t.applying : t.apply}
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
              {t.update}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ProfileSaveSheet({ onClose }: { onClose: (changed: boolean) => void }) {
  const t = settingsText();
  const actions = commonText().actions;
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
        <h2>{t.profiles.newProfile}</h2>
        <form onSubmit={save}>
          <label class="field">
            <span>{t.name}</span>
            <input
              type="text"
              value={name}
              placeholder={t.profiles.namePlaceholder}
              autocomplete="off"
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
            {name.trim() !== '' && !valid && (
              <span class="muted">{t.profiles.nameRule}</span>
            )}
          </label>

          {error && <p class="alert alert--error alert--code">{error}</p>}

          <div class="sheet__actions">
            <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
              {actions.cancel}
            </button>
            <button class="button button--primary" type="submit" disabled={busy || !valid}>
              {busy ? t.profiles.saving : actions.save}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ProfilesCard() {
  const t = settingsText().profiles;
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
        <h2 class="uplink__title">{t.title}</h2>
        <button class="button button--ghost" onClick={() => setSaving(true)}>
          {t.saveState}
        </button>
      </header>

      {error && <p class="alert alert--error alert--code">{error}</p>}
      {!data && !error && <p class="muted">{t.loading}</p>}

      {data && data.profiles.length === 0 && (
        <p class="muted">{t.none}</p>
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
          {data.current === profile.section && <span class="badge badge--ok">{t.current}</span>}
        </button>
      ))}

      {data && data.profiles.length > 0 && !data.current && (
        <p class="muted">{t.noMatch}</p>
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
  const t = settingsText().backup;
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
      setDone(t.restored);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setProgress(0);
    }
  };

  return (
    <section class="card">
      <h2 class="uplink__title">{t.title}</h2>
      <p class="muted">{t.note}</p>

      <button class="button button--ghost" disabled={busy !== null} onClick={save}>
        {busy === 'export' ? t.preparing : t.download}
      </button>

      <div class="field">
        <span>{t.restoreFrom}</span>
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
          <p class="alert alert--warn">{t.restoreWarn(pending.name)}</p>
          <div class="sheet__actions">
            <button class="button button--ghost" onClick={() => setPending(null)}>
              {commonText().actions.cancel}
            </button>
            <button class="button button--primary" onClick={restore}>
              {t.restore}
            </button>
          </div>
        </>
      )}

      {busy === 'import' && (
        <p class="muted">{t.uploading(progress)}</p>
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
  const t = settingsText().time;
  const actions = commonText().actions;
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
        <h2>{t.title}</h2>

        <form onSubmit={save}>
          <label class="field">
            <span>{t.where}</span>
            <select value={zone} onChange={(e) => setZone((e.target as HTMLSelectElement).value)}>
              {ZONES.map((z) => (
                <option key={z.name} value={z.name}>
                  {z.label}
                </option>
              ))}
              <option value="custom">{t.other}</option>
            </select>
          </label>

          {zone === 'custom' && (
            <label class="field">
              <span>{t.tzString}</span>
              <input
                type="text"
                value={custom}
                placeholder={t.tzPlaceholder}
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
            <span>{t.sync}</span>
          </label>

          <label class="field">
            <span>{t.servers}</span>
            <textarea
              rows={4}
              value={servers}
              autocapitalize="none"
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => setServers((e.target as HTMLTextAreaElement).value)}
            />
            {!serversOk && (
              <span class="muted">{t.badServers}</span>
            )}
          </label>

          {error && <p class="alert alert--error alert--code">{error}</p>}

          <div class="sheet__actions">
            <button class="button button--ghost" type="button" onClick={() => onClose(false)}>
              {actions.cancel}
            </button>
            <button
              class="button button--primary"
              type="submit"
              disabled={busy || !serversOk || !tzOk}
            >
              {busy ? t.saving : actions.save}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function TimeCard() {
  const t = settingsText().time;
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
        <h2 class="uplink__title">{t.title}</h2>
        <button class="button button--ghost" onClick={() => setEditing(true)} disabled={!time}>
          {t.edit}
        </button>
      </header>

      {error && <p class="alert alert--error alert--code">{error}</p>}
      {!time && !error && <p class="muted">{t.loading}</p>}

      {time && (
        <>
          <Row label={t.routerTime} value={time.local} />
          <Row label={t.zone} value={zone ? zone.label : time.zonename || time.timezone || '—'} />
          <Row
            label={t.syncRow}
            value={!time.ntp_enabled ? t.syncOff : time.ntpd_running ? t.syncOn : t.syncDown}
          />
          <Row label={t.server} value={time.servers.length ? String(time.servers.length) : t.none} />

          {/* "Plausibile" e non "sincronizzata": nessuno qui ha parlato con un
              server NTP: si sta solo guardando se l'ora e' un numero possibile.
              Affermare una sincronizzazione non misurata sarebbe l'errore che
              questo progetto evita altrove. */}
          {!time.plausible && (
            <p class="alert alert--warn">{t.behind}</p>
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
  const t = settingsText().reboot;
  const actions = commonText().actions;
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
        <h2>{t.scheduled}</h2>

        <form onSubmit={save}>
          <label class="check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled((e.target as HTMLInputElement).checked)}
            />
            <span>{t.scheduled}</span>
          </label>

          <label class="field">
            <span>{t.when}</span>
            <select value={weekday} onChange={(e) => setWeekday((e.target as HTMLSelectElement).value)}>
              {WEEKDAYS.map((day) => (
                <option key={day.value} value={day.value}>
                  {day.label}
                </option>
              ))}
            </select>
          </label>

          <div class="field">
            <span>{t.at}</span>
            <div class="range">
              <input
                type="text"
                class="range__box"
                value={hour}
                inputMode="numeric"
                aria-label={t.hour}
                onInput={(e) => setHour((e.target as HTMLInputElement).value)}
              />
              <span class="range__label">:</span>
              <input
                type="text"
                class="range__box"
                value={minute}
                inputMode="numeric"
                aria-label={t.minutes}
                onInput={(e) => setMinute((e.target as HTMLInputElement).value)}
              />
            </div>
            {(!hourOk || !minuteOk) && (
              <span class="muted">{t.badTime}</span>
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
              disabled={busy || !hourOk || !minuteOk}
            >
              {busy ? t.saving : actions.save}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function RebootCard() {
  const t = settingsText().reboot;
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
          <h2 class="uplink__title">{t.title}</h2>
          <p class="muted">
            {schedule?.enabled
              ? t.plannedFor(scheduleLabel(schedule))
              : t.notPlanned}
          </p>
        </div>
        <button class="button button--ghost" onClick={() => setEditing(true)} disabled={!schedule}>
          {t.plan}
        </button>
      </header>

      {error && <p class="alert alert--error alert--code">{error}</p>}

      {/* Una riga scritta e non applicata sarebbe il caso peggiore: la scheda
          direbbe "riavvia ogni notte" e non riavvierebbe mai. */}
      {schedule?.enabled && !schedule.cron_running && (
        <p class="alert alert--warn">{t.noCron}</p>
      )}

      {confirm ? (
        <>
          <p class="alert alert--warn">{t.confirm}</p>
          <div class="sheet__actions">
            <button class="button button--ghost" onClick={() => setConfirm(false)}>
              {commonText().actions.cancel}
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
              {going ? t.rebooting : t.now}
            </button>
          </div>
        </>
      ) : (
        <button class="button button--ghost" onClick={() => setConfirm(true)}>
          {t.now}
        </button>
      )}

      {going && (
        <p class="muted">{t.inProgress}</p>
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
