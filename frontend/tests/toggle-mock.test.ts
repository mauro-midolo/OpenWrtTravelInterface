import { expect, it } from 'vitest';
import { mockCall } from '../src/lib/mock';

it('simulates the toggle configuration persisting across reads and rejects unknown actions', async () => {
  expect(await mockCall('travel', 'toggle_get', {}))
    .toEqual({ action: 'none', position: 'off', actions: ['none', 'led'], names: {} });
  expect(await mockCall('travel', 'toggle_set', { action: 'led' }))
    .toMatchObject({ action: 'led' });
  expect(await mockCall('travel', 'toggle_get', {})).toMatchObject({ action: 'led' });
  expect(await mockCall('travel', 'toggle_set', { action: 'apri-il-garage' })).toHaveProperty('error');
  expect(await mockCall('travel', 'toggle_set', { action: 3 })).toHaveProperty('error');
  expect(await mockCall('travel', 'toggle_get', {})).toMatchObject({ action: 'led' });
  await mockCall('travel', 'toggle_set', { action: 'none' });
});

it('lines the simulated LED up with the switch when the function is chosen', async () => {
  // Lo stato del simulatore e' condiviso: si parte da una situazione nota.
  await mockCall('travel', 'toggle_set', { action: 'none' });
  await mockCall('travel', 'led_set', { enabled: true });
  // La levetta e' in basso: scegliere la funzione spegne subito il LED,
  // altrimenti resterebbe acceso a smentirla.
  expect(await mockCall('travel', 'toggle_get', {})).toMatchObject({ position: 'off' });
  await mockCall('travel', 'toggle_set', { action: 'led' });
  expect(await mockCall('travel', 'led_get', {})).toMatchObject({ enabled: false });
});

/** Il file .conf che il simulatore accetta: gli bastano le due righe. */
const CONF = 'PrivateKey = x\nEndpoint = vpn.example:51820';

async function importWg(name: string): Promise<string> {
  const result = await mockCall('travel', 'wg_import', { config: CONF, name });
  return String((result as { id: string }).id);
}

it('offers each saved WireGuard configuration by name, and none before there are any', async () => {
  await mockCall('travel', 'toggle_set', { action: 'none' });
  // Le voci fisse ci sono sempre; quelle nominate le crea chi salva un tunnel.
  expect(await mockCall('travel', 'toggle_get', {})).toMatchObject({ actions: ['none', 'led'] });
  const casa = await importWg('Casa');
  const ufficio = await importWg('Ufficio');
  expect(await mockCall('travel', 'toggle_get', {})).toMatchObject({
    actions: ['none', 'led', `wg:${casa}`, `wg:${ufficio}`],
    names: { [`wg:${casa}`]: 'Casa', [`wg:${ufficio}`]: 'Ufficio' },
  });
});

// La levetta del simulatore sta in basso e da un browser non si muove: qui si
// vede l'allineamento verso "spento". Quello verso "acceso" lo prova
// `toggle-wireguard.test.ts`, che gira gli helper veri del router.
it('lines the chosen WireGuard configuration up with the switch as soon as it is chosen', async () => {
  const casa = await importWg('Casa 2');
  const ufficio = await importWg('Ufficio 2');
  // Ufficio è accesa dall'interfaccia, la levetta è in basso.
  await mockCall('travel', 'toggle_set', { action: 'none' });
  await mockCall('travel', 'wg_toggle', { enabled: '1', id: ufficio });
  expect(await mockCall('travel', 'wg_get', {})).toMatchObject({ active: ufficio });

  // Associare Casa alla levetta la applica subito a dov'è la levetta adesso:
  // in basso, quindi spenta. E non resta accesa Ufficio a smentirla: da adesso
  // l'interfaccia non la potrebbe più spegnere.
  await mockCall('travel', 'toggle_set', { action: `wg:${casa}` });
  expect(await mockCall('travel', 'wg_get', {}))
    .toMatchObject({ active: '', enabled: false, toggle: casa });
});

it('takes activation away from the interface while the switch commands it', async () => {
  const casa = await importWg('Casa 3');
  const altra = await importWg('Altra 3');
  await mockCall('travel', 'toggle_set', { action: `wg:${casa}` });

  // Né quella comandata né le altre: accenderne un'altra spegnerebbe questa, e
  // la levetta resterebbe dov'è a dire il contrario.
  expect(await mockCall('travel', 'wg_toggle', { enabled: '0', id: casa })).toHaveProperty('error');
  expect(await mockCall('travel', 'wg_toggle', { enabled: '1', id: altra })).toHaveProperty('error');

  // Tolta l'associazione, i pulsanti tornano utilizzabili e lo stato del
  // tunnel non viene toccato: si restituisce il comando, non si cambia niente.
  const before = await mockCall('travel', 'wg_get', {});
  await mockCall('travel', 'toggle_set', { action: 'none' });
  const after = await mockCall('travel', 'wg_get', {});
  expect(after).toMatchObject({ active: (before as { active: string }).active, toggle: '' });
  expect(await mockCall('travel', 'wg_toggle', { enabled: '1', id: altra })).not.toHaveProperty('error');
});
