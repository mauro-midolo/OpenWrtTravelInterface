// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { StatusLedRow } from '../src/components/StatusLedRow';
import { call } from '../src/lib/ubus';

vi.mock('../src/lib/ubus', () => ({ call: vi.fn() }));
const rpc = vi.mocked(call);
let container: HTMLDivElement;
const toggle = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]');
const retry = () => [...container.querySelectorAll('button')]
  .find((element) => element.textContent === 'Riprova')!;
async function mount() {
  await act(() => render(<StatusLedRow />, container));
  await act(async () => { await Promise.resolve(); });
}
async function flip(checked: boolean) {
  const input = toggle()!;
  input.checked = checked;
  await act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  await act(async () => { await Promise.resolve(); });
}
beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ supported: true, enabled: true });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  act(() => render(null, container));
  container.remove();
});

describe('LED di stato', () => {
  it('reads the router, applies OFF immediately and rereads the saved choice on reopening', async () => {
    await mount();
    expect(rpc).toHaveBeenCalledWith('travel', 'led_get', {});
    expect(toggle()!.checked).toBe(true);
    rpc.mockResolvedValue({ supported: true, enabled: false });
    await flip(false);
    expect(rpc).toHaveBeenLastCalledWith('travel', 'led_set', { enabled: false });
    expect(toggle()!.checked).toBe(false);
    await act(() => render(null, container));
    await mount();
    expect(toggle()!.checked).toBe(false);
    rpc.mockResolvedValue({ supported: true, enabled: true });
    await flip(true);
    expect(rpc).toHaveBeenLastCalledWith('travel', 'led_set', { enabled: true });
    expect(toggle()!.checked).toBe(true);
  });

  it('sits in the device list without explaining itself', async () => {
    await mount();
    expect(container.querySelector('.row__label')?.textContent).toBe('LED di stato');
    expect(container.querySelector('.card')).toBeNull();
    expect(container.textContent).not.toContain('riavvio');
  });

  it('disables the toggle until loading finishes and while a write is pending', async () => {
    let finish!: (value: unknown) => void;
    rpc.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    expect(toggle()).toBeNull();
    await act(async () => { finish({ supported: true, enabled: true }); await Promise.resolve(); });
    rpc.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await flip(false);
    expect(toggle()!.disabled).toBe(true);
    await act(async () => { finish({ supported: true, enabled: false }); await Promise.resolve(); });
    expect(toggle()!.disabled).toBe(false);
  });

  it.each([new Error('Timeout'), { error: 'Impossibile salvare' }])
  ('preserves the last confirmed choice and shows write failures: %s', async (error) => {
    await mount();
    if (error instanceof Error) rpc.mockRejectedValueOnce(error);
    else rpc.mockResolvedValueOnce(error);
    await flip(false);
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain(error instanceof Error ? error.message : error.error);
    expect(toggle()!.checked).toBe(true);
    expect(toggle()!.disabled).toBe(false);
  });

  it('can retry a failed read', async () => {
    rpc.mockRejectedValueOnce(new Error('Timeout'));
    await mount();
    expect(toggle()).toBeNull();
    await act(() => retry().click());
    await act(async () => { await Promise.resolve(); });
    expect(toggle()!.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('reports unsupported hardware without allowing writes', async () => {
    rpc.mockResolvedValue({ supported: false, enabled: false });
    await mount();
    expect(toggle()).toBeNull();
    expect(container.querySelector('.row__value')?.textContent).toBe('non disponibile');
  });
});
