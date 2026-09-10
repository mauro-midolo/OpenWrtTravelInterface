// @vitest-environment jsdom
//
// Router a meta' aggiornamento: SPA nuova, pacchetto vecchio.
//
// E' lo stato NORMALE fra il deploy dei due, non un caso limite: il pacchetto
// vecchio non manda nessuno dei campi introdotti dal supporto IPv6. Ogni
// funzione di confine riceve qui la risposta che manderebbe quel router - i
// campi nuovi tolti davvero, non messi a vuoto - e deve restituire il
// comportamento di prima, senza che nessuna schermata debba saperlo.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../src/lib/ubus';
import { getUplinks, uplinkState } from '../src/lib/wifi';
import { getDashboard } from '../src/lib/dashboard';
import { getEthPorts, getLan } from '../src/lib/lan';

vi.mock('../src/lib/ubus', async (original) => ({
  ...(await original<typeof import('../src/lib/ubus')>()),
  call: vi.fn(),
}));

const rpc = vi.mocked(call);

/** Toglie le chiavi indicate, invece di metterle a vuoto: e' la differenza. */
function without<T extends object>(source: T, keys: string[]): T {
  const copy: Record<string, unknown> = { ...source };
  for (const key of keys) delete copy[key];
  return copy as T;
}

const V6_FIELDS = ['ipv6', 'gateway6', 'prefix6', 'dns6'];

beforeEach(() => {
  rpc.mockReset();
});

describe('uplink da un pacchetto vecchio', () => {
  const oldUplink = without(
    {
      kind: 'wifi',
      radio: 'radio1',
      band: '5',
      section: 'sta_radio1',
      network: 'wwan_radio1',
      device: 'phy0.1-sta0',
      enabled: true,
      ssid: 'Hotel',
      up: true,
      ipv4: '192.168.0.43',
      netmask: '24',
      gateway: '192.168.0.1',
      dns: ['192.168.0.1'],
      ipv6: ['non deve arrivare'],
      gateway6: 'non deve arrivare',
      prefix6: 'non deve arrivare',
      dns6: ['non deve arrivare'],
    },
    V6_FIELDS,
  );

  it('riempie i campi mancanti invece di lasciarli undefined', async () => {
    rpc.mockResolvedValue({ uplinks: [oldUplink] });
    const [u] = await getUplinks();

    expect(u.ipv6).toEqual([]);
    expect(u.gateway6).toBe('');
    expect(u.prefix6).toBe('');
    expect(u.dns6).toEqual([]);
  });

  it('si comporta esattamente come prima: indirizzato via IPv4', async () => {
    rpc.mockResolvedValue({ uplinks: [oldUplink] });
    const [u] = await getUplinks();

    expect(uplinkState(u)).toBe('addressed');
    expect(u.ipv4).toBe('192.168.0.43');
    expect(u.gateway).toBe('192.168.0.1');
  });

  it('leggere ipv6 non fa esplodere niente, nemmeno il primo elemento', async () => {
    rpc.mockResolvedValue({ uplinks: [oldUplink] });
    const [u] = await getUplinks();

    // E' la lettura che Connect.tsx fa davvero, e senza il riempimento sarebbe
    // un accesso a undefined[0].
    expect(() => u.ipv6[0]).not.toThrow();
    expect(u.ipv6[0]).toBeUndefined();
    expect(u.ipv6.length).toBe(0);
  });

  it('senza indirizzo resta “senza indirizzo”, non diventa indirizzato', async () => {
    rpc.mockResolvedValue({ uplinks: [without({ ...oldUplink, ipv4: '' }, V6_FIELDS)] });
    const [u] = await getUplinks();
    expect(uplinkState(u)).toBe('no-address');
  });

  it('una risposta senza affatto la chiave uplinks non e’ un errore', async () => {
    rpc.mockResolvedValue({});
    await expect(getUplinks()).resolves.toEqual([]);
  });
});

describe('WAN della dashboard da un pacchetto vecchio', () => {
  const oldWan = without(
    {
      network: 'wwan_radio1',
      kind: 'wifi',
      band: '5',
      radio: 'radio1',
      device: 'phy0.1-sta0',
      section: 'sta_radio1',
      active: true,
      enabled: true,
      carrier: -1,
      driver: '',
      state: 'addressed',
      portal: null,
      ssid: 'Hotel',
      bssid: 'a4:2b:11:22:33:44',
      channel: 44,
      ipv4: '192.168.0.43',
      gateway: '192.168.0.1',
      dns: ['192.168.0.1'],
      mac: '94:83:c4:d6:c7:41',
      metric: 10,
      hostname: '',
      rx_rate: 0,
      tx_rate: 0,
      rx_session: 0,
      tx_session: 0,
      ipv6: ['non deve arrivare'],
      gateway6: 'non deve arrivare',
      prefix6: 'non deve arrivare',
      dns6: ['non deve arrivare'],
    },
    V6_FIELDS,
  );

  it('riempie i campi v6 e lascia intatto tutto il resto', async () => {
    rpc.mockResolvedValue({ wans: [oldWan], system: { hostname: 'router' } });
    const board = await getDashboard();
    const [wan] = board.wans;

    expect(wan.ipv6).toEqual([]);
    expect(wan.gateway6).toBe('');
    expect(wan.prefix6).toBe('');
    expect(wan.dns6).toEqual([]);
    expect(wan.ipv4).toBe('192.168.0.43');
    expect(wan.state).toBe('addressed');
    // I campi fuori da `wans` non vengono toccati dal riempimento.
    expect(board.system.hostname).toBe('router');
  });

  it('una dashboard senza affatto la chiave wans non e’ un errore', async () => {
    rpc.mockResolvedValue({ system: { hostname: 'router' } });
    await expect(getDashboard()).resolves.toMatchObject({ wans: [] });
  });
});

describe('gli altri confini continuano a reggere le risposte vecchie', () => {
  it('getLan toglie il prefisso dagli indirizzi e regge la lista assente', async () => {
    rpc.mockResolvedValue({ device: 'br-lan', up: true, addresses: ['192.168.10.1/24'] });
    await expect(getLan()).resolves.toMatchObject({ addresses: ['192.168.10.1'] });

    rpc.mockResolvedValue({ device: 'br-lan', up: true });
    await expect(getLan()).resolves.toMatchObject({ addresses: [] });
  });

  it('getEthPorts riempie i campi MAC che un pacchetto vecchio non manda', async () => {
    rpc.mockResolvedValue({ ports: [without({ port: 'lan1', mac: 'x' }, ['mac'])] });
    const info = await getEthPorts();

    expect(info.ports[0].mac).toBe('');
    expect(info.ports[0].mac_config).toBe('');
    expect(info.ports[0].device_section).toBe('');
  });
});
