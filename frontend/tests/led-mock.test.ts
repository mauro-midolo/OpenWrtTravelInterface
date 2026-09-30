import { expect, it } from 'vitest';
import { mockCall } from '../src/lib/mock';

it('simulates LED persistence across reads and rejects invalid values', async () => {
  for (const enabled of [false, true]) {
    expect(await mockCall('travel', 'led_set', { enabled })).toEqual({ supported: true, enabled });
    expect(await mockCall('travel', 'led_get', {})).toEqual({ supported: true, enabled });
  }
  expect(await mockCall('travel', 'led_set', { enabled: 'false' })).toHaveProperty('error');
  expect(await mockCall('travel', 'led_get', {})).toEqual({ supported: true, enabled: true });
});
