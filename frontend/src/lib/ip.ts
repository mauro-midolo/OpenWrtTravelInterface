/**
 * Indirizzi IP: analisi, formattazione e confronto, per entrambe le famiglie.
 *
 * Non e' un'estensione di lan.ts, ed e' una scelta. Quel file parla della rete
 * che il router OFFRE, mentre l'aritmetica degli indirizzi non e' un fatto
 * della LAN: MultiWan.tsx importa isValidIp da lan.ts per convalidare le regole
 * mwan3, che e' il sintomo di un confine messo nel posto sbagliato. Gli
 * indirizzi sono un confine a se', come lib/ubus.ts lo e' per il trasporto.
 *
 * Un indirizzo e' un array di byte, non un intero. Il motivo per cui questo
 * modulo esiste e' che 32 bit non bastano, e un BigInt riporterebbe lo stesso
 * problema in forma nuova: mascherare, confrontare e formattare avrebbero due
 * strade a seconda della famiglia, cioe' due posti dove sbagliare. Con i byte
 * la strada e' una sola e la famiglia e' soltanto la lunghezza dell'array.
 */

export type IpFamily = 4 | 6;

export interface IpAddr {
  family: IpFamily;
  /** 4 byte per IPv4, 16 per IPv6. */
  bytes: Uint8Array;
  /** Zone id di un link-local ("eth0" in fe80::1%eth0), vuota se assente. */
  zone: string;
}

export interface IpNet {
  addr: IpAddr;
  prefix: number;
}

/** Bit dell'indirizzo per famiglia, per non spargere 32 e 128 nel file. */
function bitsOf(family: IpFamily): number {
  return family === 4 ? 32 : 128;
}

// --- Analisi ------------------------------------------------------------------

function parseV4Bytes(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;

  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (!/^\d{1,3}$/.test(part)) return null;
    // Zeri iniziali rifiutati: "010" vale 8 per inet_aton e per una parte degli
    // stack di rete, e 10 per tutti gli altri. Un indirizzo che significa due
    // cose diverse a seconda di chi lo legge non si accetta in silenzio. E' un
    // cambio deliberato rispetto alla vecchia isValidIp di lan.ts, che li
    // prendeva per decimali.
    if (part.length > 1 && part[0] === '0') return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

function parseV6Bytes(text: string): Uint8Array | null {
  let body = text;

  // Quad puntato finale (::ffff:192.168.1.1): vale due gruppi e sta solo in
  // coda. Convertirlo subito in due gruppi esadecimali lascia una sola strada
  // al resto della funzione, compresa la gestione di "::".
  if (body.includes('.')) {
    const cut = body.lastIndexOf(':');
    if (cut < 0) return null;
    const quad = parseV4Bytes(body.slice(cut + 1));
    if (!quad) return null;
    const high = ((quad[0] << 8) | quad[1]).toString(16);
    const low = ((quad[2] << 8) | quad[3]).toString(16);
    body = `${body.slice(0, cut + 1)}${high}:${low}`;
  }

  const double = body.indexOf('::');
  let head: string[];
  let tail: string[];

  if (double < 0) {
    head = body.split(':');
    tail = [];
    if (head.length !== 8) return null;
  } else {
    // Un solo "::". Il confronto scarta anche ":::", che altrimenti passerebbe
    // come "::" seguito da un gruppo vuoto.
    if (double !== body.lastIndexOf('::')) return null;
    const left = body.slice(0, double);
    const right = body.slice(double + 2);
    head = left === '' ? [] : left.split(':');
    tail = right === '' ? [] : right.split(':');
    // "::" sta per almeno un gruppo di zeri: con otto gruppi gia' scritti non
    // avrebbe niente da rappresentare.
    if (head.length + tail.length > 7) return null;
  }

  const groups = [...head, ...tail];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
  }

  const bytes = new Uint8Array(16);
  const zeros = 8 - groups.length;
  let index = 0;
  const push = (value: number) => {
    bytes[index++] = (value >> 8) & 0xff;
    bytes[index++] = value & 0xff;
  };
  for (const group of head) push(parseInt(group, 16));
  for (let i = 0; i < zeros; i++) push(0);
  for (const group of tail) push(parseInt(group, 16));
  return bytes;
}

