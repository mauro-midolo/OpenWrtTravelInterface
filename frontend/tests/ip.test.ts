import { describe, expect, it } from 'vitest';
import {
  contains,
  formatIp,
  hostForUrl,
  hostPortJoin,
  hostPortSplit,
  isGua,
  isLinkLocal,
  isUla,
  isValidIp,
  maskToPrefix,
  overlaps,
  parseCidr,
  parseIp,
  prefixToMask,
  sortKey,
  subnetOf,
  subnetOfMask,
} from '../src/lib/ip';

/** Riscrive un indirizzo passando per l'analisi: null se non e' valido. */
function roundTrip(text: string): string | null {
  const addr = parseIp(text);
  return addr === null ? null : formatIp(addr);
}

/** Rete da testo, per non ripetere il non-null in ogni confronto. */
function net(text: string) {
  const parsed = parseCidr(text);
  if (!parsed) throw new Error(`rete non valida nel test: ${text}`);
  return parsed;
}

function addr(text: string) {
  const parsed = parseIp(text);
  if (!parsed) throw new Error(`indirizzo non valido nel test: ${text}`);
  return parsed;
}

describe('analisi IPv4', () => {
  it.each([
    ['0.0.0.0', '0.0.0.0'],
    ['255.255.255.255', '255.255.255.255'],
    ['192.168.10.1', '192.168.10.1'],
    ['  10.0.0.1  ', '10.0.0.1'],
  ])('accetta %s', (input, expected) => {
    expect(roundTrip(input)).toBe(expected);
  });

  it.each([
    ['1.2.3'], ['1.2.3.4.5'], ['1.2.3.256'], ['1.2.3.-1'], ['1.2.3.a'],
    ['1.2.3.'], ['.1.2.3'], [''], ['   '], ['1.2.3.4/24'],
  ])('rifiuta %s', (input) => {
    expect(parseIp(input)).toBeNull();
  });

  it('rifiuta gli zeri iniziali, che alcuni stack leggono come ottali', () => {
    // Cambio deliberato rispetto alla vecchia isValidIp di lan.ts: "010" vale 8
    // per inet_aton e 10 per il resto del mondo, quindi non e' un indirizzo, e'
    // un'ambiguita'.
    expect(parseIp('010.0.0.1')).toBeNull();
    expect(parseIp('192.168.010.1')).toBeNull();
    // Lo zero singolo resta valido: non c'e' niente di ambiguo in "0".
    expect(roundTrip('0.0.0.0')).toBe('0.0.0.0');
  });
});

