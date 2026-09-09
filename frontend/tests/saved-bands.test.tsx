// @vitest-environment jsdom
/**
 * Le reti salvate e le loro bande.
 *
 * Una rete e' una configurazione sola, valida su una banda o su tutte e due.
 * Qui si verificano le tre cose che quel modello deve garantire e che sono
 * facili da rompere senza accorgersene: che i tre stati sopravvivano al giro
 * uci -> interfaccia -> uci, che una banda su cui la rete non e' mai stata
 * salvata non venga accesa di nascosto, e che i MAC delle due bande restino
 * indipendenti.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import {
  bandConflicts,
  bandValues,
  bandsFromUci,
  bandsToUci,
  connectedVia,
  findSaved,
  findSavedOn,
  listSaved,
  macForNewBand,
  updateMacOnBand,
} from '../src/lib/networks';
import type { SavedNetwork } from '../src/lib/networks';
import { SavedNetworksScreen, SavedSheet } from '../src/screens/SavedNetworks';
import { ConnectSheet } from '../src/screens/Connect';
import { call } from '../src/lib/ubus';
import type { ConnectionPlan, Radio, ScanResult, Uplink } from '../src/lib/wifi';

vi.mock('../src/lib/ubus', async (original) => ({
  ...(await original<typeof import('../src/lib/ubus')>()),
  call: vi.fn(),
}));

const rpc = vi.mocked(call);

const device = { mode: 'device' as const, value: '' };
const net = (over: Partial<SavedNetwork> = {}): SavedNetwork => ({
  section: 'net_a',
  ssid: 'Casa Mia',
  encryption: 'psk2',
  bands: { '2.4': true, '5': true },
  hidden: false,
  mac: { '2.4': device, '5': device },
  hostname_mode: 'none',
  hostname_value: '',
  note: '',
  priority: 10,
  disabled: false,
  last_used: 0,
  last_result: '',
  has_key: true,
  ...over,
});

describe('band encoding', () => {
  it('survives the round trip through the three states uci has always had', () => {
    for (const value of ['', '2.4', '5']) {
      expect(bandsToUci(bandsFromUci(value))).toBe(value);
    }
    expect(bandsFromUci('')).toEqual({ '2.4': true, '5': true });
    expect(bandsFromUci(undefined)).toEqual({ '2.4': true, '5': true });
  });

  it('does not turn a band value it cannot read into "both bands"', () => {
    // travelD confronta `band` con quella della radio: un valore che non
    // corrisponde a nessuna delle due significa che oggi quella rete non viene
    // usata da nessuna parte. Leggerlo come "tutte e due" la farebbe comparire
    // come attiva su due radio su cui non e' mai andata.
    expect(bandsFromUci('6')).toEqual({ '2.4': false, '5': false });
  });
});

describe('reading a saved network', () => {
  it('falls back to the shared MAC while the router still has the old package', async () => {
    // L'interfaccia e il pacchetto si aggiornano separatamente: per qualche
    // minuto i campi per banda non arrivano affatto.
    rpc.mockResolvedValue({
      networks: [
        { section: 'net_a', ssid: 'Casa', band: '', mac_mode: 'random', mac_value: '02:AA:BB:CC:DD:EE' },
      ],
    });

    const [saved] = await listSaved();
    expect(saved.bands).toEqual({ '2.4': true, '5': true });
    expect(saved.mac['2.4']).toEqual({ mode: 'random', value: '02:aa:bb:cc:dd:ee' });
    expect(saved.mac['5']).toEqual({ mode: 'random', value: '02:aa:bb:cc:dd:ee' });
  });

  it('keeps the two MACs apart when the router does send them', async () => {
    rpc.mockResolvedValue({
      networks: [
        {
          section: 'net_a',
          ssid: 'Casa',
          band: '',
          mac_mode: 'random',
          mac_value: '02:00:00:00:00:24',
          mac_mode_24: 'random',
          mac_value_24: '02:00:00:00:00:24',
          mac_mode_5: 'clone',
          mac_value_5: '02:00:00:00:00:05',
        },
      ],
    });

    const [saved] = await listSaved();
    expect(saved.mac['2.4'].value).toBe('02:00:00:00:00:24');
    expect(saved.mac['5']).toEqual({ mode: 'clone', value: '02:00:00:00:00:05' });
  });
});

describe('writing the bands', () => {
  it('writes both the per-band fields and the shared one an old router reads', () => {
    const values = bandValues(
      { '2.4': false, '5': true },
      { '2.4': { mode: 'random', value: '02:00:00:00:00:24' }, '5': { mode: 'clone', value: '02:00:00:00:00:05' } },
    );

    expect(values.band).toBe('5');
    expect(values.mac_mode_5).toBe('clone');
    expect(values.mac_value_5).toBe('02:00:00:00:00:05');
    // Lo specchio segue la prima banda attiva, che e' quella che un pacchetto
    // non ancora aggiornato userebbe per prima.
    expect(values.mac_mode).toBe('clone');
    expect(values.mac_value).toBe('02:00:00:00:00:05');
  });

  it('changes the MAC of one band only, and pins the other so the mirror cannot move it', async () => {
    // Voce salvata prima che i MAC si separassero: ha solo quello condiviso, e
    // l'altra banda ci ripiega sopra.
    rpc.mockResolvedValue({
      values: { '.type': 'network', mac_mode: 'random', mac_value: '02:00:00:00:00:24' },
    });

    await updateMacOnBand('net_a', '5', { mode: 'clone', value: '02:00:00:00:00:05' });

    const written = rpc.mock.calls.find((c) => c[1] === 'set')?.[2] as {
      values: Record<string, string>;
    };

    expect(written.values.mac_mode_5).toBe('clone');
    expect(written.values.mac_value_5).toBe('02:00:00:00:00:05');
    // Lo specchio prende l'indirizzo appena scelto: e' l'unico che legge un
    // router non ancora aggiornato, e lasciandoglielo vecchio la prima
    // riconnessione automatica rimetterebbe il MAC di prima.
    expect(written.values.mac_mode).toBe('clone');
    expect(written.values.mac_value).toBe('02:00:00:00:00:05');
    // E proprio per questo la banda che nessuno ha toccato viene fissata sul
    // valore che stava usando: senza, seguirebbe lo specchio e si ritroverebbe
    // il MAC clonato addosso.
    expect(written.values.mac_mode_24).toBe('random');
    expect(written.values.mac_value_24).toBe('02:00:00:00:00:24');
    // Su quali radio vale la rete qui non lo ha chiesto nessuno.
    expect(written.values).not.toHaveProperty('band');
  });

  it('reads the section, not the list, to find out what the other band really uses', async () => {
    // Pacchetto piu' vecchio dell'interfaccia: `travel.networks` non manda i
    // campi per banda, ma in configurazione ci sono. Leggendo l'elenco si
    // riscriverebbe il valore condiviso sopra a quello vero.
    rpc.mockResolvedValue({
      values: {
        '.type': 'network',
        mac_mode: 'random',
        mac_value: '02:00:00:00:00:24',
        mac_mode_24: 'manual',
        mac_value_24: '02:99:99:99:99:24',
      },
    });

    await updateMacOnBand('net_a', '5', { mode: 'clone', value: '02:00:00:00:00:05' });

    const written = rpc.mock.calls.find((c) => c[1] === 'set')?.[2] as {
      values: Record<string, string>;
    };
    expect(written.values.mac_mode_24).toBe('manual');
    expect(written.values.mac_value_24).toBe('02:99:99:99:99:24');
  });

  it('pins the other band even when the section carries no MAC at all', async () => {
    // Nessun campo MAC: quella banda sta usando l'indirizzo della radio. Senza
    // fissarlo, lo specchio appena scritto la porterebbe sul MAC clonato.
    rpc.mockResolvedValue({ values: { '.type': 'network', ssid: 'Casa' } });

    await updateMacOnBand('net_a', '5', { mode: 'clone', value: '02:00:00:00:00:05' });

    const written = rpc.mock.calls.find((c) => c[1] === 'set')?.[2] as {
      values: Record<string, string>;
    };
    expect(written.values.mac_mode_24).toBe('device');
    expect(written.values.mac_value_24).toBe('');
  });

  it('leaves the shared mirror alone when it cannot read where the other band is', async () => {
    rpc.mockImplementation((object, method) => {
      if (object === 'uci' && method === 'get') return Promise.reject(new Error('niente'));
      return Promise.resolve({});
    });

    await updateMacOnBand('net_a', '5', { mode: 'clone', value: '02:00:00:00:00:05' });

    const written = rpc.mock.calls.find((c) => c[1] === 'set')?.[2] as {
      values: Record<string, string>;
    };
    // La banda toccata si scrive comunque. Lo specchio no: muoverlo alla cieca
    // sposterebbe anche l'altra banda, su una voce che ci ripiega sopra.
    expect(written.values.mac_value_5).toBe('02:00:00:00:00:05');
    expect(written.values).not.toHaveProperty('mac_mode');
    expect(written.values).not.toHaveProperty('mac_value');
    expect(written.values).not.toHaveProperty('mac_mode_24');
  });

  it('regenerates a random MAC for a band being switched on, but copies a cloned one', () => {
    const random = macForNewBand({ mode: 'random', value: '02:00:00:00:00:24' });
    expect(random.mode).toBe('random');
    // Due stazioni con lo stesso MAC casuale sullo stesso punto di accesso
    // sarebbero un conflitto.
    expect(random.value).not.toBe('02:00:00:00:00:24');

    // Un indirizzo clonato e' stato scelto per farsi riconoscere da quella
    // rete: cambiarlo vanificherebbe la ragione per cui e' li'.
    expect(macForNewBand({ mode: 'clone', value: '02:00:00:00:00:05' })).toEqual({
      mode: 'clone',
      value: '02:00:00:00:00:05',
    });
  });
});

describe('finding and matching', () => {
  const only24 = net({ section: 'net_24', bands: { '2.4': true, '5': false } });
  const only5 = net({ section: 'net_5', ssid: 'Altra', bands: { '2.4': false, '5': true } });
  const saved = [only24, only5];

  it('looks for the entry that covers the band, not just the name', () => {
    expect(findSavedOn(saved, 'Casa Mia', '2.4')).toBe(only24);
    expect(findSavedOn(saved, 'Casa Mia', '5')).toBeUndefined();
    // Senza una banda nota - una WAN via cavo - resta il solo nome.
    expect(findSavedOn(saved, 'Casa Mia', '')).toBe(only24);
    expect(findSaved(saved, 'Casa Mia')).toBe(only24);
  });

  it('reports a conflict only on the band the other entry already covers', () => {
    const conflicts = bandConflicts(
      [only24],
      'Casa Mia',
      { '2.4': true, '5': true },
      'net_nuova',
    );
    expect(conflicts).toEqual([{ band: '2.4', net: only24 }]);

    // La stessa voce non e' in conflitto con se stessa.
    expect(bandConflicts([only24], 'Casa Mia', { '2.4': true, '5': true }, 'net_24')).toEqual([]);
  });

  it('marks as connected only the network enabled on the uplink band', () => {
    const uplink = { kind: 'wifi', ssid: 'Casa Mia', band: '5', up: true, ipv4: '10.0.0.2' } as Uplink;
    expect(connectedVia([uplink], only24)).toBeUndefined();
    expect(connectedVia([uplink], net())).toBe(uplink);
  });
});

let container: HTMLDivElement;
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((element) => element.textContent === label)!;
const checkboxes = (group: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`[aria-labelledby="${group}"] input`)];

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({});
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  act(() => render(null, container));
  container.remove();
});

const radios: Radio[] = [
  { name: 'radio0', band: '2.4', device: 'phy0-ap0', up: true, setupFailed: false, channel: 1,
    apSection: 'ap0', apSsid: 'ciao', apEnabled: true, staSection: null, staEnabled: false },
  { name: 'radio1', band: '5', device: 'phy1-ap0', up: true, setupFailed: false, channel: 36,
    apSection: 'ap1', apSsid: 'ciao', apEnabled: true, staSection: null, staEnabled: false },
];

describe('the saved list', () => {
  it('is one list, and every row says which bands it is enabled on', async () => {
    const both = net({ section: 'net_a', ssid: 'Casa Mia', priority: 30 });
    const only24 = net({ section: 'net_b', ssid: 'Bar', priority: 10, bands: { '2.4': true, '5': false } });

    await act(() =>
      render(
        <SavedNetworksScreen
          saved={[both, only24]}
          radios={radios}
          uplinks={[]}
          onReload={() => {}}
          onBack={() => {}}
        />,
        container,
      ),
    );

    // Una sola lista: prima ce n'era una per banda, e la stessa rete di casa
    // compariva in tutte e due.
    expect(container.querySelectorAll('ul.list')).toHaveLength(1);
    expect(container.querySelectorAll('li')).toHaveLength(2);

    const rows = [...container.querySelectorAll('li')];
    expect([...rows[0].querySelectorAll('.badge--band')].map((b) => b.textContent)).toEqual(['2.4', '5']);
    expect([...rows[1].querySelectorAll('.badge--band')].map((b) => b.textContent)).toEqual(['2.4']);
    // La posizione per priorita' e' quella dell'elenco intero.
    expect(rows[0].textContent).toContain('1');
    expect(rows[1].textContent).toContain('2');
  });
});

describe('editing a saved network', () => {
  const open = async (over: Partial<SavedNetwork> = {}, all: SavedNetwork[] = []) => {
    const target = net(over);
    await act(() =>
      render(
        <SavedSheet net={target} saved={all.length ? all : [target]} radios={radios} onClose={() => {}} />,
        container,
      ),
    );
    await act(async () => { await Promise.resolve(); });
    await act(() => button('Modifica').click());
    return target;
  };

  it('offers one checkbox per band and writes the three states uci understands', async () => {
    await open();
    const boxes = checkboxes('bande-rete');
    expect(boxes.map((box) => box.checked)).toEqual([true, true]);

    await act(() => {
      boxes[1].checked = false;
      boxes[1].dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(() => button('Salva').click());

    expect(rpc).toHaveBeenCalledWith('uci', 'set', {
      config: 'travel',
      section: 'net_a',
      values: expect.objectContaining({ band: '2.4' }),
    });
  });

  it('refuses to save a network with no band at all', async () => {
    await open();
    const boxes = checkboxes('bande-rete');
    for (const box of boxes) {
      await act(() => {
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    expect(button('Salva').disabled).toBe(true);
    expect(container.textContent).toContain('Scegli almeno una banda');
  });

  it('stops before creating a duplicate on a band another entry already covers', async () => {
    const other = net({ section: 'net_b', bands: { '2.4': false, '5': true }, note: 'quella vecchia' });
    const mine = net({ section: 'net_a', bands: { '2.4': true, '5': false } });
    await act(() =>
      render(<SavedSheet net={mine} saved={[mine, other]} radios={radios} onClose={() => {}} />, container),
    );
    await act(async () => { await Promise.resolve(); });
    await act(() => button('Modifica').click());

    const boxes = checkboxes('bande-rete');
    await act(() => {
      boxes[1].checked = true;
      boxes[1].dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.textContent).toContain("è già salvata a 5 GHz in un'altra voce");
    expect(button('Salva').disabled).toBe(true);
    // La configurazione che c'era gia' non viene toccata di nascosto.
    expect(rpc).not.toHaveBeenCalledWith('uci', 'set', expect.objectContaining({ section: 'net_b' }));
  });
});

describe('saving a network found by scanning', () => {
  const found: ScanResult = {
    ssid: 'Hotel-Guest', bssid: '00:11:22:33:44:55', channel: 6, band: '2.4', signal: -60,
    open: false, security: 'WPA2', wpa: [2], auth: ['psk'], hidden: false, radio: 'radio0', count: 1,
  };
  const plan: ConnectionPlan = {
    staRadio: radios[0], otherRadio: radios[1], sharesRadioWithAp: true,
    otherApActive: true, noApAtAll: false,
  };

  it('locks the band the network was found on and leaves the other one free', async () => {
    await act(() =>
      render(<ConnectSheet net={found} plan={plan} saved={[]} onClose={() => {}} />, container),
    );
    await act(async () => { await Promise.resolve(); });

    const boxes = checkboxes('bande-salvataggio');
    // La banda della scansione e' l'unica di cui si sa che la rete c'e' e che
    // la password e' quella: resta accesa e non si puo' spegnere.
    expect(boxes[0].checked).toBe(true);
    expect(boxes[0].disabled).toBe(true);
    expect(boxes[1].checked).toBe(false);
    expect(boxes[1].disabled).toBe(false);
  });

  it('offers to add the band to the network already saved on the other one', async () => {
    const known = net({ ssid: 'Hotel-Guest', bands: { '2.4': false, '5': true } });
    await act(() =>
      render(<ConnectSheet net={found} plan={plan} saved={[known]} onClose={() => {}} />, container),
    );
    await act(async () => { await Promise.resolve(); });

    // Nessuna seconda voce da salvare: e' la stessa rete, e la scelta e' se
    // aggiungerle questa banda.
    expect(checkboxes('bande-salvataggio')).toHaveLength(0);
    expect(container.textContent).toContain('aggiungi anche');
  });

  it('opens on the saved configuration and connects with no password retyped', async () => {
    const known = net({
      ssid: 'Hotel-Guest',
      bands: { '2.4': true, '5': false },
      mac: { '2.4': { mode: 'clone', value: '02:00:00:00:00:24' }, '5': device },
      hostname_mode: 'custom',
      hostname_value: 'beryl',
    });
    await act(() =>
      render(<ConnectSheet net={found} plan={plan} saved={[known]} onClose={() => {}} />, container),
    );
    await act(async () => { await Promise.resolve(); });

    // Il messaggio che dice che la rete c'è già resta dov'era, con le sue bande.
    expect(container.textContent).toContain('Questa rete è già salvata (2.4 GHz)');

    // I campi partono dalla configurazione salvata, e restano modificabili.
    expect(container.textContent).toContain('02:00:00:00:00:24');
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
    // Connetti è subito premibile: la password non serve, ce l'ha il router.
    expect(button('Connetti').disabled).toBe(false);

    await act(() => button('Connetti').click());
    await act(async () => { await Promise.resolve(); });

    // La chiave non passa dal browser: la configurazione la prepara il router
    // a partire dalla voce salvata, e non si scrive nessuna sezione nuova.
    expect(rpc).toHaveBeenCalledWith('travel', 'stage_connect_saved', {
      section: known.section,
      radio: 'radio0',
    });
    expect(rpc).not.toHaveBeenCalledWith('uci', 'add', expect.anything());
    // Niente da riscrivere sopra: MAC e nome DHCP sono quelli salvati.
    expect(rpc).not.toHaveBeenCalledWith(
      'uci',
      'set',
      expect.objectContaining({ config: 'wireless' }),
    );
  });

  it('writes the MAC over the staged section only when the popup shows a different one', async () => {
    // Il MAC clonato serve a farsi riconoscere da un portale: e' salvato, il
    // router lo scrive preparando la sezione, e il modulo non deve ripeterlo.
    const known = net({
      ssid: 'Hotel-Guest',
      bands: { '2.4': true, '5': false },
      mac: { '2.4': { mode: 'clone', value: '02:00:00:00:00:24' }, '5': device },
    });
    await act(() =>
      render(<ConnectSheet net={found} plan={plan} saved={[known]} onClose={() => {}} />, container),
    );
    await act(async () => { await Promise.resolve(); });

    // Cambiandolo in "quello della radio", l'indirizzo salvato va tolto dalla
    // sezione appena preparata: altrimenti si andrebbe in rete con un MAC che
    // il modulo non mostra più.
    await act(() => button('Della scheda').click());
    await act(() => button('Connetti').click());
    await act(async () => { await Promise.resolve(); });

    expect(rpc).toHaveBeenCalledWith('uci', 'delete', {
      config: 'wireless',
      section: 'sta_radio0',
      option: 'macaddr',
    });
  });

  it('writes the retyped password itself instead of asking the router for the saved one', async () => {
    const known = net({ ssid: 'Hotel-Guest', bands: { '2.4': true, '5': false } });
    await act(() =>
      render(<ConnectSheet net={found} plan={plan} saved={[known]} onClose={() => {}} />, container),
    );
    await act(async () => { await Promise.resolve(); });

    const field = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(() => {
      field.value = 'passwordnuova';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(() => button('Connetti').click());
    await act(async () => { await Promise.resolve(); });

    expect(rpc).not.toHaveBeenCalledWith('travel', 'stage_connect_saved', expect.anything());
    expect(rpc).toHaveBeenCalledWith(
      'uci',
      'add',
      expect.objectContaining({
        values: expect.objectContaining({ key: 'passwordnuova', ssid: 'Hotel-Guest' }),
      }),
    );
  });

  it('keeps the password mandatory on a network nobody has saved yet', async () => {
    await act(() =>
      render(<ConnectSheet net={found} plan={plan} saved={[]} onClose={() => {}} />, container),
    );
    await act(async () => { await Promise.resolve(); });

    // Regola invariata dove non c'e' niente da riusare.
    expect(button('Connetti').disabled).toBe(true);
  });

  it('still lets the network be saved on its own when that offer is declined', async () => {
    const known = net({ ssid: 'Hotel-Guest', bands: { '2.4': false, '5': true } });
    await act(() =>
      render(<ConnectSheet net={found} plan={plan} saved={[known]} onClose={() => {}} />, container),
    );
    await act(async () => { await Promise.resolve(); });

    const offer = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][0];
    await act(() => {
      offer.checked = false;
      offer.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Rifiutare l'estensione non deve voler dire non poterla salvare affatto:
    // la banda della scansione e' libera, quindi la voce a parte e' legittima.
    expect(container.textContent).toContain('Salva questa rete come voce a parte');
    const boxes = checkboxes('bande-salvataggio');
    expect(boxes[0].checked).toBe(true);
    // L'altra banda invece e' occupata da quella voce: spenta e bloccata,
    // perche' un doppione su quella radio non verrebbe mai provato.
    expect(boxes[1].checked).toBe(false);
    expect(boxes[1].disabled).toBe(true);
  });
});