/** Analizza un indirizzo nudo, senza prefisso. Null se non e' un indirizzo. */
export function parseIp(text: string): IpAddr | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  let body = trimmed;
  let zone = '';
  const percent = trimmed.indexOf('%');
  if (percent >= 0) {
    body = trimmed.slice(0, percent);
    zone = trimmed.slice(percent + 1);
    if (zone === '') return null;
  }

  if (body.includes(':')) {
    const bytes = parseV6Bytes(body);
    return bytes ? { family: 6, bytes, zone } : null;
  }

  // La zone id dice su quale link un indirizzo e' valido, e in IPv4 non esiste:
  // "1.2.3.4%eth0" non e' una forma piu' precisa, e' una forma inventata.
  if (zone !== '') return null;
  const bytes = parseV4Bytes(body);
  return bytes ? { family: 4, bytes, zone: '' } : null;
}

/**
 * Vero se il testo e' un indirizzo. Senza `family` vanno bene entrambe le
 * famiglie: e' la firma allargata che sostituisce quella IPv4-only di lan.ts.
 */
export function isValidIp(text: string, family?: IpFamily): boolean {
  const addr = parseIp(text);
  if (!addr) return false;
  return family === undefined || addr.family === family;
}

/**
 * Indirizzo con prefisso opzionale. Senza prefisso vale l'indirizzo singolo
 * (/32 o /128), e il prefisso e' convalidato sulla famiglia: "10.0.0.0/128" e'
 * un errore tanto quanto "::/129".
 */
export function parseCidr(text: string): IpNet | null {
  const trimmed = text.trim();
  const slash = trimmed.indexOf('/');
  if (slash < 0) {
    const addr = parseIp(trimmed);
    return addr ? { addr, prefix: bitsOf(addr.family) } : null;
  }

  const addr = parseIp(trimmed.slice(0, slash));
  if (!addr) return null;
  const rest = trimmed.slice(slash + 1).trim();
  if (!/^\d{1,3}$/.test(rest)) return null;
  const prefix = Number(rest);
  if (prefix > bitsOf(addr.family)) return null;
  return { addr, prefix };
}

// --- Formattazione ------------------------------------------------------------

function formatV6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);

  // Run di zeri piu' lungo, il piu' a sinistra a parita' di lunghezza (RFC
  // 5952). Il confronto e' stretto (>) proprio per tenere il primo.
  let bestStart = -1;
  let bestLen = 0;
  let start = -1;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && groups[i] === 0) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      const len = i - start;
      if (len > bestLen) {
        bestStart = start;
        bestLen = len;
      }
      start = -1;
    }
  }
  // Un gruppo solo non si comprime: "::" al posto di ":0:" non accorcia niente
  // e produce una forma che parte dei parser rifiuta.
  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(':');

  const head = groups.slice(0, bestStart).map((g) => g.toString(16)).join(':');
  const tail = groups.slice(bestStart + bestLen).map((g) => g.toString(16)).join(':');
  return `${head}::${tail}`;
}

/**
 * Forma canonica: minuscolo, senza zeri iniziali nei gruppi, con il run di zeri
 * piu' lungo compresso.
 *
 * Un indirizzo IPv4-mapped esce in esadecimale (::ffff:c0a8:101) e non nella
 * forma puntata suggerita da RFC 5952: qui non compare mai davvero, e una
 * seconda strada nella formattazione costerebbe piu' di quanto vale.
 */
export function formatIp(addr: IpAddr): string {
  const text = addr.family === 4 ? addr.bytes.join('.') : formatV6(addr.bytes);
  return addr.zone ? `${text}%${addr.zone}` : text;
}

// --- Maschere e sottoreti -----------------------------------------------------

/**
 * Maschera puntata in numero di bit, null se non e' contigua.
 *
 * Solo IPv4, e non e' una dimenticanza: la maschera puntata e' una notazione
 * che in IPv6 non esiste. Serve perche' findConflicts riceve ancora una
 * netmask, che e' la forma in cui il router la memorizza.
 */
