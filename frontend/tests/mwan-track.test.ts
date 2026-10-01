// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../src/lib/ubus';
import { setHealth, trackState } from '../src/lib/mwan';

vi.mock('../src/lib/ubus', async (original) => ({
  ...(await original<typeof import('../src/lib/ubus')>()),
  call: vi.fn(),
}));

const rpc = vi.mocked(call);

/** I valori scritti in una sezione mwan3. */
function written(section: string): Record<string, unknown> | undefined {
  const hit = rpc.mock.calls.find(
    (c) => c[1] === 'set' && (c[2] as { section: string }).section === section,
  );
  return (hit?.[2] as { values: Record<string, unknown> } | undefined)?.values;
}

/** Una gemella IPv6 con questi indirizzi, o nessuna gemella. */
function twin(trackIp: string[] | string | null) {
  rpc.mockImplementation(async (_o, method) => {
    if (method !== 'get') return {};
    if (trackIp === null) throw new Error('not found');
    return { values: { track_ip: trackIp } };
  });
}

const health = (ips: string[], reliability: number) => ({
  track_ip: ips,
  interval: 5,
  timeout: 2,
  count: 1,
  up: 3,
  down: 3,
  reliability,
});

beforeEach(() => rpc.mockReset());

// mwan3track pinga i tracking IP in ordine e si ferma appena `reliability` ne
// hanno risposto: gli altri escono come "skipped". Mostrarli come
// irraggiungibili faceva sembrare guasto il secondo IP, qualunque fosse.
describe('trackState', () => {
  it('keeps the states mwan3track reports', () => {
    expect(trackState('up')).toBe('up');
    expect(trackState('down')).toBe('down');
    expect(trackState('skipped')).toBe('skipped');
  });

  it('does not turn anything else into "down"', () => {
    expect(trackState('unknown')).toBe('unknown');
    expect(trackState('')).toBe('unknown');
    expect(trackState('whatever')).toBe('unknown');
  });
});

describe('setHealth', () => {
  const four = ['9.9.9.9', '1.1.1.1', '208.67.222.222', '208.67.220.220'];

  it('writes every address and how many must answer', async () => {
    twin(null);
    await setHealth('wan', health(four, 3));
    expect(written('wan')).toMatchObject({ track_ip: four, reliability: '3' });
  });

  it('never asks more answers than there are addresses', async () => {
    twin(null);
    await setHealth('wan', health(['9.9.9.9'], 2));
    expect(written('wan')).toMatchObject({ reliability: '1' });
  });

  // "Tutti e 4" sulla gemella con due indirizzi v6 la terrebbe giu' per sempre.
  it('caps the IPv6 twin to its own addresses', async () => {
    twin(['2620:fe::fe', '2a0d:2a00:1::']);
    await setHealth('wan', health(four, 4));
    expect(written('wan')).toMatchObject({ reliability: '4' });
    expect(written('wan6')).toMatchObject({ reliability: '2', interval: '5' });
    expect(written('wan6')).not.toHaveProperty('track_ip');
  });

  it('reads a single twin address as one', async () => {
    twin('2620:fe::fe');
    await setHealth('wan', health(four, 2));
    expect(written('wan6')).toMatchObject({ reliability: '1' });
  });

  it('leaves a missing twin alone', async () => {
    twin(null);
    await setHealth('wan', health(four, 2));
    expect(written('wan6')).toBeUndefined();
  });
});
