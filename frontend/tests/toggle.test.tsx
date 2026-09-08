// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { PhysicalToggleRow } from '../src/components/PhysicalToggleRow';
import { normalizeToggle } from '../src/lib/toggle';
import { call } from '../src/lib/ubus';

vi.mock('../src/lib/ubus', () => ({ call: vi.fn() }));
const rpc = vi.mocked(call);
let container: HTMLDivElement;
const select = () => container.querySelector<HTMLSelectElement>('select');
const labels = () => [...(select()?.options ?? [])].map((option) => option.textContent);
const retry = () => [...container.querySelectorAll('button')]
  .find((element) => element.textContent === 'Riprova')!;
async function mount() {
  await act(() => render(<PhysicalToggleRow />, container));
  await act(async () => { await Promise.resolve(); });
}
async function choose(action: string) {
  const menu = select()!;
  menu.value = action;
  await act(() => menu.dispatchEvent(new Event('change', { bubbles: true })));
  await act(async () => { await Promise.resolve(); });
}
beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ action: 'none', position: 'off', actions: ['none', 'led'] });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  act(() => render(null, container));
  container.remove();
});

describe('interruttore fisico', () => {
  it('sits under the LED row and offers the actions the router knows', async () => {
    await mount();
    expect(rpc).toHaveBeenCalledWith('travel', 'toggle_get', {});
    expect(container.querySelector('.row__label')?.textContent).toBe('Interruttore fisico');
    expect(labels()).toEqual(['Non fare nulla', 'Controllo LED di stato']);
    expect(select()!.value).toBe('none');
  });

  it('saves the chosen action and shows it again on reopening', async () => {
    await mount();
    rpc.mockResolvedValue({ action: 'led', position: 'off', actions: ['none', 'led'] });
    await choose('led');
    expect(rpc).toHaveBeenLastCalledWith('travel', 'toggle_set', { action: 'led' });
    expect(select()!.value).toBe('led');
    await act(() => render(null, container));
    await mount();
    expect(select()!.value).toBe('led');
  });

  it('never writes the LED itself: choosing an action only saves the configuration', async () => {
    await mount();
    await choose('led');
    expect(rpc.mock.calls.map(([, method]) => method)).toEqual(['toggle_get', 'toggle_set']);
  });

  it('tells the screen to reread what the router has just lined up', async () => {
    const applied = vi.fn();
    await act(() => render(<PhysicalToggleRow onApplied={applied} />, container));
    await act(async () => { await Promise.resolve(); });
    // La sola lettura iniziale non ha mosso niente.
    expect(applied).not.toHaveBeenCalled();
    await choose('led');
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it('does not claim anything was lined up when the write failed', async () => {
    const applied = vi.fn();
    await act(() => render(<PhysicalToggleRow onApplied={applied} />, container));
    await act(async () => { await Promise.resolve(); });
    rpc.mockRejectedValueOnce(new Error('Impossibile applicare la funzione scelta.'));
    await choose('led');
    expect(applied).not.toHaveBeenCalled();
  });

  it('hides actions the installed package does not know about', async () => {
    rpc.mockResolvedValue({ action: 'none', position: 'on', actions: ['none'] });
    await mount();
    expect(labels()).toEqual(['Non fare nulla']);
  });

  it('disables the list while a write is pending', async () => {
    let finish!: (value: unknown) => void;
    rpc.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    expect(select()).toBeNull();
    expect(container.textContent).toContain('Caricamento');
    await act(async () => {
      finish({ action: 'none', position: 'off', actions: ['none', 'led'] });
      await Promise.resolve();
    });
    rpc.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await choose('led');
    expect(select()!.disabled).toBe(true);
    await act(async () => {
      finish({ action: 'led', position: 'off', actions: ['none', 'led'] });
      await Promise.resolve();
    });
    expect(select()!.disabled).toBe(false);
  });

  it.each([new Error('Timeout'), { error: 'Impossibile salvare la scelta.' }])
  ('keeps the last confirmed choice when a write fails: %s', async (error) => {
    await mount();
    if (error instanceof Error) rpc.mockRejectedValueOnce(error);
    else rpc.mockResolvedValueOnce(error);
    await choose('led');
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain(error instanceof Error ? error.message : error.error);
    expect(select()!.value).toBe('none');
    expect(select()!.disabled).toBe(false);
  });

  it('can retry a failed read', async () => {
    rpc.mockRejectedValueOnce(new Error('Timeout'));
    await mount();
    expect(select()).toBeNull();
    expect(container.textContent).toContain('non disponibile');
    await act(() => retry().click());
    await act(async () => { await Promise.resolve(); });
    expect(select()!.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('forma canonica della configurazione', () => {
  it('fills in what an older package leaves out', () => {
    expect(normalizeToggle({})).toEqual({ action: 'none', actions: ['none', 'led'], position: 'unknown' });
    expect(normalizeToggle(undefined)).toEqual({ action: 'none', actions: ['none', 'led'], position: 'unknown' });
  });

  it('drops actions this interface has no label for', () => {
    const raw = { action: 'led', actions: ['none', 'led', 'apri-il-garage'], position: 'on' };
    expect(normalizeToggle(raw as never).actions).toEqual(['none', 'led']);
  });

  it('keeps the saved action selectable even when the router omits it', () => {
    const raw = { action: 'led', actions: ['none'], position: 'off' };
    expect(normalizeToggle(raw as never)).toEqual({
      action: 'led', actions: ['led', 'none'], position: 'off',
    });
  });

  it('falls back to doing nothing when the saved action is unknown', () => {
    expect(normalizeToggle({ action: 'apri-il-garage' } as never).action).toBe('none');
    expect(normalizeToggle({ position: 'meta strada' } as never).position).toBe('unknown');
  });
});