export function maskToPrefix(mask: string): number | null {
  const addr = parseIp(mask);
  if (!addr || addr.family !== 4) return null;

  let value = 0;
  for (const byte of addr.bytes) value = value * 256 + byte;
  // Una maschera valida e' una sequenza di 1 seguita da una di 0: il
  // complemento piu' uno deve essere una potenza di due.
  const inverted = ~value >>> 0;
  if ((inverted & (inverted + 1)) !== 0) return null;

  let prefix = 0;
  while (prefix < 32 && (value & (0x80000000 >>> prefix)) !== 0) prefix++;
  return prefix;
}

/** Maschera puntata da un numero di bit. Solo IPv4, come maskToPrefix. */
export function prefixToMask(prefix: number): string {
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const bits = Math.min(8, Math.max(0, prefix - i * 8));
    bytes[i] = bits === 0 ? 0 : (0xff << (8 - bits)) & 0xff;
  }
  return bytes.join('.');
}

/** Azzera i bit di host: la rete a cui l'indirizzo appartiene. */
export function subnetOf(net: IpNet): IpNet {
  const bytes = new Uint8Array(net.addr.bytes);
  for (let i = 0; i < bytes.length; i++) {
    const bits = Math.min(8, Math.max(0, net.prefix - i * 8));
    bytes[i] = bits === 0 ? 0 : bytes[i] & ((0xff << (8 - bits)) & 0xff);
  }
  // La rete non ha zone id: quella qualifica un indirizzo, non un prefisso.
  return { addr: { family: net.addr.family, bytes, zone: '' }, prefix: net.prefix };
}

/** Come subnetOf, ma da indirizzo e maschera puntata. Solo IPv4. */
export function subnetOfMask(ip: string, mask: string): IpNet | null {
  const addr = parseIp(ip);
  if (!addr || addr.family !== 4) return null;
  const prefix = maskToPrefix(mask);
  if (prefix === null) return null;
  return subnetOf({ addr, prefix });
}

function samePrefix(a: Uint8Array, b: Uint8Array, bits: number): boolean {
  const whole = bits >> 3;
  for (let i = 0; i < whole; i++) {
    if (a[i] !== b[i]) return false;
  }
  const rest = bits & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (a[whole] & mask) === (b[whole] & mask);
}

/** Vero se l'indirizzo cade dentro la rete. */
export function contains(net: IpNet, addr: IpAddr): boolean {
  if (net.addr.family !== addr.family) return false;
  return samePrefix(net.addr.bytes, addr.bytes, net.prefix);
}

/**
 * Due reti si sovrappongono se una contiene la rete dell'altra.
 *
 * Fra famiglie diverse la risposta e' sempre falso, e questa riga e' portante:
 * senza, il confronto byte a byte di una WAN IPv6 con la LAN IPv4 inventerebbe
 * conflitti che non esistono, e la schermata proporrebbe di cambiare
 * l'indirizzo del router per niente.
 */
export function overlaps(a: IpNet, b: IpNet): boolean {
  if (a.addr.family !== b.addr.family) return false;
  return samePrefix(a.addr.bytes, b.addr.bytes, Math.min(a.prefix, b.prefix));
}

// --- Host, porte e ordinamento ------------------------------------------------

/**
 * Host pronto per una URL: un IPv6 va fra parentesi, altrimenti i due punti
 * dell'indirizzo si confondono con quelli della porta.
 *
 * La zone id si scarta: in una URL non ha significato, e alcuni browser
 * rifiutano l'intero indirizzo se la trovano. Un nome di host o un IPv4
 * tornano com'erano.
 */
export function hostForUrl(text: string): string {
  const addr = parseIp(text);
  if (!addr || addr.family !== 6) return text.trim();
  return `[${formatIp({ ...addr, zone: '' })}]`;
}

export interface HostPort {
  /** Senza parentesi, anche quando l'originale ne aveva. */
  host: string;
  /** Vuota se non c'era una porta. */
  port: string;
}

