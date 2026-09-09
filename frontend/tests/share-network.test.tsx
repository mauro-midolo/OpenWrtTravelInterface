// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { ShareSheet } from '../src/screens/ShareNetwork';
import { SavedSheet } from '../src/screens/SavedNetworks';
import { readShareNetwork } from '../src/lib/networks';
import type { SavedNetwork } from '../src/lib/networks';
import { call } from '../src/lib/ubus';
import { UbusError } from '../src/lib/ubus-error';
import { qrMatrix, qrPath } from '../src/lib/qr';
import { wifiUri } from '../src/lib/share';

vi.mock('../src/lib/ubus', async (original) => ({
  ...await original<typeof import('../src/lib/ubus')>(), call: vi.fn(),
}));

const saved = { section: 'net_offline', ssid: 'Vecchio nome', encryption: 'psk2',
  hidden: false, bands: { '2.4': false, '5': true },
  mac: { '2.4': { mode: 'device', value: '' }, '5': { mode: 'device', value: '' } },
  disabled: true } as SavedNetwork;
const values = { '.type': 'network', ssid: 'Nome aggiornato', encryption: 'sae',
  key: ' password aggiornata ', hidden: '1', band: '2.4' };
let container: HTMLDivElement;
const rpc = vi.mocked(call);
const button = (label: string) => [...container.querySelectorAll('button')]
  .find((element) => element.textContent === label)!;
async function mount(net = saved) {
  await act(() => render(<ShareSheet net={net} onClose={() => render(null, container)} />, container));
  await act(async () => { await Promise.resolve(); });
}
async function click(label: string) {
  await act(() => button(label).click());
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ values });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  act(() => render(null, container));
  container.remove();
});

describe('saved network sharing', () => {
  it('reads only the selected section and uses all current values, even while offline', async () => {
    await mount();
    expect(rpc).toHaveBeenCalledExactlyOnceWith('uci', 'get', { config: 'travel', section: saved.section });
    expect(container.querySelector('h2')?.textContent).toBe('Condividi Nome aggiornato');
    const expected = wifiUri({ ...values, hidden: true });
    expect(container.querySelector('path')?.getAttribute('d')).toBe(qrPath(qrMatrix(expected)));
    expect(container.textContent).not.toContain(values.key);
    await click('Mostra password');
    expect(container.querySelector('.secret')?.textContent).toBe(values.key);
    await click('Nascondi password');
    expect(container.textContent).not.toContain(values.key);
    await click('Chiudi');
    expect(container.childElementCount).toBe(0);
  });

  it('offers Condividi without any available radio or active connection', async () => {
    rpc.mockResolvedValue({});
    await act(() => render(<SavedSheet net={saved} saved={[saved]} radios={[]} onClose={() => {}} />, container));
    expect(button('Condividi').disabled).toBe(false);
    rpc.mockResolvedValue({ values });
    await click('Condividi');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('rereads changed SSID, security and password on reopening and masks the new password', async () => {
    await mount();
    await click('Mostra password');
    await click('Chiudi');
    rpc.mockResolvedValue({ values: { ...values, ssid: 'Nuovo SSID', encryption: 'psk2', key: 'nuovapassword' } });
    await mount();
    expect(container.querySelector('h2')?.textContent).toContain('Nuovo SSID');
    expect(container.textContent).not.toContain('nuovapassword');
    await click('Mostra password');
    expect(container.querySelector('.secret')?.textContent).toBe('nuovapassword');
  });

  it('handles open networks without a key and without a reveal button', async () => {
    rpc.mockResolvedValue({ values: { ...values, encryption: 'none', key: undefined } });
    await mount();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.textContent).toContain('Rete aperta');
    expect(button('Mostra password')).toBeUndefined();
  });

  it.each([new UbusError(6, 'uci.get'), new UbusError(5, 'uci.get'), new Error('Timeout')])
  ('never shows a QR on a read error: %s', async (error) => {
    rpc.mockRejectedValue(error);
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(error.message);
    expect(container.querySelector('svg')).toBeNull();
    expect(button('Mostra password')).toBeUndefined();
    rpc.mockResolvedValue({ values });
    await click('Riprova');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('does not present a protected network without a key as shareable', async () => {
    rpc.mockResolvedValue({ values: { ...values, key: undefined } });
    await mount();
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('password salvata');
  });

  it('rejects a malformed section response', async () => {
    rpc.mockResolvedValue({ values: { key: 'othersecret' } });
    await expect(readShareNetwork(saved.section)).rejects.toThrow('Impossibile leggere');
  });

  it('ignores a late response from another selected network', async () => {
    let finish!: (data: unknown) => void;
    rpc.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    expect(container.querySelector('svg')).toBeNull();
    await mount({ ...saved, section: 'net_other' });
    await act(() => finish({ values: { ...values, ssid: 'Risposta tardiva' } }));
    expect(container.querySelector('h2')?.textContent).toBe('Condividi Nome aggiornato');
  });
});
