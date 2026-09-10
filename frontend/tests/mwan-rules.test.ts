// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../src/lib/ubus';
import {
  addRule,
  globalPolicy,
  policyFor,
  ruleFamily,
  setDefaultRule,
  setEnabled,
  setPriorityOrder,
  setWeight,
} from '../src/lib/mwan';

vi.mock('../src/lib/ubus', async (original) => ({
  ...(await original<typeof import('../src/lib/ubus')>()),
  call: vi.fn(),
}));

const rpc = vi.mocked(call);

/** Tutte le sezioni scritte, con i valori. */
function writes() {
  return rpc.mock.calls
    .filter((c) => c[1] === 'set' || c[1] === 'add')
    .map((c) => c[2] as { config: string; section?: string; name?: string; values: Record<string, unknown> })
    .map((a) => ({ key: `${a.config}.${a.section ?? a.name}`, values: a.values }));
}

function valuesOf(key: string): Record<string, unknown> | undefined {
  return writes().find((w) => w.key === key)?.values;
}

/** Ogni `uci get` risponde: tutte le gemelle IPv6 esistono. */
function withTwins() {
  rpc.mockImplementation(async (_o, method) => (method === 'get' ? { values: {} } : {}));
}

/** Nessuna gemella IPv6: il router non e' ancora aggiornato. */
function withoutTwins() {
  rpc.mockImplementation(async (_o, method) => {
    if (method === 'get') throw new Error('non trovata');
    return {};
  });
}

beforeEach(() => {
  rpc.mockReset();
  withTwins();
});

describe('la famiglia di una regola si deduce dai criteri', () => {
  it.each([
    [{ dest_ip: '10.0.0.0/8' }, 4],
    [{ dest_ip: '2001:db8::/32' }, 6],
    [{ src_ip: 'fd00::1', dest_ip: '2001:db8::/32' }, 6],
    [{ src_ip: '192.168.1.5', dest_ip: '10.0.0.0/8' }, 4],
    // Nessun criterio: la regola vale per tutto, e resta IPv4 come prima.
    [{}, 4],
  ])('%o -> famiglia %i', (input, family) => {
    expect(ruleFamily(input)).toBe(family);
  });

  it('rifiuta una regola che mescola le due famiglie', () => {
    // `mwan3.<rule>.family` e' un valore solo: scritta comunque, uno dei due
    // criteri non combacerebbe mai - cioe' una regola che non si applica, in
    // silenzio.
    expect(ruleFamily({ src_ip: '192.168.1.5', dest_ip: '2001:db8::/32' })).toBeNull();
    expect(ruleFamily({ src_ip: 'fd00::1', dest_ip: '10.0.0.0/8' })).toBeNull();
  });

  it('e il rifiuto arriva prima di scrivere qualunque cosa', async () => {
    const input = {
      src_ip: '192.168.1.5',
      dest_ip: '2001:db8::/32',
      dest_port: '',
      proto: 'all',
      network: 'wan',
      strict: false,
      sticky: false,
      timeout: 600,
    };

    await expect(
      addRule(input, { mode: 'failover', sticky: false, timeout: 600 }),
    ).rejects.toThrow('mescola');
    expect(writes()).toHaveLength(0);
  });
});

describe('i nomi delle politiche', () => {
  it('quelle IPv6 stanno dentro il limite dei 15 caratteri di mwan3', () => {
    // `travel_failover6` ne farebbe 16, e mwan3 la rifiuterebbe in silenzio -
    // lo stesso limite che ha gia' morso con `only_wwan_radio0`.
    for (const mode of ['failover', 'balance'] as const) {
      expect(globalPolicy(mode, 6).length).toBeLessThanOrEqual(15);
    }
    expect(globalPolicy('failover', 6)).toBe('travel_fail6');
    expect(globalPolicy('balance', 6)).toBe('travel_bal6');
  });

  it('quelle per WAN puntano alla gemella, non a una variante', () => {
    expect(policyFor('wan', true)).toBe('o_wan');
    expect(policyFor('wan', true, 6)).toBe('o_wan6');
    expect(policyFor('wan', false, 6)).toBe('p_wan6');
    expect(policyFor('wwan_radio0', true, 6).length).toBeLessThanOrEqual(15);
  });

  it('una regola IPv6 usa la politica IPv6', async () => {
    await addRule(
      {
        src_ip: '',
        dest_ip: '2001:db8::/32',
        dest_port: '',
        proto: 'all',
        network: 'wan',
        strict: true,
        sticky: false,
        timeout: 600,
      },
      { mode: 'failover', sticky: false, timeout: 600 },
    );

    const rule = writes().find((w) => w.values.dest_ip === '2001:db8::/32');
    expect(rule?.values.family).toBe('ipv6');
    expect(rule?.values.use_policy).toBe('o_wan6');
  });
});

describe('le due famiglie si scrivono insieme', () => {
  it('la priorita’ tocca membro, interfaccia e le due gemelle', async () => {
    await setPriorityOrder(['wan', 'wwan_radio0']);

    expect(valuesOf('mwan3.wan_f')).toEqual({ metric: '10' });
    expect(valuesOf('network.wan')).toEqual({ metric: '10' });
    expect(valuesOf('mwan3.wan6_f')).toEqual({ metric: '10' });
    expect(valuesOf('network.wan6')).toEqual({ metric: '10' });
    // Priorita' disallineate manderebbero v4 e v6 su WAN diverse: meta' del web
    // che carica, molto piu' difficile da diagnosticare di un guasto pulito.
    expect(valuesOf('mwan3.wwan_radio06_f')).toEqual({ metric: '20' });
  });

  it('il peso e l’esclusione toccano entrambe', async () => {
    await setWeight('wan', 3);
    expect(valuesOf('mwan3.wan_b')).toEqual({ weight: '3' });
    expect(valuesOf('mwan3.wan6_b')).toEqual({ weight: '3' });

    rpc.mockReset();
    withTwins();
    await setEnabled('wan', false);
    // Escludere una WAN in una famiglia sola non e' una mezza esclusione: e' una
    // WAN che continua a portare meta' del traffico dopo che si e' detto di
    // toglierla.
    expect(valuesOf('mwan3.wan')).toEqual({ enabled: '0' });
    expect(valuesOf('mwan3.wan6')).toEqual({ enabled: '0' });
  });

  it('la modalita’ vale per tutte e due le predefinite', async () => {
    await setDefaultRule('balance', true, 600);

    expect(valuesOf('mwan3.travel_default')?.use_policy).toBe('travel_balance');
    expect(valuesOf('mwan3.travel_default6')?.use_policy).toBe('travel_bal6');
  });
});

describe('un router senza le gemelle IPv6', () => {
  beforeEach(() => {
    rpc.mockReset();
    withoutTwins();
  });

  it('continua a scrivere la meta’ IPv4 senza fallire', async () => {
    // Un router non ancora aggiornato le sezioni `<net>6` non le ha: trattare
    // la loro assenza come un errore bloccherebbe una modifica IPv4 valida.
    await setPriorityOrder(['wan']);

    expect(valuesOf('mwan3.wan_f')).toEqual({ metric: '10' });
    expect(valuesOf('mwan3.wan6_f')).toBeUndefined();
  });

  it('non inventa la predefinita IPv6', async () => {
    await setDefaultRule('failover', false, 600);

    expect(valuesOf('mwan3.travel_default')?.use_policy).toBe('travel_failover');
    // Crearla qui punterebbe a una politica che mwan3-setup.sh non ha scritto.
    expect(valuesOf('mwan3.travel_default6')).toBeUndefined();
  });
});
