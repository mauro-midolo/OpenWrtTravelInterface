// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { LedAndToggleRows } from '../src/components/LedAndToggleRows';
import { call } from '../src/lib/ubus';

vi.mock('../src/lib/ubus', () => ({ call: vi.fn() }));
const rpc = vi.mocked(call);
let container: HTMLDivElement;

// Un router ridotto all'osso: tiene LED e configurazione, e allinea il primo
// alla levetta quando gli si da' quella funzione, come fa `toggle_set` vero.
let led: { supported: boolean; enabled: boolean };
let toggle: { action: string; position: string; actions: string[] };

const ledToggle = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]');
const actionMenu = () => container.querySelector<HTMLSelectElement>('select');

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}
async function mount() {
  await act(() => render(<LedAndToggleRows />, container));
  await settle();
}
async function choose(action: string) {
  const menu = actionMenu()!;
  menu.value = action;
  await act(() => menu.dispatchEvent(new Event('change', { bubbles: true })));
  await settle();
}

beforeEach(() => {
  led = { supported: true, enabled: true };
  toggle = { action: 'none', position: 'on', actions: ['none', 'led'] };
  rpc.mockReset();
  rpc.mockImplementation(async (_object: string, method: string, args: Record<string, unknown>) => {
    switch (method) {
      case 'led_get': return { ...led };
      case 'led_set': led.enabled = args.enabled as boolean; return { ...led };
      case 'toggle_get': return { ...toggle };
      case 'toggle_set':
        toggle.action = args.action as string;
        if (toggle.action === 'led' && toggle.position !== 'unknown') {
          led.enabled = toggle.position === 'on';
        }
        return { ...toggle };
      default: throw new Error(`metodo non previsto: ${method}`);
    }
  });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  act(() => render(null, container));
  container.remove();
});

describe('LED e levetta insieme', () => {
  it('hands the LED over to the switch and takes it back', async () => {
    await mount();
    expect(ledToggle()!.disabled, 'nessuna funzione: si comanda da qui').toBe(false);

    await choose('led');
    expect(ledToggle()!.disabled, 'ora comanda la levetta').toBe(true);
    expect(ledToggle()).not.toBeNull();

    await choose('none');
    expect(ledToggle()!.disabled, 'restituito all utente').toBe(false);
    await act(() => ledToggle()!.click());
    await settle();
    expect(led.enabled, 'il comando torna a funzionare').toBe(false);
  });

  it('shows the LED the router lined up with the switch, without waiting a poll', async () => {
    // Levetta in basso e LED acceso: dandole il LED, il router lo spegne.
    toggle.position = 'off';
    await mount();
    expect(ledToggle()!.checked).toBe(true);

    await choose('led');
    expect(led.enabled, 'il router ha allineato').toBe(false);
    expect(ledToggle()!.checked, 'e la riga lo dice subito').toBe(false);
    expect(ledToggle()!.disabled).toBe(true);
  });

  it('leaves the LED usable when the switch configuration cannot be read', async () => {
    rpc.mockImplementation(async (_object: string, method: string) => {
      if (method === 'led_get') return { ...led };
      throw new Error('Timeout');
    });
    await mount();
    // Bloccare per un dubbio sarebbe peggio: qui non c'e' nessuna levetta che
    // comanda, c'e' solo un router che non ha risposto.
    expect(ledToggle()!.disabled).toBe(false);
  });

  it('reads each side once on arrival, and nothing else', async () => {
    await mount();
    expect(rpc.mock.calls.map(([, method]) => method).sort()).toEqual(['led_get', 'toggle_get']);
  });
});
