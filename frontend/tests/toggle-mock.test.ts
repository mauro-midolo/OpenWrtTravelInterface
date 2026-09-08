import { expect, it } from 'vitest';
import { mockCall } from '../src/lib/mock';

it('simulates the toggle configuration persisting across reads and rejects unknown actions', async () => {
  expect(await mockCall('travel', 'toggle_get', {}))
    .toEqual({ action: 'none', position: 'off', actions: ['none', 'led'] });
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
