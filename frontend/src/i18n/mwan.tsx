import { defineText } from '.';
import type { MwanMode } from '../lib/mwan';

/** Il multi-WAN (`screens/MultiWan.tsx`) e i testi di `lib/mwan.ts`. */
export const mwanText = defineText({
  it: {
    mode: {
      failover: 'Failover',
      balance: 'Bilanciamento',
      off: 'Nessuna politica',
    } as Record<MwanMode, string>,
    status: {
      online: 'online',
      offline: 'offline',
      disabled: 'esclusa',
      notracking: 'senza controllo',
      unknown: 'stato ignoto',
    },
    mixedFamilies: 'La regola mescola IPv4 e IPv6: mwan3 ne accetta una famiglia sola per regola.',
    wifi24: 'WiFi 2.4 GHz',
    wifi5: 'WiFi 5 GHz',
    usb: 'Tethering USB',
    port: (device: string) => `Porta ${device}`,
    title: 'Multi-WAN',
    reading: 'Lettura in corso…',
    notInstalled: 'Multi-WAN non installato',
    edit: 'Modifica',
    notRunning: 'mwan3 è installato ma non risponde.',
    excluded: 'esclusa',
    weight: (weight: number) => ` · peso ${weight}`,
    stickyGeneral: 'Sticky sul traffico generale',
    stickyOn: (seconds: number) => `attivo, ${seconds}s`,
    stickyOff: 'disattivo',
    modeField: 'Modalità',
    failoverOption: 'Failover — una alla volta, in ordine',
    balanceOption: 'Bilanciamento — tutte insieme',
    balanceBlocked: (reason: string) => (
      <>
        Il <strong>bilanciamento</strong> non è disponibile: {reason}.
      </>
    ),
    seconds: 'Per quanti secondi',
    priority: 'Ordine di priorità',
    weights: 'WAN e pesi',
    weightOf: (wan: string) => `peso di ${wan}`,
    moveUp: 'sposta su',
    moveDown: 'sposta giù',
    badWeights: 'I pesi devono essere numeri interi da 1 in su.',
    included: 'WAN incluse',
    oneIncluded: 'Almeno una WAN deve restare inclusa.',
    applying: 'Applico…',
    apply: 'Applica',
    rule: {
      fromAnyone: 'da chiunque',
      from: (ip: string) => `da ${ip}`,
      to: (ip: string) => `verso ${ip}`,
      port: (port: string) => `porta ${port}`,
      strict: '(bloccante)',
      sticky: (seconds: number) => `sticky ${seconds}s`,
    },
    rules: 'Regole di instradamento',
    add: 'Aggiungi',
    noRules: 'Nessuna regola.',
    ruleN: (n: number) => `Regola ${n}`,
    editRule: 'Modifica regola',
    newRule: 'Nuova regola',
    source: 'Dispositivo di partenza',
    sourcePlaceholder: 'es. 192.168.10.50 — vuoto = tutti',
    badTarget: 'Serve un indirizzo o una sottorete valida.',
    destination: 'Destinazione',
    destPlaceholder: 'es. 10.0.0.0/8 — vuoto = ovunque',
    portProto: 'Porta e protocollo',
    destPort: 'porta di destinazione',
    allProtocols: 'tutti i protocolli',
    badPort: 'Una porta (443) o un intervallo (5000-5100).',
    routeVia: 'Instrada su',
    strictField: (
      <>
        Se questa WAN non è disponibile, <strong>ferma</strong> il traffico invece di mandarlo
        sulle altre
      </>
    ),
    sticky: 'Sticky',
    needsCriteria: 'Serve almeno un criterio.',
    remove: 'Elimina',
    health: 'Controllo di salute',
    healthOf: (wan: string) => `Controllo di salute · ${wan}`,
    trackIp: 'Indirizzo da controllare',
    trackIpN: (n: number) => `Indirizzo ${n}`,
    addTrackIp: 'Aggiungi un indirizzo',
    removeTrackIp: (ip: string) => `Rimuovi ${ip}`,
    badTrackIp: 'Serve almeno un indirizzo IPv4 valido.',
    reliability: 'Quando la WAN è su',
    reliabilityOption: (needed: number, total: number) =>
      needed === 1
        ? 'Basta che ne risponda uno'
        : needed === total
          ? total === 2
            ? 'Devono rispondere entrambi'
            : `Devono rispondere tutti e ${total}`
          : `Devono risponderne almeno ${needed} su ${total}`,
    reliabilityHint: (needed: number, total: number) =>
      needed === total
        ? 'Si controllano sempre tutti: se uno smette di rispondere, la WAN risulta giù.'
        : needed === 1
          ? 'Gli altri fanno da riserva: si controllano, in ordine, solo quando i primi non rispondono.'
          : `Si controllano in ordine finché ne rispondono ${needed}: gli altri fanno da riserva.`,
    every: 'Ogni quanto controllare',
    intervalLabel: 'intervallo in secondi',
    secondsTimeout: 'secondi, timeout',
    timeoutLabel: 'timeout in secondi',
    attempts: 'Quanti tentativi prima di cambiare stato',
    downAfter: 'Giù dopo',
    downLabel: 'tentativi falliti prima di dichiarare la WAN giù',
    upAfter: '· su dopo',
    upLabel: 'tentativi riusciti prima di dichiarare la WAN su',
    detection: (down: number | string, up: number | string) =>
      `Caduta rilevata in circa ${down} s, ritorno in ${up} s.`,
    badNumbers: 'I valori devono essere numeri interi da 1 in su.',
  },
  en: {
    mode: {
      failover: 'Failover',
      balance: 'Load balancing',
      off: 'No policy',
    },
    status: {
      online: 'online',
      offline: 'offline',
      disabled: 'excluded',
      notracking: 'not tracked',
      unknown: 'unknown state',
    },
    mixedFamilies: 'The rule mixes IPv4 and IPv6: mwan3 accepts a single family per rule.',
    wifi24: 'WiFi 2.4 GHz',
    wifi5: 'WiFi 5 GHz',
    usb: 'USB tethering',
    port: (device: string) => `Port ${device}`,
    title: 'Multi-WAN',
    reading: 'Reading…',
    notInstalled: 'Multi-WAN not installed',
    edit: 'Edit',
    notRunning: 'mwan3 is installed but not responding.',
    excluded: 'excluded',
    weight: (weight: number) => ` · weight ${weight}`,
    stickyGeneral: 'Sticky on general traffic',
    stickyOn: (seconds: number) => `on, ${seconds}s`,
    stickyOff: 'off',
    modeField: 'Mode',
    failoverOption: 'Failover — one at a time, in order',
    balanceOption: 'Load balancing — all together',
    balanceBlocked: (reason: string) => (
      <>
        <strong>Load balancing</strong> is not available: {reason}.
      </>
    ),
    seconds: 'For how many seconds',
    priority: 'Priority order',
    weights: 'WANs and weights',
    weightOf: (wan: string) => `weight of ${wan}`,
    moveUp: 'move up',
    moveDown: 'move down',
    badWeights: 'Weights must be whole numbers from 1 up.',
    included: 'Included WANs',
    oneIncluded: 'At least one WAN must stay included.',
    applying: 'Applying…',
    apply: 'Apply',
    rule: {
      fromAnyone: 'from anyone',
      from: (ip: string) => `from ${ip}`,
      to: (ip: string) => `to ${ip}`,
      port: (port: string) => `port ${port}`,
      strict: '(blocking)',
      sticky: (seconds: number) => `sticky ${seconds}s`,
    },
    rules: 'Routing rules',
    add: 'Add',
    noRules: 'No rules.',
    ruleN: (n: number) => `Rule ${n}`,
    editRule: 'Edit rule',
    newRule: 'New rule',
    source: 'Source device',
    sourcePlaceholder: 'e.g. 192.168.10.50 — empty = all',
    badTarget: 'A valid address or subnet is needed.',
    destination: 'Destination',
    destPlaceholder: 'e.g. 10.0.0.0/8 — empty = anywhere',
    portProto: 'Port and protocol',
    destPort: 'destination port',
    allProtocols: 'all protocols',
    badPort: 'A port (443) or a range (5000-5100).',
    routeVia: 'Route via',
    strictField: (
      <>
        If this WAN is not available, <strong>stop</strong> the traffic instead of sending it over
        the others
      </>
    ),
    sticky: 'Sticky',
    needsCriteria: 'At least one criterion is needed.',
    remove: 'Delete',
    health: 'Health check',
    healthOf: (wan: string) => `Health check · ${wan}`,
    trackIp: 'Address to check',
    trackIpN: (n: number) => `Address ${n}`,
    addTrackIp: 'Add an address',
    removeTrackIp: (ip: string) => `Remove ${ip}`,
    badTrackIp: 'At least one valid IPv4 address is needed.',
    reliability: 'When the WAN is up',
    reliabilityOption: (needed: number, total: number) =>
      needed === 1
        ? 'One answering is enough'
        : needed === total
          ? total === 2
            ? 'Both must answer'
            : `All ${total} must answer`
          : `At least ${needed} of ${total} must answer`,
    reliabilityHint: (needed: number, total: number) =>
      needed === total
        ? 'All are always checked: if any stops answering, the WAN is marked down.'
        : needed === 1
          ? 'The others are backups: they are checked, in order, only when the first ones do not answer.'
          : `They are checked in order until ${needed} answer: the others are backups.`,
    every: 'How often to check',
    intervalLabel: 'interval in seconds',
    secondsTimeout: 'seconds, timeout',
    timeoutLabel: 'timeout in seconds',
    attempts: 'How many attempts before changing state',
    downAfter: 'Down after',
    downLabel: 'failed attempts before declaring the WAN down',
    upAfter: '· up after',
    upLabel: 'successful attempts before declaring the WAN up',
    detection: (down: number | string, up: number | string) =>
      `Failure detected in about ${down} s, recovery in ${up} s.`,
    badNumbers: 'Values must be whole numbers from 1 up.',
  },
});
