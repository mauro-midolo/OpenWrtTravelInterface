// @vitest-environment jsdom
//
// Le funzioni qui sotto sono pure, ma lan.ts importa lib/ubus.ts, che legge
// sessionStorage appena viene caricato: senza un DOM il file non si carica
// nemmeno.
import { describe, expect, it } from 'vitest';
import { LAN_NETMASK, checkPool, findConflicts, suggestAddress } from '../src/lib/lan';
import type { WanSubnet } from '../src/lib/lan';

/** WAN in una riga, perche' i test parlino di reti e non di oggetti. */
function wan(label: string, ipv4: string, netmask = '255.255.255.0'): WanSubnet {
  return { label, ipv4, netmask };
}

/** I sette candidati di suggestAddress, nell'ordine in cui li prova. */
const CANDIDATES = [
  '192.168.10.1',
  '192.168.42.1',
  '192.168.77.1',
  '10.44.1.1',
  '10.77.9.1',
  '172.31.9.1',
  '192.168.123.1',
];

describe('findConflicts', () => {
  it('trova la collisione che il simulatore mette in scena', () => {
    // Il mock nasce apposta con la LAN su 192.168.0.1/24 e le WiFi sulla stessa
    // sottorete: e' il caso dell'albergo, ed e' il motivo per cui la schermata
    // esiste.
    const conflicts = findConflicts('192.168.0.1', LAN_NETMASK, [
      wan('WiFi 5 GHz', '192.168.0.76'),
      wan('WiFi 2.4 GHz', '192.168.0.43'),
      wan('USB', '192.168.42.129'),
    ]);
    expect(conflicts.map((c) => c.label)).toEqual(['WiFi 5 GHz', 'WiFi 2.4 GHz']);
    expect(conflicts[0].ipv4).toBe('192.168.0.76/255.255.255.0');
  });

  it('non trova niente quando le sottoreti sono diverse', () => {
    expect(findConflicts('192.168.10.1', LAN_NETMASK, [
      wan('WiFi', '192.168.0.76'),
      wan('USB', '192.168.42.129'),
    ])).toEqual([]);
  });

  it('vede la collisione anche quando la WAN ha una maschera piu’ larga', () => {
    // La WAN e' una /16 che contiene la /24 della LAN: contenuta e' collisione.
    expect(findConflicts('192.168.10.1', LAN_NETMASK, [
      wan('Albergo', '192.168.5.3', '255.255.0.0'),
    ])).toHaveLength(1);
  });

  it('senza netmask assume una /24 invece di saltare la WAN', () => {
    // La netmask puo' mancare: una WAN appena salita, o un rpcd vecchio. Saltare
    // la rete significherebbe non segnalare un conflitto che c'e'.
    const conflicts = findConflicts('192.168.0.1', LAN_NETMASK, [wan('WiFi', '192.168.0.76', '')]);
    expect(conflicts).toHaveLength(1);
    // E si vede nel testo mostrato che la maschera non era nota.
    expect(conflicts[0].ipv4).toBe('192.168.0.76/?');
  });

  it('salta le WAN senza indirizzo', () => {
    expect(findConflicts('192.168.0.1', LAN_NETMASK, [
      wan('Spenta', ''),
      wan('WiFi', '192.168.0.76'),
    ])).toHaveLength(1);
  });

  it('resta vuoto se l’indirizzo della LAN non e’ valido', () => {
    expect(findConflicts('non un indirizzo', LAN_NETMASK, [wan('WiFi', '192.168.0.76')])).toEqual([]);
    expect(findConflicts('192.168.0.1', 'non una maschera', [wan('WiFi', '192.168.0.76')])).toEqual([]);
    // Maschera non contigua: non e' una rete, quindi non si risponde a caso.
    expect(findConflicts('192.168.0.1', '255.0.255.0', [wan('WiFi', '192.168.0.76')])).toEqual([]);
  });

  it('una WAN IPv6 non produce mai un conflitto', () => {
    // Il prefisso v6 della LAN arriva dalla delega e non lo sceglie nessuno:
    // non ci sarebbe niente da proporre, quindi non c'e' niente da segnalare.
    // Vale anche per la meta' v6 di una WAN dual-stack.
    expect(findConflicts('192.168.0.1', LAN_NETMASK, [
      wan('WiFi v6', '2001:db8::1', '255.255.255.0'),
      wan('ULA', 'fd66:67c3:698b::1', ''),
    ])).toEqual([]);

    // La meta' v4 continua invece a contare.
    expect(findConflicts('192.168.0.1', LAN_NETMASK, [
      wan('Dual-stack', '192.168.0.76'),
      wan('Solo v6', '2001:db8::1'),
    ])).toHaveLength(1);
  });
});

