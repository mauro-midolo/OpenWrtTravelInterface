import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Esegue l'helper reale con sysfs e configurazione isolati in una directory
// temporanea. Le scritture hardware e il database UCI sono simulati.
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const source = readFileSync(resolve('../package/travel/files/usr/share/travel/led.sh'), 'utf8');
let root: string;
const file = (path: string) => join(root, path);
const read = (path: string) => readFileSync(file(path), 'utf8').trim();
const write = (path: string, text: string) => writeFileSync(file(path), text);
const shellPath = (path: string) => path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);

function run(command: string) {
  const result = spawnSync(shell, ['-c', `. '${shellPath(file('led.sh'))}'\n${command}`], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'travel-led-test-'));
  for (const name of ['blue-status', 'white-status', 'green-lan']) {
    mkdirSync(file(`sys/class/leds/${name}`), { recursive: true });
    write(`sys/class/leds/${name}/brightness`, '1\n');
    write(`sys/class/leds/${name}/trigger`, 'none [timer]\n');
    write(`sys/class/leds/${name}/max_brightness`, '255\n');
  }
  mkdirSync(file('etc/config'), { recursive: true });
  mkdirSync(file('var/lock'), { recursive: true });
  const base = shellPath(root);
  const fixture = source
    .replaceAll('/sys/class/leds/', `${base}/sys/class/leds/`)
    .replaceAll('/etc/config/', `${base}/etc/config/`)
    .replaceAll('/var/lock/', `${base}/var/lock/`)
    .replace('. /lib/functions/leds.sh', `get_dt_led() { case "$1" in boot) echo white-status ;; *) echo blue-status ;; esac; }
uci() { sed -n "s/.*option enabled '\\([01]\\)'.*/\\1/p" '${base}/etc/config/travel_led' 2>/dev/null; }`);
  write('led.sh', fixture);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('router LED helper', () => {
  it('turns both status colors off, disables blinking and saves a UCI config', () => {
    const result = run('led_set 0');
    expect(result.status, result.stderr).toBe(0);
    expect(read('sys/class/leds/blue-status/brightness')).toBe('0');
    expect(read('sys/class/leds/white-status/brightness')).toBe('0');
    expect(read('sys/class/leds/blue-status/trigger')).toBe('none');
    expect(read('sys/class/leds/green-lan/brightness')).toBe('1');
    expect(read('etc/config/travel_led')).toContain("option enabled '0'");
  });
  it('turns ON only the running color, using max_brightness', () => {
    const result = run('led_set 1');
    expect(result.status, result.stderr).toBe(0);
    expect(read('sys/class/leds/blue-status/brightness')).toBe('255');
    expect(read('sys/class/leds/white-status/brightness')).toBe('0');
  });
  it('restores OFF in a fresh process after simulated reboot', () => {
    expect(run('led_set 0').status).toBe(0);
    for (const name of ['blue-status', 'white-status']) {
      write(`sys/class/leds/${name}/brightness`, '1\n');
      write(`sys/class/leds/${name}/trigger`, '[timer] none\n');
    }
    const result = run('led_apply');
    expect(result.status, result.stderr).toBe(0);
    expect(read('sys/class/leds/blue-status/brightness')).toBe('0');
    expect(read('sys/class/leds/white-status/brightness')).toBe('0');
    expect(run('led_detect && led_get && echo "$LED_ENABLED"').stdout.trim()).toBe('0');
  });
  it('keeps OpenWrt defaults until a preference is saved', () => {
    expect(run('led_apply').status).toBe(0);
    expect(read('sys/class/leds/blue-status/trigger')).toBe('none [timer]');
    expect(existsSync(file('etc/config/travel_led'))).toBe(false);
  });
  it('rolls hardware back when saving fails', () => {
    write('etc/config/travel_led', "config led 'main'\n option enabled '1'\n");
    const result = run('mv() { return 1; }; led_set 0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Could not save');
    expect(read('sys/class/leds/blue-status/brightness')).toBe('1');
    expect(read('sys/class/leds/white-status/trigger')).toBe('timer');
    expect(read('etc/config/travel_led')).toContain("enabled '1'");
    expect(existsSync(file('var/lock/travel-led'))).toBe(false);
  });
  it('does not save when hardware application fails', () => {
    write('sys/class/leds/blue-status/max_brightness', 'invalid');
    expect(run('led_set 1').status).toBe(1);
    expect(existsSync(file('etc/config/travel_led'))).toBe(false);
    expect(read('sys/class/leds/blue-status/trigger')).toBe('timer');
  });
  it('rejects invalid input, unavailable hardware and concurrent writes', () => {
    expect(run('led_set invalid').status).toBe(1);
    expect(run('get_dt_led() { echo missing; }; led_set 0').status).toBe(1);
    mkdirSync(file('var/lock/travel-led'));
    expect(run('led_set 0').stderr).toContain('being changed');
    expect(existsSync(file('etc/config/travel_led'))).toBe(false);
  });
});