describe('analisi IPv6', () => {
  it.each([
    ['::', '::'],
    ['::1', '::1'],
    ['fe80::1', 'fe80::1'],
    ['2001:DB8::1', '2001:db8::1'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
    ['1:2:3:4:5:6:7::', '1:2:3:4:5:6:7:0'],
    ['::ffff:192.168.1.1', '::ffff:c0a8:101'],
    ['::192.168.1.1', '::c0a8:101'],
  ])('accetta %s come %s', (input, expected) => {
    expect(roundTrip(input)).toBe(expected);
  });

  it.each([
    ['1::2::3'], [':::'], ['1:2:3:4:5:6:7'], ['1:2:3:4:5:6:7:8:9'],
    ['12345::'], ['::g'], [':1:2:3:4:5:6:7:8'], ['1:2:3:4:5:6:7:8:'],
    ['1:2:3:4:5:6:7:8::'], ['1.2.3.4::'], ['::ffff:192.168.1.256'],
    ['::ffff:1.2.3.4.5'], ['192.168.1.1:80'],
  ])('rifiuta %s', (input) => {
    expect(parseIp(input)).toBeNull();
  });

  it('accetta la zone id solo su IPv6 e solo se non e’ vuota', () => {
    expect(roundTrip('fe80::1%eth0')).toBe('fe80::1%eth0');
    expect(parseIp('fe80::1%')).toBeNull();
    expect(parseIp('1.2.3.4%eth0')).toBeNull();
  });
});

describe('formattazione canonica (RFC 5952)', () => {
  it.each([
    // Il run piu' lungo vince, non il primo che si incontra.
    ['2001:db8:0:1:0:0:0:1', '2001:db8:0:1::1'],
    // A parita' di lunghezza vince il piu' a sinistra.
    ['1:0:0:2:0:0:0:3', '1:0:0:2::3'],
    // Il run puo' finire in coda.
    ['0:0:1:0:0:0:0:0', '0:0:1::'],
    // Un gruppo solo non si comprime mai.
    ['1:0:2:3:4:5:6:7', '1:0:2:3:4:5:6:7'],
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
  ])('%s diventa %s', (input, expected) => {
    expect(roundTrip(input)).toBe(expected);
  });

  it('e’ stabile: riformattare una forma canonica non la cambia', () => {
    for (const text of ['2001:db8:0:1::1', '1:0:0:2::3', '0:0:1::', '::', '::1']) {
      expect(roundTrip(text)).toBe(text);
    }
  });
});

describe('isValidIp con la firma allargata', () => {
  it('senza famiglia accetta entrambe', () => {
    expect(isValidIp('192.168.1.1')).toBe(true);
    expect(isValidIp('2001:db8::1')).toBe(true);
    expect(isValidIp('non un indirizzo')).toBe(false);
  });

  it('con la famiglia esclude l’altra', () => {
    expect(isValidIp('192.168.1.1', 4)).toBe(true);
    expect(isValidIp('192.168.1.1', 6)).toBe(false);
    expect(isValidIp('2001:db8::1', 6)).toBe(true);
    expect(isValidIp('2001:db8::1', 4)).toBe(false);
  });
});

describe('parseCidr', () => {
  it('senza prefisso vale l’indirizzo singolo', () => {
    expect(parseCidr('192.168.1.1')?.prefix).toBe(32);
    expect(parseCidr('2001:db8::1')?.prefix).toBe(128);
  });

  it.each([
    ['10.0.0.0/8', 8], ['10.0.0.0/0', 0], ['10.0.0.0/32', 32],
    ['2001:db8::/32', 32], ['::/0', 0], ['2001:db8::1/128', 128],
  ])('accetta %s', (input, prefix) => {
    expect(parseCidr(input)?.prefix).toBe(prefix);
  });

  it.each([
    // Il range e' convalidato sulla famiglia: /128 su IPv4 e' un errore tanto
    // quanto /129 su IPv6. La vecchia regex /^\d{1,2}$/ di MultiWan accettava
    // /33 e non sapeva esprimere /128.
    ['10.0.0.0/33'], ['10.0.0.0/128'], ['::/129'], ['::/999'],
    ['10.0.0.0/'], ['10.0.0.0/-1'], ['10.0.0.0/8/8'], ['/8'], ['10.0.0.0/ 8 8'],
  ])('rifiuta %s', (input) => {
    expect(parseCidr(input)).toBeNull();
  });
});

describe('maschere IPv4', () => {
  it.each([
    ['0.0.0.0', 0], ['128.0.0.0', 1], ['255.0.0.0', 8],
    ['255.255.255.0', 24], ['255.255.255.252', 30], ['255.255.255.255', 32],
  ])('%s vale /%i', (mask, prefix) => {
    expect(maskToPrefix(mask)).toBe(prefix);
    expect(prefixToMask(prefix)).toBe(mask);
  });

  it.each([['255.0.255.0'], ['255.255.0.255'], ['0.0.0.1'], ['non una maschera'], ['::']])(
    'rifiuta la maschera non contigua %s',
    (mask) => {
      expect(maskToPrefix(mask)).toBeNull();
    },
  );
});

describe('sottoreti', () => {
  it('subnetOf azzera i bit di host in entrambe le famiglie', () => {
    expect(formatIp(subnetOf(net('192.168.10.37/24')).addr)).toBe('192.168.10.0');
    expect(formatIp(subnetOf(net('192.168.10.37/26')).addr)).toBe('192.168.10.0');
    expect(formatIp(subnetOf(net('192.168.10.90/26')).addr)).toBe('192.168.10.64');
    expect(formatIp(subnetOf(net('2001:db8:1:2::abcd/64')).addr)).toBe('2001:db8:1:2::');
    expect(formatIp(subnetOf(net('2001:db8:1:2::abcd/60')).addr)).toBe('2001:db8:1::');
  });

  it('subnetOfMask e’ solo IPv4, perche’ la maschera puntata in IPv6 non esiste', () => {
    expect(formatIp(subnetOfMask('192.168.10.37', '255.255.255.0')!.addr)).toBe('192.168.10.0');
    expect(subnetOfMask('2001:db8::1', '255.255.255.0')).toBeNull();
    expect(subnetOfMask('192.168.10.37', '255.0.255.0')).toBeNull();
  });

  it('contains', () => {
    expect(contains(net('192.168.10.0/24'), addr('192.168.10.37'))).toBe(true);
    expect(contains(net('192.168.10.0/24'), addr('192.168.11.37'))).toBe(false);
    expect(contains(net('2001:db8::/32'), addr('2001:db8:1:2::1'))).toBe(true);
    expect(contains(net('2001:db8::/32'), addr('2001:db9::1'))).toBe(false);
    // Famiglie diverse: mai contenuto.
    expect(contains(net('0.0.0.0/0'), addr('2001:db8::1'))).toBe(false);
  });
});

describe('overlaps', () => {
  it.each([
    ['192.168.10.0/24', '192.168.10.0/24', true],
    ['192.168.10.0/24', '192.168.0.0/16', true],
    ['192.168.10.0/24', '192.168.11.0/24', false],
    ['10.0.0.0/8', '0.0.0.0/0', true],
    ['2001:db8::/32', '2001:db8:1::/48', true],
    ['2001:db8::/32', '2001:db9::/32', false],
    ['fd00::/8', '::/0', true],
  ])('%s con %s vale %s', (a, b, expected) => {
    expect(overlaps(net(a), net(b))).toBe(expected);
    // La sovrapposizione e' simmetrica: se non lo fosse, findConflicts
    // troverebbe conflitti diversi a seconda dell'ordine delle WAN.
    expect(overlaps(net(b), net(a))).toBe(expected);
  });

  it('fra famiglie diverse e’ sempre falso, anche fra due default', () => {
    // Riga portante: senza, la LAN IPv4 confrontata con una WAN IPv6
    // produrrebbe conflitti inventati e la schermata proporrebbe di cambiare
    // indirizzo per niente.
    expect(overlaps(net('0.0.0.0/0'), net('::/0'))).toBe(false);
    expect(overlaps(net('192.168.10.0/24'), net('2001:db8::/32'))).toBe(false);
    expect(overlaps(net('::/0'), net('192.168.10.0/24'))).toBe(false);
  });
});

describe('host per URL', () => {
  it.each([
    ['2001:db8::1', '[2001:db8::1]'],
    ['fe80::1%eth0', '[fe80::1]'],
    ['2001:0db8:0:0:0:0:0:1', '[2001:db8::1]'],
    ['192.168.10.1', '192.168.10.1'],
    ['router.local', 'router.local'],
    ['  router.local  ', 'router.local'],
  ])('%s diventa %s', (input, expected) => {
    expect(hostForUrl(input)).toBe(expected);
  });
});

describe('host e porta', () => {
  it.each([
    ['vpn.example.com:51820', 'vpn.example.com', '51820'],
    ['vpn.example.com', 'vpn.example.com', ''],
    ['192.0.2.1:51820', '192.0.2.1', '51820'],
    ['[2001:db8::1]:51820', '2001:db8::1', '51820'],
    ['[2001:db8::1]', '2001:db8::1', ''],
    // Il caso che il vecchio codice sbagliava: senza parentesi non c'e' porta.
    ['2001:db8::1', '2001:db8::1', ''],
    ['fe80::1%eth0', 'fe80::1%eth0', ''],
  ])('%s si separa in %s e %s', (input, host, port) => {
    expect(hostPortSplit(input)).toEqual({ host, port });
  });

  it.each([
    ['vpn.example.com', '51820', 'vpn.example.com:51820'],
    ['192.0.2.1', '51820', '192.0.2.1:51820'],
    ['2001:db8::1', '51820', '[2001:db8::1]:51820'],
    // Idempotente: l'host puo' arrivare gia' fra parentesi dal router.
    ['[2001:db8::1]', '51820', '[2001:db8::1]:51820'],
    ['2001:db8::1', '', '[2001:db8::1]'],
    ['vpn.example.com', '', 'vpn.example.com'],
  ])('%s + %s si ricompone in %s', (host, port, expected) => {
    expect(hostPortJoin(host, port)).toBe(expected);
  });

  it('senza parentesi la ricomposizione produrrebbe un indirizzo diverso', () => {
    // Il caso silenzioso: una porta di quattro cifre e' anche un gruppo
    // esadecimale, quindi "2001:db8::1" + "443" concatenati alla buona danno
    // "2001:db8::1:443", che e' valido e NON e' lo stesso host. Niente protesta
    // e il traffico va altrove.
    expect(isValidIp('2001:db8::1:443', 6)).toBe(true);
    expect(roundTrip('2001:db8::1:443')).not.toBe(roundTrip('2001:db8::1'));
    expect(hostPortJoin('2001:db8::1', '443')).toBe('[2001:db8::1]:443');

    // Con cinque cifre esce invece una stringa invalida, e il guasto si vede
    // subito: e' il caso MENO pericoloso, non il piu' pericoloso.
    expect(isValidIp('2001:db8::1:51820', 6)).toBe(false);
    expect(hostPortJoin('2001:db8::1', '51820')).toBe('[2001:db8::1]:51820');
  });

  it('regge il giro completo su tutte e quattro le forme', () => {
    for (const text of ['vpn.example.com:51820', '[2001:db8::1]:51820', '[2001:db8::1]', '192.0.2.1:51820']) {
      const { host, port } = hostPortSplit(text);
      expect(hostPortJoin(host, port)).toBe(text);
    }
    // Un IPv6 nudo non torna identico, ma torna CORRETTO e stabile al secondo giro.
    const first = hostPortJoin(...(Object.values(hostPortSplit('2001:db8::1')) as [string, string]));
    expect(first).toBe('[2001:db8::1]');
    const { host, port } = hostPortSplit(first);
    expect(hostPortJoin(host, port)).toBe(first);
  });
});

describe('sortKey', () => {
  it('ordina gli IPv6 per valore, dove localeCompare sbaglia', () => {
    const sorted = ['fd00::10', 'fd00::9', 'fd00::2']
      .map(addr)
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
      .map(formatIp);
    expect(sorted).toEqual(['fd00::2', 'fd00::9', 'fd00::10']);
  });

  it('ordina gli IPv4 per valore e non come testo', () => {
    const sorted = ['192.168.10.10', '192.168.10.9', '192.168.10.100']
      .map(addr)
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
      .map(formatIp);
    expect(sorted).toEqual(['192.168.10.9', '192.168.10.10', '192.168.10.100']);
  });

  it('mette ogni IPv4 prima di ogni IPv6', () => {
    const sorted = ['fd00::1', '192.168.10.1', '::', '255.255.255.255', '0.0.0.0']
      .map(addr)
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
      .map(formatIp);
    expect(sorted).toEqual(['0.0.0.0', '192.168.10.1', '255.255.255.255', '::', 'fd00::1']);
  });

  it('la zone id non entra nella chiave: ordina l’indirizzo, non il link', () => {
    expect(sortKey(addr('fe80::1%eth0'))).toBe(sortKey(addr('fe80::1')));
  });
});

describe('etichette', () => {
  it.each([
    ['fd66:67c3:698b::1', { ula: true, linkLocal: false, gua: false }],
    ['fc00::1', { ula: true, linkLocal: false, gua: false }],
    ['fe80::1', { ula: false, linkLocal: true, gua: false }],
    ['fe80::1%eth0', { ula: false, linkLocal: true, gua: false }],
    ['febf::1', { ula: false, linkLocal: true, gua: false }],
    ['2001:db8::1', { ula: false, linkLocal: false, gua: true }],
    ['3fff::1', { ula: false, linkLocal: false, gua: true }],
    ['::1', { ula: false, linkLocal: false, gua: false }],
    ['ff02::1', { ula: false, linkLocal: false, gua: false }],
    // Un IPv4 non e' mai ULA ne' GUA, ma 169.254/16 e' link-local anche li'.
    ['192.168.10.1', { ula: false, linkLocal: false, gua: false }],
    ['169.254.1.1', { ula: false, linkLocal: true, gua: false }],
  ])('%s', (text, expected) => {
    const parsed = addr(text);
    expect({
      ula: isUla(parsed),
      linkLocal: isLinkLocal(parsed),
      gua: isGua(parsed),
    }).toEqual(expected);
  });
});
