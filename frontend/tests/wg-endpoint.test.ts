import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostPortJoin, hostPortSplit } from '../src/lib/ip';

// Le funzioni vere del plugin rpcd, estratte dal file vero. Il bug che questa
// fase chiude - un endpoint IPv6 nudo spezzato sull'ultimo ':' - vive in shell,
// quindi va provato in shell.
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

/** Esegue `wg_split_endpoint` sul valore dato e riporta host e porta. */
function split(endpoint: string): { host: string; port: string } {
  const script = [
    fn('wg_split_endpoint'),
    `wg_split_endpoint '${endpoint}'`,
    'printf \'%s\\n%s\\n\' "$WGF_HOST" "$WGF_PORT"',
  ].join('\n');

  const result = spawnSync(shell, ['-c', script], { encoding: 'utf8' });
  if (result.error) throw result.error;
  const [host, port] = result.stdout.split('\n');
  return { host, port };
}

/** Vero se il validatore accetta il valore. */
function accepts(fnName: string, value: string): boolean {
  const extra = fnName === 'valid_wg_host' ? `${fn('wg_v6_form')}\n` : '';
  const script = [
    extra || fn('wg_v6_form'),
    fn('valid_wg_addrs'),
    fnName === 'valid_wg_host' ? fn('valid_wg_host') : '',
    `${fnName} '${value}' && echo SI || echo NO`,
  ].join('\n');

  const result = spawnSync(shell, ['-c', script], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result.stdout.includes('SI');
}

describe('wg_split_endpoint: le quattro forme che esistono', () => {
  it.each([
    ['vpn.example.com:51820', 'vpn.example.com', '51820'],
    ['vpn.example.com', 'vpn.example.com', '51820'],
    ['192.0.2.1:51820', '192.0.2.1', '51820'],
    ['[2001:db8::1]:51820', '[2001:db8::1]', '51820'],
    ['[2001:db8::1]', '[2001:db8::1]', '51820'],
  ])('%s -> host %s, porta %s', (endpoint, host, port) => {
    expect(split(endpoint)).toEqual({ host, port });
  });

  it('un IPv6 nudo non viene piu’ spezzato sull’ultimo “:”', () => {
    // IL bug della fase. Prima: host "2001:db8:" e porta "1" - due valori
    // plausibili e sbagliati, scritti in uci senza che niente protestasse.
    const { host, port } = split('2001:db8::1');

    expect(host).not.toBe('2001:db8:');
    expect(port).not.toBe('1');
    expect(host).toBe('[2001:db8::1]');
    expect(port).toBe('51820');
  });

  it('le parentesi restano dentro l’host, e non e’ un errore', () => {
    // netifd ricompone l'endpoint come "$endpoint_host:$endpoint_port", cioe'
    // con una giunzione ingenua. Toglierle qui rimetterebbe il bug.
    for (const endpoint of ['2001:db8::1', '[2001:db8::1]', '[2001:db8::1]:51820']) {
      expect(split(endpoint).host.startsWith('[')).toBe(true);
      expect(split(endpoint).host.endsWith(']')).toBe(true);
    }
  });
});

describe('il giro completo, come lo vede chi incolla un file', () => {
  it('[v6]:porta torna identico', () => {
    const { host, port } = split('[2001:db8::1]:51820');
    expect(hostPortJoin(host, port)).toBe('[2001:db8::1]:51820');
  });

  it('un v6 nudo non torna identico, ma torna corretto e stabile', () => {
    // "2001:db8::1" diventa "[2001:db8::1]:51820": non e' quello che si e'
    // incollato, ma e' lo stesso endpoint, ed e' stabile al secondo giro.
    const first = split('2001:db8::1');
    const joined = hostPortJoin(first.host, first.port);
    expect(joined).toBe('[2001:db8::1]:51820');

    const again = split(joined);
    expect(hostPortJoin(again.host, again.port)).toBe(joined);
  });

  it('la giunzione ingenua darebbe un altro host, e per questo le parentesi restano', () => {
    const { host } = split('2001:db8::1');
    const bare = hostPortSplit(host).host;

    // Con una porta di quattro cifre - che e' anche un gruppo esadecimale
    // legale - il risultato e' un indirizzo valido e DIVERSO. Nessuno protesta,
    // e il tunnel punta altrove.
    expect(`${bare}:443`).toBe('2001:db8::1:443');
    expect(hostPortJoin(bare, '443')).toBe('[2001:db8::1]:443');
  });
});

describe('valid_wg_host', () => {
  it.each(['vpn.example.com', 'router', '192.0.2.1', '[2001:db8::1]', '[fd00::1]'])(
    'accetta %s',
    (host) => {
      expect(accepts('valid_wg_host', host)).toBe(true);
    },
  );

  it.each([
    // Un IPv6 nudo qui non deve arrivare: wg_split_endpoint lo mette sempre
    // fra parentesi, e accettarlo vorrebbe dire accettare uno stato che il
    // resto del codice non produce.
    '2001:db8::1',
    '[::::::]',
    '-bad.example',
    'bad-.example',
    '',
  ])('rifiuta %s', (host) => {
    expect(accepts('valid_wg_host', host)).toBe(false);
  });
});

describe('valid_wg_addrs, per famiglia', () => {
  it.each(['0.0.0.0/0', '::/0', '10.0.0.0/8,fd00::/64', '2001:db8::1/128', 'fd00::1', '192.0.2.1'])(
    'accetta %s',
    (addrs) => {
      expect(accepts('valid_wg_addrs', addrs)).toBe(true);
    },
  );

  it.each([
    // La vecchia classe di caratteri accettava tutti questi: sono caratteri
    // leciti, in un ordine che indirizzo non e'.
    '::::::',
    '::1::2',
    '1:2:3:',
    ':1:2',
    // Il prefisso va confrontato con il massimo della SUA famiglia.
    '10.0.0.0/999',
    '10.0.0.0/33',
    '2001:db8::1/129',
    '10.0.0.0/',
  ])('rifiuta %s', (addrs) => {
    expect(accepts('valid_wg_addrs', addrs)).toBe(false);
  });
});
