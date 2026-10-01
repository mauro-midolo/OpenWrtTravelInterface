// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { usePoll } from '../src/lib/poll';
import { portalLoginUrl, safeHttpUrl } from '../src/lib/portal';

// Le regressioni chiuse dalla revisione del progetto, ciascuna provata dove
// vive: le funzioni shell nel plugin rpcd vero, il resto nel codice della SPA.

const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const rpcd = readFileSync(resolve('../package/travel/files/usr/libexec/rpcd/travel'), 'utf8');

function fn(name: string): string {
  const lines = rpcd.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  if (start < 0) throw new Error(`funzione ${name} non trovata nel plugin rpcd`);
  const end = lines.indexOf('}', start);
  if (end < 0) throw new Error(`fine di ${name} non trovata`);
  return lines.slice(start, end + 1).join('\n');
}

function sh(script: string): string {
  const result = spawnSync(shell, ['-c', script], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result.stdout;
}

describe('first_line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'travel-first-line-'));

  it('legge anche una riga senza ritorno a capo finale, come il file della versione', () => {
    const file = join(dir, 'version');
    writeFileSync(file, '1.11.0');
    expect(sh(`${fn('first_line')}\nfirst_line '${file}'`)).toBe('1.11.0');
  });

  it('con il ritorno a capo restituisce la sola prima riga', () => {
    const file = join(dir, 'lines');
    writeFileSync(file, 'uno\ndue\n');
    expect(sh(`${fn('first_line')}\nfirst_line '${file}'`)).toBe('uno');
  });

  it('un file assente non restituisce la riga letta la volta prima', () => {
    const file = join(dir, 'prima');
    writeFileSync(file, 'vecchia\n');
    const out = sh(
      `${fn('first_line')}\nfirst_line '${file}' >/dev/null\nfirst_line '${join(dir, 'manca')}'; printf '[%s]' "$_line"`,
    );
    expect(out).toBe('[]');
  });
});

describe('carrier_of', () => {
  it('un collegamento che non si puo leggere vale -1, non 0', () => {
    const script = [fn('first_line'), fn('carrier_of'), "carrier_of 'travel-non-esiste0'"].join('\n');
    expect(sh(script)).toBe('-1');
  });
});

describe('wg_parse_conf', () => {
  function parse(conf: string): Record<string, string> {
    const script = [
      fn('wg_split_endpoint'),
      fn('wg_fields_reset'),
      fn('wg_parse_conf'),
      'wg_fields_reset',
      `wg_parse_conf '${conf}'`,
      'printf \'%s\\n%s\\n%s\\n\' "$WGF_ADDR" "$WGF_ALLOWED" "$WGF_DNS"',
    ].join('\n');
    const [addr, allowed, dns] = sh(script).split('\n');
    return { addr, allowed, dns };
  }

  it('somma Address, AllowedIPs e DNS scritti su piu righe, come fa wg-quick', () => {
    const conf = [
      '[Interface]',
      'PrivateKey = aaaa',
      'Address = 10.0.0.2/32',
      'Address = fd00::2/128',
      'DNS = 10.0.0.1',
      'DNS = fd00::1',
      '[Peer]',
      'PublicKey = bbbb',
      'Endpoint = vpn.example.com:51820',
      'AllowedIPs = 0.0.0.0/0',
      'AllowedIPs = ::/0',
    ].join('\n');

    expect(parse(conf)).toEqual({
      addr: '10.0.0.2/32,fd00::2/128',
      allowed: '0.0.0.0/0,::/0',
      dns: '10.0.0.1,fd00::1',
    });
  });

  it('una riga sola resta com era', () => {
    const conf = '[Interface]\nAddress = 10.0.0.2/32, fd00::2/128\n[Peer]\nAllowedIPs = 0.0.0.0/0';
    const parsed = parse(conf);
    expect(parsed.addr).toBe('10.0.0.2/32, fd00::2/128');
    expect(parsed.allowed).toBe('0.0.0.0/0');
  });
});

describe('link della pagina di accesso', () => {
  it('lascia passare solo http e https', () => {
    expect(safeHttpUrl('http://portal.example/login?x=1')).toBe('http://portal.example/login?x=1');
    expect(safeHttpUrl('https://portal.example/')).toBe('https://portal.example/');
    expect(safeHttpUrl('javascript:alert(1)')).toBe('');
    expect(safeHttpUrl(' JavaScript:alert(1)')).toBe('');
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(safeHttpUrl('/login')).toBe('');
    expect(safeHttpUrl('')).toBe('');
    expect(safeHttpUrl(undefined)).toBe('');
  });

  it('un Location ostile ripiega sull endpoint di verifica', () => {
    expect(
      portalLoginUrl({
        url: 'javascript:fetch("/ubus")',
        probe_url: 'http://detectportal.firefox.com/success.txt',
      }),
    ).toBe('http://detectportal.firefox.com/success.txt');
  });
});

describe('usePoll', () => {
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (container) {
      act(() => render(null, container!));
      container.remove();
      container = null;
    }
    vi.useRealTimers();
  });

  it('il ritorno in primo piano a richiesta in volo non apre una seconda catena', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let release: (() => void) | null = null;
    const fn = () => {
      calls += 1;
      return new Promise<number>((done) => {
        release = () => done(calls);
      });
    };

    function Probe() {
      usePoll(fn, 1000);
      return null;
    }

    container = document.createElement('div');
    document.body.append(container);
    await act(() => render(<Probe />, container!));
    expect(calls).toBe(1);

    // La scheda torna visibile mentre la prima richiesta e' ancora in volo.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(calls).toBe(1);

    // Finita la prima, il giro successivo e' uno solo.
    await act(async () => {
      release!();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(calls).toBe(2);

    await act(async () => {
      release!();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(calls).toBe(3);
  });
});
