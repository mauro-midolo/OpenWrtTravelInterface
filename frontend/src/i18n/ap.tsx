import { defineText } from '.';

/** L'access point (`screens/AccessPoint.tsx`). */
export const apText = defineText({
  it: {
    title: 'Access point',
    none: 'Nessun access point configurato.',
    active: 'Access point attivo',
    off: 'Access point spento',
    edit: 'Modifica',
    ssid: 'Nome rete',
    security: 'Sicurezza',
    password: 'Password',
    set: 'impostata',
    missing: 'assente',
    band: 'Banda',
    clients: 'Dispositivi collegati',
    and: ' e ',
    offOn: (bands: string) => `Spento su ${bands}.`,
    byToggle: (bands: string) => `${bands}: comandato dall’interruttore fisico.`,
    diverging: 'Le due radio hanno impostazioni diverse: salvale di nuovo per riallinearle.',
    ssidField: 'Nome della rete (SSID)',
    ssidEmpty: 'Il nome non può essere vuoto.',
    ssidTooLong: (bytes: number) => `Troppo lungo: ${bytes} byte su 32.`,
    minPassword: 'almeno 8 caratteri',
    keepPassword: 'lascia vuoto per non cambiarla',
    hide: 'Nascondi',
    show: 'Mostra',
    shortPassword: 'Servono almeno 8 caratteri.',
    credentialsWarn: (seconds: number) => (
      <>
        Cambiando nome o password <strong>tutti i dispositivi si scollegano</strong>: ricollegati
        entro {seconds} secondi, altrimenti il router torna indietro da solo.
      </>
    ),
    saved: 'Impostazioni salvate su entrambe le radio.',
  },
  en: {
    title: 'Access point',
    none: 'No access point configured.',
    active: 'Access point on',
    off: 'Access point off',
    edit: 'Edit',
    ssid: 'Network name',
    security: 'Security',
    password: 'Password',
    set: 'set',
    missing: 'not set',
    band: 'Band',
    clients: 'Connected devices',
    and: ' and ',
    offOn: (bands: string) => `Off on ${bands}.`,
    byToggle: (bands: string) => `${bands}: controlled by the physical switch.`,
    diverging: 'The two radios have different settings: save them again to align them.',
    ssidField: 'Network name (SSID)',
    ssidEmpty: 'The name cannot be empty.',
    ssidTooLong: (bytes: number) => `Too long: ${bytes} bytes out of 32.`,
    minPassword: 'at least 8 characters',
    keepPassword: 'leave empty to keep it',
    hide: 'Hide',
    show: 'Show',
    shortPassword: 'At least 8 characters are needed.',
    credentialsWarn: (seconds: number) => (
      <>
        Changing name or password <strong>disconnects every device</strong>: reconnect within{' '}
        {seconds} seconds, otherwise the router rolls back on its own.
      </>
    ),
    saved: 'Settings saved on both radios.',
  },
});
