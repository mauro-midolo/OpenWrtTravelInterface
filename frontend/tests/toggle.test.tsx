// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { PhysicalToggleRow } from '../src/components/PhysicalToggleRow';
import {
  controlsLed, controlsWg, isWgAction, normalizeToggle, positionLabel,
} from '../src/lib/toggle';
import { call } from '../src/lib/ubus';

vi.mock('../src/lib/ubus', () => ({ call: vi.fn() }));
const rpc = vi.mocked(call);
let container: HTMLDivElement;
const select = () => container.querySelector<HTMLSelectElement>('select');
const labels = () => [...(select()?.options ?? [])].map((option) => option.textContent);
const badge = () => container.querySelector('.row__label .badge');
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
/** Come risponde il router: `names` c'è solo per le voci che nomina lui. */
const reply = (over: Record<string, unknown> = {}) => ({
  action: 'none',
  position: 'off',
  actions: ['none', 'led'],
  names: {},
  ...over,
});
beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue(reply());
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
    // Il tempo largo è per le azioni lente: associare una configurazione
    // WireGuard alla levetta alza un tunnel, e un tunnel non sale in dieci
    // secondi.
    expect(rpc).toHaveBeenCalledWith('travel', 'toggle_get', {}, 60_000);
    expect(container.querySelector('.row__label')?.textContent)
      .toContain('Interruttore fisico');
    expect(labels()).toEqual(['Non fare nulla', 'Controllo LED di stato']);
    expect(select()!.value).toBe('none');
  });

  // La levetta si muove sul fianco del router: la riga dice a che funzione e'
  // associata, e deve dire anche se in questo momento la sta tenendo attiva.
  it('shows where the switch is sitting right now', async () => {
    rpc.mockResolvedValue(reply({ action: 'led', position: 'on' }));
    await mount();
    expect(badge()?.textContent).toBe('ON');
    expect(badge()?.className).toContain('badge--ok');
  });

  it('says OFF without dressing it up as a problem', async () => {
    await mount();
    expect(badge()?.textContent).toBe('OFF');
    expect(badge()?.className).toContain('badge--muted');
  });

  // Dopo l'accensione il router non sa dove sia finche' non la vede muoversi, e
  // un OFF inventato sarebbe indistinguibile da uno vero.
  it('does not invent a position the router has not detected yet', async () => {
    rpc.mockResolvedValue(reply({ position: 'unknown' }));
    await mount();
    expect(badge()?.textContent).toBe('posizione ignota');
    expect(badge()?.className).toContain('badge--muted');
  });

  it('has nothing to show about the position until the router answers', async () => {
    rpc.mockRejectedValueOnce(new Error('Timeout'));
    await mount();
    expect(badge()).toBeNull();
  });

  // La posizione cambia senza passare da qui: senza riletture la riga direbbe
  // per sempre quella del momento in cui si e' aperta la schermata.
  it('follows the switch while the screen stays open', async () => {
    vi.useFakeTimers();
    try {
      await mount();
      expect(badge()?.textContent).toBe('OFF');
      rpc.mockResolvedValue(reply({ position: 'on' }));
      await act(async () => {
        vi.advanceTimersByTime(5000);
        await Promise.resolve();
      });
      expect(badge()?.textContent).toBe('ON');
    } finally {
      vi.useRealTimers();
    }
  });

  // Una rilettura di fondo non e' un comando: non deve disabilitare il menu ne'
  // far credere a chi mostra il LED che il router abbia riallineato qualcosa.
  it('keeps background rereads out of the way of the user', async () => {
    vi.useFakeTimers();
    const seen = vi.fn();
    try {
      await act(() => render(<PhysicalToggleRow onConfig={seen} />, container));
      await act(async () => { await Promise.resolve(); });
      seen.mockClear();
      await act(async () => {
        vi.advanceTimersByTime(5000);
        await Promise.resolve();
      });
      expect(select()!.disabled).toBe(false);
      expect(seen).toHaveBeenLastCalledWith(expect.anything(), false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves the chosen action and shows it again on reopening', async () => {
    await mount();
    rpc.mockResolvedValue(reply({ action: 'led' }));
    await choose('led');
    expect(rpc).toHaveBeenLastCalledWith('travel', 'toggle_set', { action: 'led' }, 60_000);
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

  it('reports the function it read, so the screen knows who owns the LED', async () => {
    const seen = vi.fn();
    rpc.mockResolvedValue(reply({ action: 'led', position: 'on' }));
    await act(() => render(<PhysicalToggleRow onConfig={seen} />, container));
    await act(async () => { await Promise.resolve(); });
    // La sola lettura iniziale dice chi comanda, ma non ha mosso niente.
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenLastCalledWith(reply({ action: 'led', position: 'on' }), false);
  });

  it('tells the screen to reread what the router has just lined up', async () => {
    const seen = vi.fn();
    await act(() => render(<PhysicalToggleRow onConfig={seen} />, container));
    await act(async () => { await Promise.resolve(); });
    rpc.mockResolvedValue(reply({ action: 'led', position: 'on' }));
    await choose('led');
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenLastCalledWith(reply({ action: 'led', position: 'on' }), true);
  });

  it('does not claim anything was lined up when the write failed', async () => {
    const seen = vi.fn();
    await act(() => render(<PhysicalToggleRow onConfig={seen} />, container));
    await act(async () => { await Promise.resolve(); });
    rpc.mockRejectedValueOnce(new Error('Impossibile applicare la funzione scelta.'));
    await choose('led');
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenLastCalledWith(expect.anything(), false);
  });

  it('hides actions the installed package does not know about', async () => {
    rpc.mockResolvedValue(reply({ position: 'on', actions: ['none'] }));
    await mount();
    expect(labels()).toEqual(['Non fare nulla']);
  });

  // Le configurazioni WireGuard non sono una voce generica: ne può portare il
  // traffico una alla volta, quindi "attiva WireGuard" non vorrebbe dire
  // niente. Si sceglie quale, e con il nome che le ha dato chi la usa.
  it('lists each saved WireGuard configuration by the name its owner gave it', async () => {
    rpc.mockResolvedValue(reply({
      actions: ['none', 'led', 'wg:travel_wg1', 'wg:travel_wg2'],
      names: { 'wg:travel_wg1': 'Casa', 'wg:travel_wg2': 'Ufficio' },
    }));
    await mount();
    expect(labels()).toEqual([
      'Non fare nulla',
      'Controllo LED di stato',
      'WireGuard – Casa',
      'WireGuard – Ufficio',
    ]);
  });

  it('associates the switch with one configuration, by its section id', async () => {
    rpc.mockResolvedValue(reply({
      actions: ['none', 'led', 'wg:travel_wg1'],
      names: { 'wg:travel_wg1': 'Casa' },
    }));
    await mount();
    await choose('wg:travel_wg1');
    expect(rpc).toHaveBeenLastCalledWith(
      'travel', 'toggle_set', { action: 'wg:travel_wg1' }, 60_000,
    );
  });

  // Un pacchetto più vecchio di questa interfaccia manda l'elenco senza i nomi:
  // meglio la sezione che una riga vuota da scegliere alla cieca.
  it('falls back to the section when the router sends no name', async () => {
    rpc.mockResolvedValue(reply({ actions: ['none', 'wg:travel_wg3'], names: undefined }));
    await mount();
    expect(labels()).toEqual(['Non fare nulla', 'WireGuard – travel_wg3']);
  });

  it('disables the list while a write is pending', async () => {
    let finish!: (value: unknown) => void;
    rpc.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    expect(select()).toBeNull();
    expect(container.textContent).toContain('Caricamento');
    await act(async () => {
      finish(reply());
      await Promise.resolve();
    });
    rpc.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await choose('led');
    expect(select()!.disabled).toBe(true);
    await act(async () => {
      finish(reply({ action: 'led' }));
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

  // La riga si rimette in sesto da sola: la rilettura seguente riesce e il
  // menu compare. L'avviso di prima pero' e' rimasto acceso sopra una riga che
  // funziona, e diceva il falso finche' non la si toccava.
  it('takes back the "non disponibile" when the router answers again', async () => {
    vi.useFakeTimers();
    try {
      rpc.mockRejectedValueOnce(new Error('Timeout'));
      await mount();
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(5000);
        await Promise.resolve();
      });
      expect(select()).not.toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(retry()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // Un salvataggio fallito invece resta detto: il menu e' gia' tornato indietro
  // da solo, e senza l'avviso quel salto non avrebbe piu' una spiegazione.
  it('keeps saying a write failed, however well the rereads go', async () => {
    vi.useFakeTimers();
    try {
      await mount();
      rpc.mockRejectedValueOnce(new Error('Impossibile salvare la scelta.'));
      await choose('led');
      await act(async () => {
        vi.advanceTimersByTime(5000);
        await Promise.resolve();
      });
      expect(container.querySelector('[role="alert"]')?.textContent)
        .toContain('Impossibile salvare la scelta.');
      expect(select()!.value).toBe('none');
    } finally {
      vi.useRealTimers();
    }
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
    const bare = { action: 'none', actions: ['none', 'led'], position: 'unknown', names: {} };
    expect(normalizeToggle({})).toEqual(bare);
    expect(normalizeToggle(undefined)).toEqual(bare);
  });

  it('drops actions this interface has no label for', () => {
    const raw = { action: 'led', actions: ['none', 'led', 'apri-il-garage'], position: 'on' };
    expect(normalizeToggle(raw as never).actions).toEqual(['none', 'led']);
  });

  // Le voci `wg:` invece passano tutte: non sono un'azione che questa
  // interfaccia deve conoscere, sono un profilo che il router ha e noi no.
  it('keeps every WireGuard configuration the router offers', () => {
    const raw = { action: 'wg:travel_wg2', actions: ['none', 'wg:travel_wg2'], position: 'on' };
    expect(normalizeToggle(raw as never).actions).toEqual(['none', 'wg:travel_wg2']);
    expect(normalizeToggle(raw as never).action).toBe('wg:travel_wg2');
  });

  it('keeps only the names that are really names', () => {
    const raw = { names: { 'wg:travel_wg1': 'Casa', 'wg:travel_wg2': '', 'wg:travel_wg3': 7 } };
    expect(normalizeToggle(raw as never).names).toEqual({ 'wg:travel_wg1': 'Casa' });
  });

  it('keeps the saved action selectable even when the router omits it', () => {
    const raw = { action: 'led', actions: ['none'], position: 'off' };
    expect(normalizeToggle(raw as never)).toEqual({
      action: 'led', actions: ['led', 'none'], position: 'off', names: {},
    });
  });

  it('names the two positions the same way on every router', () => {
    // Non "alto" e "basso": il verso della levetta cambia da un modello
    // all'altro, ON e OFF no.
    expect(positionLabel('on')).toBe('ON');
    expect(positionLabel('off')).toBe('OFF');
    expect(positionLabel('unknown')).toBe('posizione ignota');
  });

  it('falls back to doing nothing when the saved action is unknown', () => {
    expect(normalizeToggle({ action: 'apri-il-garage' } as never).action).toBe('none');
    expect(normalizeToggle({ position: 'meta strada' } as never).position).toBe('unknown');
  });

  // Senza elenco si mostrano le fisse: un tunnel WireGuard non si puo'
  // indovinare, e proporne uno che non esiste sarebbe peggio che tacere.
  it('never invents WireGuard entries when the router sends no list', () => {
    expect(normalizeToggle({ action: 'led' } as never).actions).toEqual(['none', 'led']);
  });
});

describe('chi comanda cosa', () => {
  it('tells which WireGuard configuration follows the switch, if any', () => {
    expect(controlsWg('wg:travel_wg1')).toBe('travel_wg1');
    expect(controlsWg('led')).toBe('');
    expect(controlsWg('none')).toBe('');
    expect(controlsWg(null)).toBe('');
    // Le due funzioni si escludono: una levetta ha una posizione sola.
    expect(controlsLed('wg:travel_wg1')).toBe(false);
    expect(isWgAction('wg:travel_wg1')).toBe(true);
    expect(isWgAction('led')).toBe(false);
  });
});
