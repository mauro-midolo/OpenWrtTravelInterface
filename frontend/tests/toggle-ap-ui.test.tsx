// @vitest-environment jsdom
/**
 * Il controllo virtuale dell'access point quando lo comanda la levetta.
 *
 * La regola e' una sola e vale in tutte e due i versi: finche' l'interruttore
 * fisico comanda l'access point di una banda, da qui quello si guarda e basta;
 * appena non lo comanda piu', torna premibile da solo. Senza il primo verso
 * schermo, access point e levetta finirebbero a dire tre cose diverse; senza il
 * secondo resterebbe un pulsante spento per sempre.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Wifi } from '../src/screens/Wifi';
import { ApCard } from '../src/screens/AccessPoint';
import { getAp, listRadios } from '../src/lib/wifi';
import type { ApSection } from '../src/lib/wifi';
import { controlsAp } from '../src/lib/toggle';
import { call } from '../src/lib/ubus';

vi.mock('../src/lib/ubus', async (original) => ({
  ...(await original<typeof import('../src/lib/ubus')>()),
  call: vi.fn(),
}));

const rpc = vi.mocked(call);

/** Una riga di `travel.radios`, come la manda il router. */
const radioRow = (over: Record<string, unknown> = {}) => ({
  name: 'radio0',
  band: '2.4',
  device: 'phy0.0-ap0',
  up: true,
  setup_failed: false,
  channel: 1,
  ap_section: 'ap_radio0',
  ap_ssid: 'ciao',
  ap_enabled: true,
  ap_toggle: false,
  sta_section: '',
  sta_enabled: false,
  ...over,
});

const apRow = (over: Partial<ApSection> = {}): Partial<ApSection> => ({
  section: 'ap_radio0',
  radio: 'radio0',
  band: '2.4',
  enabled: true,
  ssid: 'ciao',
  encryption: 'sae-mixed',
  has_key: true,
  toggle: false,
  ...over,
});

/** Il router risponde solo alle letture che la scheda WiFi fa all'apertura. */
function backend(radios: Record<string, unknown>[]) {
  rpc.mockImplementation(async (object: string, method: string) => {
    const key = `${object}.${method}`;
    if (key === 'travel.radios') return { radios } as never;
    if (key === 'travel.ap') return { aps: radios.map((r) => apRow({
      section: String(r.ap_section),
      radio: String(r.name),
      band: String(r.band),
      enabled: r.ap_enabled === true,
      toggle: r.ap_toggle === true,
    })) } as never;
    if (key === 'travel.uplinks') return { uplinks: [] } as never;
    if (key === 'travel.networks') return { networks: [] } as never;
    throw new Error(`mock: ${key} non serve a questa schermata`);
  });
}

let host: HTMLDivElement;

/** Il pulsante di accensione dell'access point, per banda. */
function apButton(band: string): HTMLButtonElement | undefined {
  const cards = [...host.querySelectorAll('section.card')];
  const card = cards.find((c) => c.querySelector('.radio__title')?.textContent === `${band} GHz`);
  return [...(card?.querySelectorAll('button') ?? [])].find((b) =>
    /access point$/.test(b.textContent ?? ''),
  ) as HTMLButtonElement | undefined;
}

async function open(radios: Record<string, unknown>[]) {
  backend(radios);
  await act(async () => {
    render(<Wifi onLogout={() => {}} />, host);
    await Promise.resolve();
  });
  // Le letture dell'apertura sono parallele: si aspetta che siano tutte
  // atterrate prima di guardare cosa mostra la scheda.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  // La scheda riporta in cima passando fra le sue due viste; jsdom non ha lo
  // scorrimento, e senza questo ogni prova stampa un errore che non c'entra.
  vi.stubGlobal('scrollTo', () => {});
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  render(null, host);
  host.remove();
  rpc.mockReset();
  vi.unstubAllGlobals();
});

