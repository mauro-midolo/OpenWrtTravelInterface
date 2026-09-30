// @vitest-environment jsdom
//
// Le funzioni sono pure, ma lan.ts importa lib/ubus.ts, che legge
// sessionStorage appena il modulo viene caricato.
import { describe, expect, it } from 'vitest';
import { matchRaMode, raValues } from '../src/lib/lan';
import type { LanConfig, RaMode } from '../src/lib/lan';

/** LAN minima: i test scrivono solo i campi RA che li riguardano. */
function lan(fields: Partial<LanConfig> = {}): LanConfig {
  return {
    device: 'br-lan',
    up: true,
    addresses: ['192.168.10.1'],
    netmask: '255.255.255.0',
    addresses6: [],
    ula: '',
    dhcp: { start: '100', limit: '150', leasetime: '12h', ignore: false },
    dns_client: [],
    dns_client6: [],
    dns_upstream: [],
    dnsmasq_section: 'cfg01',
    dhcp_options: [],
    ra: '',
    dhcpv6: '',
    ra_flags: [],
    ra_slaac: '',
    ra_default: '',
    ...fields,
  };
}

/** La LAN che si otterrebbe dopo aver scritto una modalita'. */
function afterWriting(mode: Exclude<RaMode, 'custom'>): LanConfig {
  const v = raValues(mode);
  return lan({
    ra: v.ra,
    dhcpv6: v.dhcpv6,
    ra_flags: v.ra_flags ?? [],
    ra_slaac: v.ra_slaac ?? '',
  });
}

describe('le tre modalita’ e il loro giro completo', () => {
  it.each(['auto', 'slaac', 'off'] as const)('%s si riconosce dopo essere stata scritta', (mode) => {
    // E' la proprieta' che tiene insieme scrittura e rilettura: se le due si
    // disallineassero, la schermata direbbe "Personalizzato" subito dopo aver
    // salvato.
    expect(matchRaMode(afterWriting(mode))).toBe(mode);
  });

  it('automatico e’ la combinazione che fa funzionare Android e Windows insieme', () => {
    const v = raValues('auto');
    expect(v).toEqual({
      ra: 'server',
      dhcpv6: 'server',
      ra_flags: ['managed-config', 'other-config'],
      ra_slaac: '1',
    });
  });

  it('solo SLAAC spegne DHCPv6 ma continua ad annunciare', () => {
    const v = raValues('slaac');
    expect(v.ra).toBe('server');
    expect(v.dhcpv6).toBe('disabled');
    // Senza `managed-config` i client non chiedono un indirizzo al DHCPv6,
    // che e' proprio il senso della scelta.
    expect(v.ra_flags).toEqual(['other-config']);
  });

  it('spento cancella i flag invece di scriverli vuoti', () => {
    const v = raValues('off');
    expect(v.ra).toBe('disabled');
    expect(v.dhcpv6).toBe('disabled');
    // `null` significa "cancella l'opzione": uci una lista vuota non la
    // accetta, ed e' la stessa regola di tutte le altre liste del progetto.
    expect(v.ra_flags).toBeNull();
    expect(v.ra_slaac).toBeNull();
  });
});

describe('matchRaMode', () => {
  it('riconosce un router OpenWrt appena installato', () => {
    // `ra_slaac` NON impostata: e' come nasce un router, ed e' anche lo stato
    // trovato sul dispositivo vero. Pretendere il valore esplicito renderebbe
    // "Personalizzato" la configurazione piu' comune che esista.
    expect(
      matchRaMode(
        lan({
          ra: 'server',
          dhcpv6: 'server',
          ra_flags: ['managed-config', 'other-config'],
          ra_slaac: '',
        }),
      ),
    ).toBe('auto');
  });

  it('accetta ra_slaac scritta esplicitamente a 1', () => {
    expect(
      matchRaMode(
        lan({
          ra: 'server',
          dhcpv6: 'server',
          ra_flags: ['managed-config', 'other-config'],
          ra_slaac: '1',
        }),
      ),
    ).toBe('auto');
  });

  it('spento resta spento anche con i flag di prima ancora scritti', () => {
    // Senza RA non si annuncia niente comunque: pretendere i flag vuoti
    // mostrerebbe "Personalizzato" su un router semplicemente spento.
    expect(
      matchRaMode(lan({ ra: 'disabled', dhcpv6: 'disabled', ra_flags: ['other-config'] })),
    ).toBe('off');
  });

  it.each([
    ['ra_slaac spenta a mano', { ra: 'server', dhcpv6: 'server', ra_flags: ['managed-config', 'other-config'], ra_slaac: '0' }],
    ['flag in ordine diverso', { ra: 'server', dhcpv6: 'server', ra_flags: ['other-config', 'managed-config'], ra_slaac: '1' }],
    ['un flag in piu’', { ra: 'server', dhcpv6: 'server', ra_flags: ['managed-config', 'other-config', 'home-agent'], ra_slaac: '1' }],
    ['relay invece di server', { ra: 'relay', dhcpv6: 'relay', ra_flags: ['managed-config'] }],
    ['dhcpv6 senza ra', { ra: 'disabled', dhcpv6: 'server', ra_flags: [] }],
    ['configurazione vuota', {}],
  ])('risponde custom: %s', (_, fields) => {
    expect(matchRaMode(lan(fields as Partial<LanConfig>))).toBe('custom');
  });

  it('custom non e’ una modalita’ scrivibile', () => {
    // raValues non la accetta nemmeno come tipo: qui si documenta che le
    // scelte offerte sono tre e che la quarta e' solo una risposta.
    const offered: RaMode[] = ['auto', 'slaac', 'off'];
    expect(offered).not.toContain('custom');
  });
});
