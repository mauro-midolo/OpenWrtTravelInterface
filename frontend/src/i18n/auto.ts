import { defineText } from '.';

type Params = Record<string, string | number | null | undefined>;
const s = (value: Params[string]) => (value == null ? '' : String(value));

/** La riconnessione automatica (`screens/AutoReconnect.tsx`) e gli eventi di traveld. */
export const autoText = defineText({
  it: {
    secondsAgo: (n: number) => `${n}s fa`,
    minutesAgo: (n: number) => `${n}m fa`,
    hoursAgo: (n: number) => `${n}h fa`,
    minutes: (n: number) => `${n} min`,
    title: 'Riconnessione automatica',
    noDaemon: 'travelD non risponde.',
    state: (on: boolean) => `Riconnessione automatica ${on ? 'attiva' : 'spenta'}`,
    settings: 'Impostazioni',
    minSignal: (dbm: number) => `Segnale minimo ${dbm} dBm`,
    roamBest: 'passa alla migliore',
    roamStay: 'resta sulla rete attuale',
    penalised: 'Reti messe da parte',
    blacklisted: (left: string) => `in blacklist ancora ${left}`,
    retryIn: (left: string) => `riprova fra ${left}`,
    waiting: 'in attesa',
    fails: (n: number) => ` · ${n} tentativi falliti`,
    reset: 'Azzera contatori e blacklist',
    events: 'Ultimi eventi',
    minSignalField: 'Segnale minimo accettabile',
    rssi65: '-65 dBm · solo reti forti',
    rssi72: '-72 dBm · buone',
    rssi78: '-78 dBm · consigliato',
    rssi85: '-85 dBm · anche deboli',
    roamField: 'Se compare una rete a priorità più alta',
    stay: 'Resta su quella attuale',
    best: 'Passa alla migliore',
    afterField: 'Metti da parte una rete dopo',
    failed: (n: number) => `${n} tentativi falliti`,
    ttlField: 'e riprovala dopo',
    ttl5: '5 minuti',
    ttl10: '10 minuti',
    ttl30: '30 minuti',
    ttl60: "un'ora",
    /** Gli eventi di traveld, per codice. Senza codice si mostra il testo del router. */
    event: {
      write_failed: (p: Params) => `non sono riuscito a scrivere la configurazione: ${s(p.error)}`,
      blacklisted: (p: Params) =>
        `${s(p.key)} messa da parte per ${s(p.ttl)}s dopo ${s(p.count)} tentativi falliti`,
      retry: (p: Params) => `${s(p.key)}: nuovo tentativo fra ${s(p.wait)}s`,
      recovered: (p: Params) => `${s(p.key)} ha funzionato, contatori azzerati`,
      roaming: (p: Params) =>
        `${s(p.radio)}: passo da ${s(p.from)} a ${s(p.to)} (priorità ${s(p.priority)} contro ${s(p.current)}, ${s(p.signal)} dBm)`,
      connecting: (p: Params) =>
        `${s(p.radio)} -> ${s(p.ssid)} (${p.signal == null ? 'nascosta' : `${s(p.signal)} dBm`})`,
      portal: (p: Params) => `${s(p.network)}: ${portalWordsIt(p)}`,
      killswitch_failed: (p: Params) => `riarmo del kill switch fallito: ${s(p.error)}`,
      killswitch_rearmed: () => 'sospensione scaduta: kill switch riarmato',
      loop_failed: (p: Params) => `giro di controllo interrotto: ${s(p.error)}`,
      reset: () => 'contatori e blacklist azzerati a mano',
    } as Record<string, (p: Params) => string>,
  },
  en: {
    secondsAgo: (n: number) => `${n}s ago`,
    minutesAgo: (n: number) => `${n}m ago`,
    hoursAgo: (n: number) => `${n}h ago`,
    minutes: (n: number) => `${n} min`,
    title: 'Auto-reconnect',
    noDaemon: 'travelD is not responding.',
    state: (on: boolean) => `Auto-reconnect ${on ? 'on' : 'off'}`,
    settings: 'Settings',
    minSignal: (dbm: number) => `Minimum signal ${dbm} dBm`,
    roamBest: 'switches to the best',
    roamStay: 'stays on the current network',
    penalised: 'Networks set aside',
    blacklisted: (left: string) => `blacklisted for another ${left}`,
    retryIn: (left: string) => `retry in ${left}`,
    waiting: 'waiting',
    fails: (n: number) => ` · ${n} failed attempts`,
    reset: 'Reset counters and blacklist',
    events: 'Recent events',
    minSignalField: 'Minimum acceptable signal',
    rssi65: '-65 dBm · strong networks only',
    rssi72: '-72 dBm · good',
    rssi78: '-78 dBm · recommended',
    rssi85: '-85 dBm · weak ones too',
    roamField: 'If a higher-priority network shows up',
    stay: 'Stay on the current one',
    best: 'Switch to the best',
    afterField: 'Set a network aside after',
    failed: (n: number) => `${n} failed attempts`,
    ttlField: 'and retry it after',
    ttl5: '5 minutes',
    ttl10: '10 minutes',
    ttl30: '30 minutes',
    ttl60: 'one hour',
    event: {
      write_failed: (p: Params) => `could not write the configuration: ${s(p.error)}`,
      blacklisted: (p: Params) =>
        `${s(p.key)} set aside for ${s(p.ttl)}s after ${s(p.count)} failed attempts`,
      retry: (p: Params) => `${s(p.key)}: next attempt in ${s(p.wait)}s`,
      recovered: (p: Params) => `${s(p.key)} worked, counters reset`,
      roaming: (p: Params) =>
        `${s(p.radio)}: switching from ${s(p.from)} to ${s(p.to)} (priority ${s(p.priority)} vs ${s(p.current)}, ${s(p.signal)} dBm)`,
      connecting: (p: Params) =>
        `${s(p.radio)} -> ${s(p.ssid)} (${p.signal == null ? 'hidden' : `${s(p.signal)} dBm`})`,
      portal: (p: Params) => `${s(p.network)}: ${portalWordsEn(p)}`,
      killswitch_failed: (p: Params) => `re-arming the kill switch failed: ${s(p.error)}`,
      killswitch_rearmed: () => 'pause expired: kill switch re-armed',
      loop_failed: (p: Params) => `control loop interrupted: ${s(p.error)}`,
      reset: () => 'counters and blacklist reset by hand',
    },
  },
});

function portalWordsIt(p: Params): string {
  if (p.state === 'online') return 'Internet raggiungibile';
  if (p.state === 'portal') return 'portale di accesso rilevato';
  if (p.state === 'blocked') return 'indirizzo sì, ma niente esce';
  return `non verificabile${p.reason ? ` (${s(p.reason)})` : ''}`;
}

function portalWordsEn(p: Params): string {
  if (p.state === 'online') return 'Internet reachable';
  if (p.state === 'portal') return 'captive portal detected';
  if (p.state === 'blocked') return 'address yes, but nothing gets out';
  return `cannot be checked${p.reason ? ` (${s(p.reason)})` : ''}`;
}

/**
 * Il testo di un evento o di un errore di traveld nella lingua dell'interfaccia.
 *
 * Il demone manda un codice e i suoi parametri accanto alla frase in italiano:
 * se il codice e' noto si ricompone qui, altrimenti (demone piu' vecchio, o un
 * codice nuovo che questo frontend non conosce) si mostra la frase com'e'.
 */
export function daemonMessage(entry: { message: string; code?: string; params?: Params }): string {
  const format = entry.code ? autoText().event[entry.code] : undefined;
  return format ? format(entry.params ?? {}) : entry.message;
}
