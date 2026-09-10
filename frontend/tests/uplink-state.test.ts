// @vitest-environment jsdom
//
// uplinkState e' pura, ma wifi.ts importa lib/ubus.ts, che legge sessionStorage
// appena il modulo viene caricato.
import { describe, expect, it } from 'vitest';
import { ipv6Reach, uplinkState, withUplinkDefaults } from '../src/lib/wifi';
import type { Uplink } from '../src/lib/wifi';

/** Uplink agganciato e su, da cui i casi si ricavano per differenza. */
function uplink(fields: Partial<Uplink> = {}): Uplink {
  return withUplinkDefaults({
    radio: 'radio1',
    band: '5',
    section: 'sta_radio1',
    network: 'wwan_radio1',
    kind: 'wifi',
    enabled: true,
    ssid: 'Hotel',
    up: true,
    ipv4: '192.168.0.43',
    ...fields,
  });
}

describe('uplinkState', () => {
  it('con un indirizzo IPv4 e nessun IPv6 e’ indirizzato, come sempre', () => {
    expect(uplinkState(uplink())).toBe('addressed');
  });

  it('con entrambe le famiglie e’ indirizzato', () => {
    expect(uplinkState(uplink({ ipv6: ['2001:db8::1/64'] }))).toBe('addressed');
  });

  it('con il solo IPv6 e’ indirizzato, non “senza indirizzo”', () => {
    // E' il caso 464XLAT delle reti mobili: senza questa riga una connessione
    // che funziona benissimo resterebbe segnalata come guasta per sempre.
    expect(uplinkState(uplink({ ipv4: '', ipv6: ['2a00:1450::7/64'] }))).toBe('addressed');
  });

  it('senza nessun indirizzo e’ “senza indirizzo”', () => {
    expect(uplinkState(uplink({ ipv4: '', ipv6: [] }))).toBe('no-address');
  });

  it('l’interfaccia giu’ vince su qualunque indirizzo', () => {
    // `up` significa "almeno una delle due famiglie e' su", non "la v4 e' su":
    // e' l'rpcd a comporlo guardando entrambe le interfacce logiche. Falso qui
    // vuol dire quindi che sono giu' tutte e due, e degli indirizzi ancora
    // elencati sono un residuo di una riconfigurazione in corso.
    expect(uplinkState(uplink({ up: false }))).toBe('no-address');
    expect(uplinkState(uplink({ up: false, ipv4: '', ipv6: ['2001:db8::1/64'] }))).toBe(
      'no-address',
    );
  });

  it('un uplink v6-only e’ su, e quindi indirizzato', () => {
    // Il caso completo, com'e' fatto davvero: nessun IPv4 perche' il lease
    // DHCPv4 non arriva mai, `up` vero perche' il gemello v6 e' su, gateway e
    // DNS solo v6. E' la riga che il review ha visto classificata male.
    const v6only = uplink({
      ipv4: '',
      netmask: '',
      gateway: '',
      dns: [],
      up: true,
      ipv6: ['2a00:1450:4001:80f::200e/64'],
      gateway6: 'fe80::1',
      dns6: ['2606:4700:4700::1111'],
    });
    expect(uplinkState(v6only)).toBe('addressed');
  });

  it('non associata viene prima di qualunque indirizzo', () => {
    expect(uplinkState(uplink({ ssid: '', ipv6: ['2001:db8::1/64'] }))).toBe('unassociated');
  });

  it('disattivata viene prima di tutto', () => {
    expect(uplinkState(uplink({ enabled: false, ssid: '', ipv4: '' }))).toBe('disabled');
    expect(uplinkState(uplink({ enabled: false, ipv6: ['2001:db8::1/64'] }))).toBe('disabled');
  });
});

describe('fin dove arriva IPv6', () => {
  it('senza indirizzi non c’e’ IPv6', () => {
    expect(ipv6Reach(uplink())).toBe('none');
  });

  it('con indirizzo e gateway si esce', () => {
    expect(ipv6Reach(uplink({ ipv6: ['2a00:1450::7/64'], gateway6: 'fe80::1' }))).toBe('internet');
  });

  it('con indirizzo e SENZA gateway IPv6 resta in casa', () => {
    // Il caso vero, visto su una FRITZ!Box senza IPv6 dal provider: annuncia un
    // prefisso ULA ma nessuna rotta predefinita - router lifetime a zero - e
    // fa bene. L'indirizzo e' valido, il gateway non esiste, e verso Internet
    // si esce in IPv4. Un trattino li' farebbe sospettare un guasto che non c'e'.
    expect(
      ipv6Reach(uplink({ ipv6: ['fdbd:e14b:8a72:0:9683:c4ff:fed6:c74d/64'], gateway6: '' })),
    ).toBe('local');
  });

  it('vale il gateway, non la forma dell’indirizzo', () => {
    // Un ULA con un gateway esce davvero (c'e' chi instrada gli ULA), e una GUA
    // senza gateway non esce: a decidere e' la rotta predefinita.
    expect(ipv6Reach(uplink({ ipv6: ['fd00::1/64'], gateway6: 'fe80::1' }))).toBe('internet');
    expect(ipv6Reach(uplink({ ipv6: ['2a00:1450::7/64'], gateway6: '' }))).toBe('local');
  });
});

describe('withUplinkDefaults', () => {
  it('normalizza il numero di bit che ubus manda davvero', () => {
    // ubus riporta `mask: 24`, non "255.255.255.0": e' il motivo per cui il
    // rilevamento dei conflitti non ha mai funzionato contro un router vero.
    expect(withUplinkDefaults({ ...uplink(), netmask: '24' }).netmask).toBe('255.255.255.0');
    expect(withUplinkDefaults({ ...uplink(), netmask: '8' }).netmask).toBe('255.0.0.0');
    expect(withUplinkDefaults({ ...uplink(), netmask: '0' }).netmask).toBe('0.0.0.0');
    expect(withUplinkDefaults({ ...uplink(), netmask: '32' }).netmask).toBe('255.255.255.255');
  });

  it('lascia stare una maschera gia’ puntata', () => {
    expect(withUplinkDefaults({ ...uplink(), netmask: '255.255.255.0' }).netmask).toBe(
      '255.255.255.0',
    );
  });

  it('svuota quello che non e’ una maschera, invece di inventarla', () => {
    // Vuoto significa "non si sa", e chi legge ricade sul suo valore
    // predefinito. Un valore inventato produrrebbe conflitti inventati.
    for (const raw of ['33', '999', '255.0.255.0', 'boh', '', undefined]) {
      expect(withUplinkDefaults({ ...uplink(), netmask: raw }).netmask).toBe('');
    }
  });
});
