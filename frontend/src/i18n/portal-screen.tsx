import { defineText } from '.';

/** I pannelli del captive portal (`screens/Portal.tsx`). */
export const portalScreenText = defineText({
  it: {
    checking: 'Verifico…',
    checkNow: 'Verifica adesso',
    cloneMac: 'Usa il MAC di un dispositivo',
    exit: 'Uscita verso Internet',
    notChecked: 'Non ancora verificata.',
    portal: (
      <>
        Questa rete ha un <strong>portale di accesso</strong>: serve il login.
      </>
    ),
    openLogin: 'Apri la pagina di accesso',
    anyHttp: (
      <>
        Se la pagina non si apre, visita un indirizzo qualsiasi in <strong>http://</strong>.
      </>
    ),
    blocked: (
      <>
        La WAN ha un indirizzo ma <strong>non esce niente</strong>.
      </>
    ),
    unknown: 'La verifica non ha potuto dire niente.',
    macFor: (name: string) => `MAC da usare su ${name}`,
    currentMac: (mac: string) => (
      <>
        Adesso il router si presenta come <code>{mac}</code>.
      </>
    ),
    loadingClients: 'Leggo i dispositivi collegati…',
    noClients: 'Nessun dispositivo collegato.',
    noLease: 'senza lease DHCP',
    chosen: 'scelto',
    cloneWarn: (
      <>
        Quel dispositivo non deve restare collegato <strong>direttamente</strong> alla stessa rete.
      </>
    ),
    cardMac: 'MAC della scheda',
    useMac: 'Usa questo MAC',
    memory: 'Reti con portale',
    seen: (seen: string, login: string) => `visto ${seen} · accesso ${login}`,
    neverLogged: 'mai riuscito',
    forget: 'Dimentica',
  },
  en: {
    checking: 'Checking…',
    checkNow: 'Check now',
    cloneMac: 'Use a device’s MAC',
    exit: 'Internet access',
    notChecked: 'Not checked yet.',
    portal: (
      <>
        This network has a <strong>captive portal</strong>: you need to log in.
      </>
    ),
    openLogin: 'Open the login page',
    anyHttp: (
      <>
        If the page does not open, visit any <strong>http://</strong> address.
      </>
    ),
    blocked: (
      <>
        The WAN has an address but <strong>nothing gets out</strong>.
      </>
    ),
    unknown: 'The check could not tell anything.',
    macFor: (name: string) => `MAC to use on ${name}`,
    currentMac: (mac: string) => (
      <>
        The router now shows up as <code>{mac}</code>.
      </>
    ),
    loadingClients: 'Reading connected devices…',
    noClients: 'No device connected.',
    noLease: 'no DHCP lease',
    chosen: 'chosen',
    cloneWarn: (
      <>
        That device must not stay connected <strong>directly</strong> to the same network.
      </>
    ),
    cardMac: 'Adapter MAC',
    useMac: 'Use this MAC',
    memory: 'Networks with a portal',
    seen: (seen: string, login: string) => `seen ${seen} · login ${login}`,
    neverLogged: 'never succeeded',
    forget: 'Forget',
  },
});
