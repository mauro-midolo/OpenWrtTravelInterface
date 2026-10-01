import { defineText } from '.';

/**
 * La scheda Impostazioni (`screens/Settings.tsx`, `screens/System.tsx`) e i
 * testi di `lib/system.ts` e `lib/profiles.ts`.
 */
export const settingsText = defineText({
  it: {
    title: 'Impostazioni',
    language: 'Lingua',
    deviceName: 'Nome del router',
    name: 'Nome',
    namePlaceholder: 'es. Beryl',
    nameRule: 'Solo lettere, cifre e trattini.',
    device: 'Dispositivo',
    rename: 'Cambia nome',
    loading: 'Caricamento…',
    noAnswer: 'Il router non ha risposto.',
    uptime: 'Acceso da',
    load: 'Carico',
    temperature: 'Temperatura',
    unavailable: 'non disponibile',
    memory: 'Memoria in uso',
    days: 'g',
    usb: {
      title: 'Porta USB',
      noFunction: (offered: string) => (
        <>
          Collegato, ma non sta offrendo nessuna funzione di rete
          {offered ? `: espone ${offered}` : ''}. Se è un telefono, attiva la{' '}
          <strong>condivisione tramite USB</strong>.
        </>
      ),
      moduleMissing: (label: string, pkg: string) => (
        <>
          Sta offrendo <strong>{label}</strong>, ma sul router manca il modulo <code>{pkg}</code>.
        </>
      ),
      moduleNotLoaded: (label: string, module: string, base: string) => (
        <>
          Sta offrendo <strong>{label}</strong> e <code>{module}</code> è sul disco, ma{' '}
          <strong>non è caricato</strong>.
          {base ? (
            <>
              {' '}
              <code>usbnet</code>, da cui dipende, è <strong>{base}</strong>.
            </>
          ) : null}
        </>
      ),
      notBound: (label: string, module: string) => (
        <>
          Sta offrendo <strong>{label}</strong> e il modulo <code>{module}</code> è caricato, ma
          non lo ha agganciato. Stacca e riattacca il cavo.
        </>
      ),
      moduleState: {
        caricato: 'caricato',
        installato: 'installato',
        assente: 'assente',
      } as Record<string, string>,
      // Le funzioni USB come le scrive il router, in inglese.
      functions: {
        'CDC data': 'dati CDC',
        'PTP (photos)': 'PTP (foto)',
        storage: 'archiviazione',
        'MTP (file transfer)': 'MTP (trasferimento file)',
        'input device': 'periferica di input',
      } as Record<string, string>,
      none: 'Nessun dispositivo collegato alla porta USB.',
      noInterface: 'nessuna interfaccia',
      wanDisabled: (driver: string, netdev: string) => (
        <>
          Il driver <strong>{driver}</strong> lo ha agganciato come <code>{netdev}</code>, ma
          l'interfaccia <code>wan_usb</code> è rimasta disattivata. Stacca e riattacca il cavo.
        </>
      ),
      speedFixed: 'Velocità della porta USB non regolabile.',
      speed: 'Velocità della porta',
      max: 'Massima disponibile',
      usb2: 'Limita a USB 2.0',
      readingPort: 'Leggo lo stato della porta…',
      controller: 'controller',
      resetUsb2: (label: string) => `${label} riavviato, porta in USB 2.0`,
      reset: (label: string) => `${label} riavviato`,
      resetting: 'Riavvio in corso…',
      resetButton: 'Riavvia la porta USB',
    },
    advanced: 'Configurazione avanzata',
    openLuci: 'Apri LuCI',
    profiles: {
      wanOrder: 'Ordine delle WAN',
      noWans: 'Nessuna WAN salvata in questo profilo.',
      priority: (priority: number) => `priorità ${priority}`,
      weight: (weight: number) => ` · peso ${weight}`,
      excluded: 'esclusa',
      confirmDelete: (name: string) => (
        <>
          Elimino <strong>{name}</strong>?
        </>
      ),
      remove: 'Elimina',
      applying: 'Applico…',
      apply: 'Applica',
      update: 'Aggiorna con lo stato di adesso',
      newProfile: 'Nuovo profilo',
      namePlaceholder: 'es. hotel',
      nameRule: 'Lettere, cifre, spazi, trattini. Fino a 24 caratteri.',
      saving: 'Salvo…',
      title: 'Profili',
      saveState: 'Salva stato',
      loading: 'Leggo i profili…',
      none: 'Nessun profilo.',
      current: 'adesso',
      noMatch: 'Nessun profilo corrisponde alla configurazione attuale.',
      summary: {
        balance: 'bilanciamento',
        failover: 'failover',
        autoreconnect: 'riconnessione automatica',
        killswitch: 'kill switch',
        noPortal: 'senza verifica portali',
        excluded: (n: number) => `${n} WAN esclus${n === 1 ? 'a' : 'e'}`,
      },
    },
    backup: {
      title: 'Backup della configurazione',
      note: 'Contiene anche le password del WiFi e le chiavi della VPN.',
      preparing: 'Preparo…',
      download: 'Scarica il backup',
      restoreFrom: 'Ripristina da un file',
      restoreWarn: (file: string) => (
        <>
          Ripristinare <strong>{file}</strong> sovrascrive tutta la configurazione e{' '}
          <strong>riavvia il router</strong>.
        </>
      ),
      restore: 'Ripristina e riavvia',
      uploading: (percent: number) => `Carico l'archivio… ${percent}%. Non chiudere la pagina.`,
      restored: 'Configurazione ripristinata: il router si sta riavviando.',
      emptyFile: 'file vuoto',
      readFailed: 'lettura del file fallita',
    },
    time: {
      title: 'Ora e fuso',
      where: 'Dove sei',
      other: 'Altro — stringa POSIX',
      tzString: 'Stringa del fuso',
      tzPlaceholder: 'es. CET-1CEST,M3.5.0,M10.5.0/3',
      sync: "Sincronizza l'ora dalla rete",
      servers: 'Server NTP, uno per riga',
      badServers: 'Serve almeno un nome valido (lettere, cifre, punti).',
      saving: 'Salvo…',
      edit: 'Modifica',
      loading: "Leggo l'ora del router…",
      routerTime: 'Ora del router',
      zone: 'Fuso',
      syncRow: 'Sincronizzazione',
      syncOff: 'spenta',
      syncOn: 'attiva',
      syncDown: 'accesa, ma il servizio non gira',
      server: 'Server',
      none: 'nessuno',
      behind: "L'orologio è indietro: finché non si sincronizza i siti in HTTPS non si aprono.",
      zones: {
        'Europe/Rome': 'Italia · Europa centrale',
        'Europe/London': 'Regno Unito · Irlanda',
        'Europe/Lisbon': 'Portogallo',
        'Europe/Athens': 'Grecia · Finlandia',
        'Europe/Moscow': 'Mosca',
        UTC: 'UTC · nessun fuso',
        'America/New_York': 'New York · costa est',
        'America/Chicago': 'Chicago',
        'America/Denver': 'Denver',
        'America/Los_Angeles': 'Los Angeles · costa ovest',
        'America/Sao_Paulo': 'San Paolo',
        'Asia/Dubai': 'Dubai',
        'Asia/Kolkata': 'India',
        'Asia/Bangkok': 'Bangkok',
        'Asia/Singapore': 'Singapore',
        'Asia/Shanghai': 'Cina',
        'Asia/Tokyo': 'Giappone',
        'Australia/Sydney': 'Sydney',
        'Australia/Perth': 'Perth',
      } as Record<string, string>,
    },
    reboot: {
      scheduled: 'Riavvio pianificato',
      when: 'Quando',
      at: 'A che ora',
      hour: 'ora',
      minutes: 'minuti',
      badTime: 'Ora fra 0 e 23, minuti fra 0 e 59.',
      saving: 'Salvo…',
      title: 'Riavvio',
      plannedFor: (when: string) => `Pianificato: ${when}.`,
      notPlanned: 'Nessun riavvio pianificato.',
      plan: 'Pianifica',
      noCron: 'Il servizio cron non sta girando: il riavvio pianificato non verrà eseguito.',
      confirm: 'Il router riparte adesso: la rete cade per un minuto o due.',
      rebooting: 'Riavvio…',
      now: 'Riavvia adesso',
      inProgress: 'Il router si sta riavviando…',
      days: {
        '*': 'ogni giorno',
        '1': 'lunedì',
        '2': 'martedì',
        '3': 'mercoledì',
        '4': 'giovedì',
        '5': 'venerdì',
        '6': 'sabato',
        '0': 'domenica',
      } as Record<string, string>,
      dayAt: (day: string, time: string) => `${day} alle ${time}`,
    },
  },
  en: {
    title: 'Settings',
    language: 'Language',
    deviceName: 'Router name',
    name: 'Name',
    namePlaceholder: 'e.g. Beryl',
    nameRule: 'Letters, digits and hyphens only.',
    device: 'Device',
    rename: 'Rename',
    loading: 'Loading…',
    noAnswer: 'The router did not answer.',
    uptime: 'Up for',
    load: 'Load',
    temperature: 'Temperature',
    unavailable: 'not available',
    memory: 'Memory in use',
    days: 'd',
    usb: {
      title: 'USB port',
      noFunction: (offered: string) => (
        <>
          Connected, but it offers no network function
          {offered ? `: it exposes ${offered}` : ''}. If it is a phone, turn on{' '}
          <strong>USB tethering</strong>.
        </>
      ),
      moduleMissing: (label: string, pkg: string) => (
        <>
          It offers <strong>{label}</strong>, but the router is missing the <code>{pkg}</code>{' '}
          module.
        </>
      ),
      moduleNotLoaded: (label: string, module: string, base: string) => (
        <>
          It offers <strong>{label}</strong> and <code>{module}</code> is on disk, but it{' '}
          <strong>is not loaded</strong>.
          {base ? (
            <>
              {' '}
              <code>usbnet</code>, which it depends on, is <strong>{base}</strong>.
            </>
          ) : null}
        </>
      ),
      notBound: (label: string, module: string) => (
        <>
          It offers <strong>{label}</strong> and the <code>{module}</code> module is loaded, but it
          did not bind to it. Unplug and plug the cable back in.
        </>
      ),
      moduleState: {
        caricato: 'loaded',
        installato: 'installed',
        assente: 'missing',
      },
      // In inglese sono gia' giuste.
      functions: {
        'CDC data': 'CDC data',
        'PTP (photos)': 'PTP (photos)',
        storage: 'storage',
        'MTP (file transfer)': 'MTP (file transfer)',
        'input device': 'input device',
      },
      none: 'No device connected to the USB port.',
      noInterface: 'no interface',
      wanDisabled: (driver: string, netdev: string) => (
        <>
          The <strong>{driver}</strong> driver bound it as <code>{netdev}</code>, but the{' '}
          <code>wan_usb</code> interface stayed disabled. Unplug and plug the cable back in.
        </>
      ),
      speedFixed: 'USB port speed cannot be adjusted.',
      speed: 'Port speed',
      max: 'Maximum available',
      usb2: 'Limit to USB 2.0',
      readingPort: 'Reading the port state…',
      controller: 'controller',
      resetUsb2: (label: string) => `${label} restarted, port in USB 2.0`,
      reset: (label: string) => `${label} restarted`,
      resetting: 'Restarting…',
      resetButton: 'Restart the USB port',
    },
    advanced: 'Advanced configuration',
    openLuci: 'Open LuCI',
    profiles: {
      wanOrder: 'WAN order',
      noWans: 'No WAN saved in this profile.',
      priority: (priority: number) => `priority ${priority}`,
      weight: (weight: number) => ` · weight ${weight}`,
      excluded: 'excluded',
      confirmDelete: (name: string) => (
        <>
          Delete <strong>{name}</strong>?
        </>
      ),
      remove: 'Delete',
      applying: 'Applying…',
      apply: 'Apply',
      update: 'Update with the current state',
      newProfile: 'New profile',
      namePlaceholder: 'e.g. hotel',
      nameRule: 'Letters, digits, spaces, hyphens. Up to 24 characters.',
      saving: 'Saving…',
      title: 'Profiles',
      saveState: 'Save state',
      loading: 'Reading profiles…',
      none: 'No profiles.',
      current: 'now',
      noMatch: 'No profile matches the current configuration.',
      summary: {
        balance: 'load balancing',
        failover: 'failover',
        autoreconnect: 'auto-reconnect',
        killswitch: 'kill switch',
        noPortal: 'no portal check',
        excluded: (n: number) => `${n} WAN${n === 1 ? '' : 's'} excluded`,
      },
    },
    backup: {
      title: 'Configuration backup',
      note: 'It also contains the WiFi passwords and the VPN keys.',
      preparing: 'Preparing…',
      download: 'Download the backup',
      restoreFrom: 'Restore from a file',
      restoreWarn: (file: string) => (
        <>
          Restoring <strong>{file}</strong> overwrites the whole configuration and{' '}
          <strong>reboots the router</strong>.
        </>
      ),
      restore: 'Restore and reboot',
      uploading: (percent: number) => `Uploading the archive… ${percent}%. Do not close the page.`,
      restored: 'Configuration restored: the router is rebooting.',
      emptyFile: 'empty file',
      readFailed: 'could not read the file',
    },
    time: {
      title: 'Time and time zone',
      where: 'Where you are',
      other: 'Other — POSIX string',
      tzString: 'Time zone string',
      tzPlaceholder: 'e.g. CET-1CEST,M3.5.0,M10.5.0/3',
      sync: 'Sync the time from the network',
      servers: 'NTP servers, one per line',
      badServers: 'At least one valid name is needed (letters, digits, dots).',
      saving: 'Saving…',
      edit: 'Edit',
      loading: 'Reading the router time…',
      routerTime: 'Router time',
      zone: 'Time zone',
      syncRow: 'Synchronization',
      syncOff: 'off',
      syncOn: 'on',
      syncDown: 'on, but the service is not running',
      server: 'Servers',
      none: 'none',
      behind: 'The clock is behind: until it syncs, HTTPS sites will not open.',
      zones: {
        'Europe/Rome': 'Italy · Central Europe',
        'Europe/London': 'United Kingdom · Ireland',
        'Europe/Lisbon': 'Portugal',
        'Europe/Athens': 'Greece · Finland',
        'Europe/Moscow': 'Moscow',
        UTC: 'UTC · no time zone',
        'America/New_York': 'New York · East Coast',
        'America/Chicago': 'Chicago',
        'America/Denver': 'Denver',
        'America/Los_Angeles': 'Los Angeles · West Coast',
        'America/Sao_Paulo': 'São Paulo',
        'Asia/Dubai': 'Dubai',
        'Asia/Kolkata': 'India',
        'Asia/Bangkok': 'Bangkok',
        'Asia/Singapore': 'Singapore',
        'Asia/Shanghai': 'China',
        'Asia/Tokyo': 'Japan',
        'Australia/Sydney': 'Sydney',
        'Australia/Perth': 'Perth',
      },
    },
    reboot: {
      scheduled: 'Scheduled reboot',
      when: 'When',
      at: 'At what time',
      hour: 'hour',
      minutes: 'minutes',
      badTime: 'Hour between 0 and 23, minutes between 0 and 59.',
      saving: 'Saving…',
      title: 'Reboot',
      plannedFor: (when: string) => `Scheduled: ${when}.`,
      notPlanned: 'No scheduled reboot.',
      plan: 'Schedule',
      noCron: 'The cron service is not running: the scheduled reboot will not happen.',
      confirm: 'The router restarts now: the network drops for a minute or two.',
      rebooting: 'Rebooting…',
      now: 'Reboot now',
      inProgress: 'The router is rebooting…',
      days: {
        '*': 'every day',
        '1': 'Monday',
        '2': 'Tuesday',
        '3': 'Wednesday',
        '4': 'Thursday',
        '5': 'Friday',
        '6': 'Saturday',
        '0': 'Sunday',
      },
      dayAt: (day: string, time: string) => `${day} at ${time}`,
    },
  },
});
