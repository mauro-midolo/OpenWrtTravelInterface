import { defineText } from '.';

/** La scheda LAN (`screens/Lan.tsx`) e i testi di `lib/lan.ts`. */
export const lanText = defineText({
  it: {
    lib: {
      ra: {
        auto: {
          label: 'Automatico (consigliato)',
          hint: 'SLAAC e DHCPv6 insieme. E’ il default di OpenWrt, ed e’ l’unica combinazione in cui Android — che fa solo SLAAC — e Windows — che preferisce DHCPv6 — funzionano entrambi.',
        },
        slaac: {
          label: 'Solo SLAAC',
          hint: 'I dispositivi si scelgono l’indirizzo da soli. Il router non ne assegna e non ne tiene un elenco.',
        },
        off: {
          label: 'Spento',
          hint: 'Nessun annuncio IPv6 ai dispositivi. E’ la risposta a “IPv6 mi ha rotto la connessione in albergo”.',
        },
      },
      autoRouter: 'Automatico / Router',
      autoWan: 'Automatico / DNS della WAN',
      custom: 'Personalizzato',
      poolNotNumbers: 'I due valori devono essere numeri.',
      poolRange: 'I valori devono stare fra 2 e 254.',
      poolOrder: 'Il primo valore deve essere minore o uguale al secondo.',
      poolHasRouter: (octet: number) =>
        `L'indirizzo del router (.${octet}) cadrebbe dentro il pool: il DHCP lo assegnerebbe a un dispositivo.`,
      writeLanAddress: 'indirizzo della rete locale',
      writePool: 'intervallo DHCP',
      writeClientDns: 'DNS annunciati ai dispositivi',
      writeClientDns6: 'DNS IPv6 annunciati ai dispositivi',
      writeRa: 'annunci IPv6 ai dispositivi',
      writeRouterDns: 'DNS usati dal router',
      noBridge: 'Nessun bridge br-lan trovato nella configurazione.',
      noAddress: 'senza indirizzo',
      cable: 'Cavo',
      unknownLink: 'non determinata',
    },
    title: 'Rete locale',
    loading: 'Leggo la configurazione…',
    transition: 'Transizione in corso',
    newAddress: 'Nuovo',
    oldAddress: 'Vecchio',
    checkNew: (address: string) => (
      <>
        Verifica di raggiungere <strong>https://{address}/travel/</strong> prima di togliere il
        vecchio.
      </>
    ),
    removeOld: 'Rimuovi il vecchio indirizzo',
    conflict: 'Conflitto di sottorete',
    conflictText: (
      <>
        La rete locale usa la stessa sottorete di una rete a monte: il traffico dei client{' '}
        <strong>non esce</strong>.
      </>
    ),
    freeRange: (range: string) => (
      <>
        Intervallo libero: <strong>{range}</strong>
      </>
    ),
    moveLan: 'Sposta la rete locale',
    current: 'Configurazione attuale',
    edit: 'Modifica',
    routerAddress: 'Indirizzo del router',
    network: 'Rete',
    networkValue: (prefix: string) => `${prefix}.0 · 254 indirizzi`,
    address6: 'Indirizzo IPv6',
    ula: 'Prefisso ULA',
    ra: 'Annunci IPv6',
    device: 'Interfaccia',
    pool: 'Pool DHCP',
    disabled: 'disattivato',
    clientDns: 'DNS dati ai client',
    routerItself: 'il router stesso',
    clientDns6: 'DNS IPv6 dati ai client',
    resolver: 'Resolver del router',
    wanOnes: 'quelli della WAN',
    role: {
      wan: 'WAN (uplink)',
      lan: 'LAN (bridge)',
      free: 'non assegnata',
    },
    macOf: (port: string) => `MAC di ${port}`,
    macNow: (mac: string, configured: boolean) => (
      <>
        Adesso la porta si presenta come <code>{mac}</code>
        {configured ? ' (indirizzo impostato).' : ' (indirizzo di fabbrica).'}
      </>
    ),
    macWarnWan: 'Un eventuale portale di accesso chiederà di nuovo il login.',
    macWarnLan: 'Il collegamento via cavo cade per qualche secondo.',
    macWarnFree: 'La porta non è assegnata.',
    apply: 'Applica',
    removeMac: 'Togli',
    macSet: (port: string, mac: string) => `${port} ora si presenta come ${mac}.`,
    macReset: (port: string) => `${port} è tornata all'indirizzo di fabbrica.`,
    ports: 'Porte ethernet',
    noPorts: 'Nessuna porta ethernet rilevata sul dispositivo.',
    cable: 'cavo collegato',
    noCable: 'nessun cavo',
    cableUnknown: 'cavo non leggibile',
    factory: ' · di fabbrica',
    macConfigured: ' · impostato',
    macPending: (mac: string) => ` · impostato ${mac}, non ancora applicato`,
    changeMac: 'Cambia MAC',
    useAsLan: 'Usa come LAN',
    useAsWan: 'Usa come WAN',
    toLanWarn: 'Chi è collegato via cavo perde il collegamento per qualche secondo.',
    toWanWarn: 'Un computer attaccato a questa porta perde la rete.',
    lastLan: "È l'ultima porta LAN: dopo questa operazione al router ci si collega solo via WiFi.",
    lastWan:
      "È l'ultimo uplink via cavo: dopo questa operazione Internet può arrivare solo dal WiFi o dal tethering.",
    portDone: (port: string, lan: boolean) =>
      `Fatto: ${port} è ora ${lan ? 'una porta LAN' : 'un uplink WAN'}.`,
    clients: 'Dispositivi collegati',
    loadingClients: 'Leggo i dispositivi…',
    noClients: 'Nessun dispositivo collegato alla rete locale.',
    luciOnly: 'Modificabili solo da LuCI.',
    raCustom: 'Personalizzati (configurati fuori da qui)',
    dnsPrimary: 'DNS primario',
    dnsSecondary: 'DNS secondario (facoltativo)',
    ipv4Only: 'Solo indirizzi IPv4.',
    routerIp: 'Indirizzo IP del router',
    badIp: 'Indirizzo IPv4 non valido.',
    poolField: 'Indirizzi assegnati automaticamente',
    from: 'Da',
    to: 'A',
    firstAssigned: 'primo indirizzo assegnato',
    lastAssigned: 'ultimo indirizzo assegnato',
    poolSummary: (net: string, from: number, to: number) =>
      `${net}.${from} → ${net}.${to} · ${to - from + 1} dispositivi`,
    raField: 'Annunci IPv6 ai dispositivi',
    raLuciOnly: ' · modificabili solo da LuCI.',
    clientDnsField: 'DNS per i dispositivi della rete',
    routerDnsField: 'DNS usati dal router',
    fixedDnsWarn: 'Con DNS fissi la pagina di login di alcune reti potrebbe non aprirsi.',
    moving: (from: string, to: string) => (
      <>
        Stai spostando il router da <strong>{from}</strong> a <strong>{to}</strong>. Il vecchio
        indirizzo resta attivo finché non lo rimuovi.
      </>
    ),
    applied: 'Configurazione applicata.',
    nowOn: (address: string) => (
      <>
        L'interfaccia è ora su <strong>https://{address}/travel/</strong>.
      </>
    ),
  },
  en: {
    lib: {
      ra: {
        auto: {
          label: 'Automatic (recommended)',
          hint: 'SLAAC and DHCPv6 together. It is the OpenWrt default, and the only combination where Android — which only does SLAAC — and Windows — which prefers DHCPv6 — both work.',
        },
        slaac: {
          label: 'SLAAC only',
          hint: 'Devices pick their own address. The router assigns none and keeps no list of them.',
        },
        off: {
          label: 'Off',
          hint: 'No IPv6 announcements to devices. It is the answer to “IPv6 broke my connection at the hotel”.',
        },
      },
      autoRouter: 'Automatic / Router',
      autoWan: 'Automatic / WAN DNS',
      custom: 'Custom',
      poolNotNumbers: 'Both values must be numbers.',
      poolRange: 'Values must be between 2 and 254.',
      poolOrder: 'The first value must be less than or equal to the second.',
      poolHasRouter: (octet: number) =>
        `The router address (.${octet}) would fall inside the pool: DHCP would hand it to a device.`,
      writeLanAddress: 'local network address',
      writePool: 'DHCP range',
      writeClientDns: 'DNS announced to devices',
      writeClientDns6: 'IPv6 DNS announced to devices',
      writeRa: 'IPv6 announcements to devices',
      writeRouterDns: 'DNS used by the router',
      noBridge: 'No br-lan bridge found in the configuration.',
      noAddress: 'no address',
      cable: 'Cable',
      unknownLink: 'unknown',
    },
    title: 'Local network',
    loading: 'Reading the configuration…',
    transition: 'Transition in progress',
    newAddress: 'New',
    oldAddress: 'Old',
    checkNew: (address: string) => (
      <>
        Make sure you can reach <strong>https://{address}/travel/</strong> before removing the old
        one.
      </>
    ),
    removeOld: 'Remove the old address',
    conflict: 'Subnet conflict',
    conflictText: (
      <>
        The local network uses the same subnet as an upstream network: client traffic{' '}
        <strong>does not get out</strong>.
      </>
    ),
    freeRange: (range: string) => (
      <>
        Free range: <strong>{range}</strong>
      </>
    ),
    moveLan: 'Move the local network',
    current: 'Current configuration',
    edit: 'Edit',
    routerAddress: 'Router address',
    network: 'Network',
    networkValue: (prefix: string) => `${prefix}.0 · 254 addresses`,
    address6: 'IPv6 address',
    ula: 'ULA prefix',
    ra: 'IPv6 announcements',
    device: 'Interface',
    pool: 'DHCP pool',
    disabled: 'disabled',
    clientDns: 'DNS given to clients',
    routerItself: 'the router itself',
    clientDns6: 'IPv6 DNS given to clients',
    resolver: 'Router resolver',
    wanOnes: 'the WAN ones',
    role: {
      wan: 'WAN (uplink)',
      lan: 'LAN (bridge)',
      free: 'unassigned',
    },
    macOf: (port: string) => `MAC of ${port}`,
    macNow: (mac: string, configured: boolean) => (
      <>
        The port now shows up as <code>{mac}</code>
        {configured ? ' (address set).' : ' (factory address).'}
      </>
    ),
    macWarnWan: 'A captive portal, if any, will ask you to log in again.',
    macWarnLan: 'The wired connection drops for a few seconds.',
    macWarnFree: 'The port is not assigned.',
    apply: 'Apply',
    removeMac: 'Remove',
    macSet: (port: string, mac: string) => `${port} now shows up as ${mac}.`,
    macReset: (port: string) => `${port} is back to its factory address.`,
    ports: 'Ethernet ports',
    noPorts: 'No ethernet port found on the device.',
    cable: 'cable plugged in',
    noCable: 'no cable',
    cableUnknown: 'cable state unreadable',
    factory: ' · factory',
    macConfigured: ' · set',
    macPending: (mac: string) => ` · set to ${mac}, not applied yet`,
    changeMac: 'Change MAC',
    useAsLan: 'Use as LAN',
    useAsWan: 'Use as WAN',
    toLanWarn: 'Whoever is connected by cable loses the connection for a few seconds.',
    toWanWarn: 'A computer plugged into this port loses the network.',
    lastLan: 'It is the last LAN port: after this, the router can only be reached over WiFi.',
    lastWan:
      'It is the last wired uplink: after this, Internet can only come from WiFi or tethering.',
    portDone: (port: string, lan: boolean) =>
      `Done: ${port} is now ${lan ? 'a LAN port' : 'a WAN uplink'}.`,
    clients: 'Connected devices',
    loadingClients: 'Reading the devices…',
    noClients: 'No device connected to the local network.',
    luciOnly: 'Editable from LuCI only.',
    raCustom: 'Custom (configured outside of here)',
    dnsPrimary: 'Primary DNS',
    dnsSecondary: 'Secondary DNS (optional)',
    ipv4Only: 'IPv4 addresses only.',
    routerIp: 'Router IP address',
    badIp: 'Invalid IPv4 address.',
    poolField: 'Automatically assigned addresses',
    from: 'From',
    to: 'To',
    firstAssigned: 'first assigned address',
    lastAssigned: 'last assigned address',
    poolSummary: (net: string, from: number, to: number) =>
      `${net}.${from} → ${net}.${to} · ${to - from + 1} devices`,
    raField: 'IPv6 announcements to devices',
    raLuciOnly: ' · editable from LuCI only.',
    clientDnsField: 'DNS for devices on the network',
    routerDnsField: 'DNS used by the router',
    fixedDnsWarn: 'With fixed DNS the login page of some networks may not open.',
    moving: (from: string, to: string) => (
      <>
        You are moving the router from <strong>{from}</strong> to <strong>{to}</strong>. The old
        address stays active until you remove it.
      </>
    ),
    applied: 'Configuration applied.',
    nowOn: (address: string) => (
      <>
        The interface is now at <strong>https://{address}/travel/</strong>.
      </>
    ),
  },
});