describe('il controllo virtuale dell’access point', () => {
  it('stays usable while the switch commands nothing', async () => {
    await open([radioRow(), radioRow({ name: 'radio1', band: '5', ap_section: 'ap_radio1' })]);

    expect(apButton('2.4')?.disabled).toBe(false);
    expect(apButton('5')?.disabled).toBe(false);
  });

  // Lo stato resta visibile: e' proprio quello che serve leggere per sapere
  // dov'e' la levetta. Sparire lascerebbe la scheda senza quella riga.
  it('is disabled but still shows the state when the switch commands that band', async () => {
    await open([
      radioRow({ ap_toggle: true }),
      radioRow({ name: 'radio1', band: '5', ap_section: 'ap_radio1' }),
    ]);

    const locked = apButton('2.4');
    expect(locked?.disabled).toBe(true);
    expect(locked?.textContent).toBe('Spegni access point');
    // L'altra banda e' un'opzione indipendente: non la tocca nessuno.
    expect(apButton('5')?.disabled).toBe(false);
  });

  it('says who is in command, next to the control that will not press', async () => {
    await open([radioRow({ ap_toggle: true })]);

    expect(host.textContent).toContain('segue l’interruttore fisico');
  });

  it('follows the switch down: off, and still not pressable', async () => {
    await open([radioRow({ ap_toggle: true, ap_enabled: false, up: false })]);

    const locked = apButton('2.4');
    expect(locked?.disabled).toBe(true);
    expect(locked?.textContent).toBe('Accendi access point');
  });

  // L'altra meta' della regola, e quella che si dimentica: tolta
  // l'associazione, il controllo torna utilizzabile da solo.
  it('becomes usable again as soon as the switch stops commanding it', async () => {
    await open([radioRow({ ap_toggle: true })]);
    expect(apButton('2.4')?.disabled).toBe(true);

    backend([radioRow({ ap_toggle: false })]);
    await act(async () => {
      (
        [...host.querySelectorAll('button')].find((b) => b.textContent === 'Aggiorna') as
          HTMLButtonElement
      ).click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(apButton('2.4')?.disabled).toBe(false);
  });
});

describe('la forma canonica di chi comanda', () => {
  // Un pacchetto piu' vecchio di questa interfaccia non manda il campo: la
  // levetta non sa ancora comandare un access point, quindi non ne comanda
  // nessuno. Un `undefined` che arriva fino alla scheda spegnerebbe il
  // pulsante di chi non ha nemmeno l'opzione.
  it('reads a missing field as "nobody commands it"', async () => {
    rpc.mockResolvedValueOnce({ radios: [{ name: 'radio0', band: '2.4', ap_section: 'ap_radio0' }] } as never);
    expect((await listRadios())[0].apToggle).toBe(false);

    rpc.mockResolvedValueOnce({ aps: [{ section: 'ap_radio0', band: '2.4' }] } as never);
    expect((await getAp())[0].toggle).toBe(false);
  });

  it('names the band an action commands, and nothing for the others', () => {
    expect(controlsAp('ap24')).toBe('2.4');
    expect(controlsAp('ap5')).toBe('5');
    expect(controlsAp('led')).toBe('');
    expect(controlsAp('none')).toBe('');
    expect(controlsAp('wg:travel_wg1')).toBe('');
    expect(controlsAp(null)).toBe('');
  });
});

describe('la scheda dell’access point', () => {
  it('does not send you to a radio card whose control cannot be pressed', () => {
    const aps = [
      apRow({ enabled: false, toggle: true }) as ApSection,
      apRow({ section: 'ap_radio1', radio: 'radio1', band: '5', enabled: false }) as ApSection,
    ];
    act(() => {
      render(<ApCard aps={aps} onEdit={() => {}} />, host);
    });

    expect(host.textContent).toContain('2.4 GHz: lo comanda l’interruttore fisico');
    // L'altra banda si riaccende ancora da li', quindi il consiglio resta.
    expect(host.textContent).toContain('Riaccendilo dalla scheda della radio.');
  });
});