/**
 * Separa host e porta nelle quattro forme che esistono davvero:
 * "host:porta", "[v6]:porta", "[v6]" e un IPv6 nudo.
 *
 * L'ultimo caso e' il bug dell'endpoint WireGuard: spezzando sull'ultimo ":",
 * "2001:db8::1" diventa host "2001:db8:" e porta "1" - due valori plausibili e
 * sbagliati, che si scrivono senza che niente protesti. Il riconoscimento e' il
 * conteggio dei ":": nessun nome di host e nessun IPv4 puo' contenerne due,
 * quindi la regola non ha casi ambigui.
 */
export function hostPortSplit(text: string): HostPort {
  const trimmed = text.trim();

  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close < 0) return { host: trimmed, port: '' };
    const rest = trimmed.slice(close + 1);
    return {
      host: trimmed.slice(1, close),
      port: rest.startsWith(':') ? rest.slice(1) : '',
    };
  }

  const first = trimmed.indexOf(':');
  if (first < 0) return { host: trimmed, port: '' };
  if (trimmed.indexOf(':', first + 1) >= 0) return { host: trimmed, port: '' };
  return { host: trimmed.slice(0, first), port: trimmed.slice(first + 1) };
}

/**
 * Ricompone host e porta, mettendo le parentesi se l'host e' un IPv6.
 *
 * Le parentesi non sono cosmetica. "2001:db8::1" e "443" uniti senza danno
 * "2001:db8::1:443", che e' un indirizzo IPv6 valido e DIVERSO: nessuno
 * protesta e il traffico va altrove. Il guasto dipende dalla porta, ed e' il
 * motivo per cui va evitato sempre invece che quando sembra pericoloso: una
 * porta di al massimo quattro cifre (443, 8080) e' anche un gruppo
 * esadecimale, quindi passa; con 51820, che di cifre ne ha cinque, esce una
 * stringa invalida e il guasto si vede subito. Il caso silenzioso e' quello
 * che sembra innocuo.
 *
 * Idempotente sulle parentesi, perche' l'host puo' arrivare gia' fra parentesi
 * dal router.
 */
export function hostPortJoin(host: string, port: string): string {
  const trimmedHost = host.trim();
  const trimmedPort = port.trim();
  const bare =
    trimmedHost.startsWith('[') && trimmedHost.endsWith(']')
      ? trimmedHost.slice(1, -1)
      : trimmedHost;

  const addr = parseIp(bare);
  const shown = addr && addr.family === 6 ? `[${bare}]` : bare;
  return trimmedPort ? `${shown}:${trimmedPort}` : shown;
}

/**
 * Chiave di ordinamento: esadecimale a larghezza fissa, con la famiglia in testa.
 *
 * La larghezza fissa e' il punto. localeCompare con numeric azzecca
 * "192.168.10.9" < "192.168.10.10" per caso, perche' li' i numeri sono separati
 * da punti, e sbaglia "fd00::9" < "fd00::10", dove non lo sono. La famiglia in
 * testa mette tutti gli IPv4 prima di tutti gli IPv6.
 */
export function sortKey(addr: IpAddr): string {
  let hex = '';
  for (const byte of addr.bytes) hex += byte.toString(16).padStart(2, '0');
  return `${addr.family}${hex}`;
}

// --- Etichette ----------------------------------------------------------------

/** fe80::/10, oppure 169.254/16 in IPv4. */
export function isLinkLocal(addr: IpAddr): boolean {
  if (addr.family === 4) return addr.bytes[0] === 169 && addr.bytes[1] === 254;
  return addr.bytes[0] === 0xfe && (addr.bytes[1] & 0xc0) === 0x80;
}

/**
 * fc00::/7, l'equivalente IPv6 di un indirizzo privato.
 *
 * Decide anche cosa il router annuncia a Tailscale: il prefisso delegato dalla
 * WAN cambia a ogni albergo, l'ULA no.
 */
export function isUla(addr: IpAddr): boolean {
  return addr.family === 6 && (addr.bytes[0] & 0xfe) === 0xfc;
}

/** 2000::/3, cioe' un indirizzo instradabile su Internet. */
export function isGua(addr: IpAddr): boolean {
  return addr.family === 6 && (addr.bytes[0] & 0xe0) === 0x20;
}
