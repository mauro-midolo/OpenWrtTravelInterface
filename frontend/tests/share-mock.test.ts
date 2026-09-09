import { expect, it } from 'vitest';
import { mockCall } from '../src/lib/mock';
import { UbusError } from '../src/lib/ubus-error';

it('simulates selected-section reads, open networks and committed edits without exposing keys in lists', async () => {
  const get = (section: string) => mockCall<{ values: Record<string, string> }>(
    'uci', 'get', { config: 'travel', section },
  );
  expect((await get('net_casa')).values.key).toBe('casacasacasa');
  expect((await get('net_bar')).values.key).toBeUndefined();
  await expect(get('missing')).rejects.toBeInstanceOf(UbusError);
  await expect(mockCall('uci', 'get', { config: 'travel', section: 'net_bar', option: 'key' }))
    .rejects.toMatchObject({ code: 5 });

  await mockCall('uci', 'set', { config: 'travel', section: 'net_casa',
    values: { ssid: 'Updated', encryption: 'sae', key: 'updatedpassword', hidden: '1' } });
  await mockCall('uci', 'apply', {});
  expect((await get('net_casa')).values).toMatchObject({
    ssid: 'Updated', encryption: 'sae', key: 'updatedpassword', hidden: '1',
  });
  const list = await mockCall<{ networks: Record<string, unknown>[] }>('travel', 'networks', {});
  expect(list.networks.every((network) => !('key' in network))).toBe(true);
});
