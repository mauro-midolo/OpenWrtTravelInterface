// @vitest-environment jsdom
//
// Le funzioni sono pure, ma lan.ts importa lib/ubus.ts, che legge
// sessionStorage appena il modulo viene caricato.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../src/lib/ubus';
import {
  clientAddress,
  clientDetail,
  clientTitle,
  listClients,
  withClientDefaults,
} from '../src/lib/lan';
import type { LanClient } from '../src/lib/lan';

vi.mock('../src/lib/ubus', async (original) => ({
  ...(await original<typeof import('../src/lib/ubus')>()),
  call: vi.fn(),
}));

const rpc = vi.mocked(call);

function client(fields: Partial<LanClient> = {}): LanClient {
  return withClientDefaults({
    mac: '00:11:22:33:44:55',
    ip: '',
    name: '',
    source: 'dhcp',
    via: 'wifi',
    iface: 'phy0.1-ap0',
    band: '5',
    ...fields,
  });
}

beforeEach(() => {
  rpc.mockReset();
});

describe('ordinamento dell’elenco', () => {
  it('ordina gli IPv4 per valore, non come testo', async () => {
    // `localeCompare` con `numeric` ci azzeccava perche' li' i numeri sono
    // separati da punti. Qui si passa da sortKey, che confronta i byte.
    rpc.mockResolvedValue({
      clients: [
        { ...client({ ip: '192.168.10.100' }) },
        { ...client({ ip: '192.168.10.9' }) },
        { ...client({ ip: '192.168.10.10' }) },
      ],
    });

    const ips = (await listClients()).map((c) => c.ip);
    expect(ips).toEqual(['192.168.10.9', '192.168.10.10', '192.168.10.100']);
  });

  it('ordina gli IPv6 per valore, dove localeCompare sbagliava', async () => {
    // "fd00::9" e "fd00::10" non hanno numeri separati da punti: `numeric` non
    // ha niente su cui lavorare e li mette in ordine alfabetico, cioe' al
    // contrario.
    rpc.mockResolvedValue({
      clients: [
        { ...client({ ips6: ['fd00::10'] }) },
        { ...client({ ips6: ['fd00::9'] }) },
        { ...client({ ips6: ['fd00::2'] }) },
      ],
    });

    const first = (await listClients()).map((c) => c.ips6[0]);
    expect(first).toEqual(['fd00::2', 'fd00::9', 'fd00::10']);
  });

  it('mette i v4, poi i v6-only, poi chi non ha indirizzo', async () => {
    rpc.mockResolvedValue({
      clients: [
        { ...client({ mac: 'aa:aa:aa:aa:aa:aa' }) },
        { ...client({ mac: 'cc:cc:cc:cc:cc:cc', ips6: ['fd00::1'] }) },
        { ...client({ mac: 'bb:bb:bb:bb:bb:bb', ip: '192.168.10.5' }) },
      ],
    });

    const macs = (await listClients()).map((c) => c.mac);
    expect(macs).toEqual([
      'bb:bb:bb:bb:bb:bb',
      'cc:cc:cc:cc:cc:cc',
      'aa:aa:aa:aa:aa:aa',
    ]);
  });

  it('una riga per MAC, anche con quattro indirizzi', async () => {
    // Un dispositivo e' un dispositivo. Triplicare la riga perche' ha tre
    // indirizzi rende piu' difficile l'unica domanda a cui l'elenco serve.
    rpc.mockResolvedValue({
      clients: [
        {
          ...client({
            ip: '192.168.10.5',
            ips6: ['fd00::3', 'fd00::1', 'fd00::2'],
          }),
        },
      ],
    });

    const list = await listClients();
    expect(list).toHaveLength(1);
    expect(list[0].ips6).toHaveLength(3);
  });
});

describe('withClientDefaults', () => {
  it('riempie ips6 quando il pacchetto e’ vecchio e non lo manda', () => {
    // Router a meta' aggiornamento: leggere `ips6[0]` non deve esplodere.
    const raw = { mac: 'a', ip: '', name: '', source: 'dhcp', via: '', iface: '', band: '' };
    const filled = withClientDefaults(raw);

    expect(filled.ips6).toEqual([]);
    expect(() => filled.ips6[0]).not.toThrow();
  });

  it('da’ un ordine agli indirizzi, perche’ ip neigh non ne ha uno stabile', () => {
    // `ip neigh` li elenca nell'ordine in cui il kernel se li ritrova, che
    // cambia fra una lettura e l'altra: senza ordinarli, il "primo indirizzo"
    // mostrato per un dispositivo v6-only ballerebbe a ogni aggiornamento.
    const filled = withClientDefaults({
      mac: 'a',
      ip: '',
      name: '',
      source: 'neigh6',
      via: '',
      iface: '',
      band: '',
      ips6: ['fd00::10', 'fd00::2', 'fd00::9'],
    });

    expect(filled.ips6).toEqual(['fd00::2', 'fd00::9', 'fd00::10']);
  });
});

describe('come si legge una riga', () => {
  it('il titolo preferisce il nome, poi l’indirizzo, poi il MAC', () => {
    expect(clientTitle(client({ name: 'pixel', ip: '192.168.10.5' }))).toBe('pixel');
    expect(clientTitle(client({ ip: '192.168.10.5' }))).toBe('192.168.10.5');
    expect(clientTitle(client({ ips6: ['fd00::1'] }))).toBe('fd00::1');
    expect(clientTitle(client())).toBe('00:11:22:33:44:55');
  });

  it('un dispositivo v6-only mostra il suo indirizzo, non “senza indirizzo”', () => {
    // In rete c'e' e risponde: scrivere che non ha indirizzo manderebbe a
    // cercare un guasto che non esiste.
    const only6 = client({ name: 'stampante', ips6: ['fd00::1'] });

    expect(clientAddress(only6)).toBe('fd00::1');
    expect(clientDetail(only6)).toBe('fd00::1 · 00:11:22:33:44:55');
  });

  it('gli altri indirizzi v6 si contano, non si elencano', () => {
    const phone = client({
      name: 'pixel',
      ip: '192.168.10.5',
      ips6: ['fd00::1', 'fd00::2', 'fd00::3'],
    });

    expect(clientDetail(phone)).toBe('192.168.10.5 · +3 IPv6 · 00:11:22:33:44:55');
  });

  it('l’indirizzo gia’ mostrato non si conta due volte', () => {
    // Senza v4 il primo v6 fa da indirizzo principale: gli "altri" sono due,
    // non tre.
    const only6 = client({ name: 'x', ips6: ['fd00::1', 'fd00::2', 'fd00::3'] });
    expect(clientDetail(only6)).toBe('fd00::1 · +2 IPv6 · 00:11:22:33:44:55');
  });

  it('senza nessun indirizzo lo dice, e non ripete il MAC del titolo', () => {
    // Il titolo e' gia' il MAC: riscriverlo qui farebbe sospettare due
    // dispositivi diversi.
    expect(clientDetail(client())).toBe('senza indirizzo');
    expect(clientDetail(client({ name: 'x' }))).toBe('senza indirizzo · 00:11:22:33:44:55');
  });

  it('senza nome il titolo si prende l’indirizzo, e il dettaglio non lo ripete', () => {
    expect(clientDetail(client({ ip: '192.168.10.5' }))).toBe('00:11:22:33:44:55');
    expect(clientDetail(client({ ip: '192.168.10.5', ips6: ['fd00::1'] }))).toBe(
      '+1 IPv6 · 00:11:22:33:44:55',
    );
  });
});
