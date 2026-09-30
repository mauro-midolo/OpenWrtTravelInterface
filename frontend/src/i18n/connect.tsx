import { defineText } from '.';

/** Il modulo di connessione a una rete trovata (`screens/Connect.tsx`). */
export const connectText = defineText({
  it: {
    hidden: 'Rete nascosta',
    meta: (band: string, channel: number, security: string) =>
      `${band} GHz · canale ${channel} · ${security}`,
    sharesRadio: (band: string) => (
      <>
        L'access point su <strong>{band} GHz</strong> condivide questa radio: potrà interrompersi
        se la rete cade.
      </>
    ),
    otherApSafe: (band: string) => (
      <>
        Quello su <strong>{band} GHz</strong> resta raggiungibile.
      </>
    ),
    turnOnOtherAp: (
      <>
        <strong>Accendi prima un access point sull'altra radio</strong>, per non restare senza
        accesso.
      </>
    ),
    noAp: (
      <>
        Non c'è <strong>nessun access point acceso</strong>.
      </>
    ),
    password: 'Password della rete',
    keepSaved: 'lascia vuoto per usare quella salvata',
    addBand: (band: string, ssid: string, bands: string) => (
      <>
        Aggiungi <strong>{band}</strong> alla rete salvata «{ssid}» ({bands})
      </>
    ),
    save: 'Salva questa rete',
    saveApart: 'Salva questa rete come voce a parte',
    needsPassword: 'Per salvarla come voce a parte serve la password.',
    bands: 'Bande su cui salvarla',
    bandTaken: ' · già usata da un’altra rete salvata',
    connect: 'Connetti',
    checking: 'Connesso al router. Verifico la rete…',
    probing: 'Rete presa. Controllo se si esce davvero…',
    connectedTo: (ssid: string) => (
      <>
        Collegato a <strong>{ssid}</strong>.
      </>
    ),
    verified: (
      <>
        Verificato: <strong>Internet si raggiunge</strong>.
      </>
    ),
    notVerified: 'Uscita verso Internet non verificata.',
    portal: (
      <>
        La rete ha un <strong>portale di accesso</strong>: serve il login.
      </>
    ),
    openLogin: 'Apri la pagina di accesso',
    blocked: (
      <>
        La rete ha dato un indirizzo ma <strong>non esce niente</strong>.
      </>
    ),
    noAddress: (ssid: string) => (
      <>
        Agganciato a <strong>{ssid}</strong>, ma la rete non ha dato un indirizzo.
      </>
    ),
    unassociated: 'Non è riuscito ad agganciare la rete. Controlla la password.',
  },
  en: {
    hidden: 'Hidden network',
    meta: (band: string, channel: number, security: string) =>
      `${band} GHz · channel ${channel} · ${security}`,
    sharesRadio: (band: string) => (
      <>
        The access point on <strong>{band} GHz</strong> shares this radio: it may drop if the
        network drops.
      </>
    ),
    otherApSafe: (band: string) => (
      <>
        The one on <strong>{band} GHz</strong> stays reachable.
      </>
    ),
    turnOnOtherAp: (
      <>
        <strong>Turn on an access point on the other radio first</strong>, so you don’t lose
        access.
      </>
    ),
    noAp: (
      <>
        There is <strong>no access point on</strong>.
      </>
    ),
    password: 'Network password',
    keepSaved: 'leave empty to use the saved one',
    addBand: (band: string, ssid: string, bands: string) => (
      <>
        Add <strong>{band}</strong> to the saved network «{ssid}» ({bands})
      </>
    ),
    save: 'Save this network',
    saveApart: 'Save this network as a separate entry',
    needsPassword: 'To save it as a separate entry you need the password.',
    bands: 'Bands to save it on',
    bandTaken: ' · already used by another saved network',
    connect: 'Connect',
    checking: 'Connected to the router. Checking the network…',
    probing: 'Network joined. Checking whether traffic really gets out…',
    connectedTo: (ssid: string) => (
      <>
        Connected to <strong>{ssid}</strong>.
      </>
    ),
    verified: (
      <>
        Verified: <strong>Internet is reachable</strong>.
      </>
    ),
    notVerified: 'Internet access not verified.',
    portal: (
      <>
        The network has a <strong>captive portal</strong>: you need to log in.
      </>
    ),
    openLogin: 'Open the login page',
    blocked: (
      <>
        The network gave an address but <strong>nothing gets out</strong>.
      </>
    ),
    noAddress: (ssid: string) => (
      <>
        Associated with <strong>{ssid}</strong>, but the network gave no address.
      </>
    ),
    unassociated: 'Could not associate with the network. Check the password.',
  },
});