describe('suggestAddress', () => {
  it('propone il primo candidato libero', () => {
    expect(suggestAddress('192.168.0.1', [wan('WiFi', '192.168.0.76')])).toBe('192.168.10.1');
  });

  it('salta i candidati occupati da una WAN', () => {
    // 192.168.10.x e 192.168.42.x sono presi: tocca al terzo della lista.
    expect(
      suggestAddress('192.168.0.1', [
        wan('WiFi', '192.168.10.50'),
        wan('USB', '192.168.42.129'),
      ]),
    ).toBe('192.168.77.1');
  });

  it('non ripropone l’indirizzo su cui il router e’ gia’', () => {
    // Il primo candidato e' anche quello attuale: proporlo non risolverebbe
    // niente, quindi si passa al successivo.
    expect(suggestAddress('192.168.10.1', [])).toBe('192.168.42.1');
  });

  it('ritorna null quando tutti e sette i candidati sono occupati', () => {
    const wans = CANDIDATES.map((address, i) => wan(`WAN ${i}`, address.replace(/\.1$/, '.200')));
    expect(suggestAddress('192.168.0.1', wans)).toBeNull();
  });

  it('ritorna null anche con una sola WAN che prende tutto', () => {
    // Una rotta 0.0.0.0/0 non e' plausibile su una WAN vera, ma dimostra che il
    // controllo guarda la sovrapposizione e non l'uguaglianza degli indirizzi.
    expect(suggestAddress('192.168.0.1', [wan('Tutto', '10.0.0.1', '0.0.0.0')])).toBeNull();
  });

  it('una WAN IPv6 non toglie candidati', () => {
    expect(suggestAddress('192.168.0.1', [wan('v6', '2001:db8::1')])).toBe('192.168.10.1');
  });
});

describe('checkPool', () => {
  it('accetta un pool valido che non contiene il router', () => {
    expect(checkPool('192.168.10.1', 100, 249)).toBeNull();
  });

  it.each([
    [1, 100, 'fra 2 e 254'],
    [100, 255, 'fra 2 e 254'],
    [2, 300, 'fra 2 e 254'],
    [200, 100, 'minore o uguale'],
  ])('rifiuta il pool %i-%i', (from, to, expected) => {
    expect(checkPool('192.168.10.1', from, to)?.message).toContain(expected);
  });

  it('rifiuta i valori che non sono numeri interi', () => {
    expect(checkPool('192.168.10.1', 10.5, 100)?.message).toContain('numeri');
    expect(checkPool('192.168.10.1', NaN, 100)?.message).toContain('numeri');
  });

  it('avvisa quando l’indirizzo del router cade dentro il pool', () => {
    // Il DHCP lo assegnerebbe a un dispositivo, e due macchine con lo stesso
    // indirizzo sono una rete che smette di funzionare a intermittenza.
    const problem = checkPool('192.168.10.150', 100, 249);
    expect(problem?.message).toContain('(.150)');
  });

  it('accetta il router appena fuori dagli estremi del pool', () => {
    expect(checkPool('192.168.10.99', 100, 249)).toBeNull();
    expect(checkPool('192.168.10.250', 100, 249)).toBeNull();
  });

  it('regge un indirizzo del router che non si puo’ leggere', () => {
    // lastOctet risponde null, e il pool resta valido: l'indirizzo ha gia' il
    // suo controllo, e due errori sullo stesso campo confonderebbero.
    expect(checkPool('', 100, 249)).toBeNull();
    expect(checkPool('fd66:67c3:698b::1', 100, 249)).toBeNull();
  });
});
