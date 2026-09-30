import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// I codici d'errore che l'interfaccia traduce nascono qui: `fail_code` nel
// plugin rpcd, e gli helper che li lasciano in TRAVEL_ERR_FILE per
// `fail_helper`. Si provano le funzioni vere, estratte dal file, con un jshn
// finto che stampa quello che riceve.
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const pkg = (path: string) => readFileSync(resolve(`../package/travel/files/${path}`), 'utf8');
const rpcd = pkg('usr/libexec/rpcd/travel');

/** Il corpo di una funzione shell definita a inizio riga, fino alla `}` di chiusura. */
function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`${name} non trovata`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start + 1, end + 3);
}

const jshn = [
  'json_init() { :; }',
  'json_add_string() { printf "%s=%s\\n" "$1" "$2"; }',
  'json_add_object() { printf "{%s\\n" "$1"; }',
  'json_close_object() { printf "}\\n"; }',
  'json_dump() { :; }',
].join('\n');

let root: string;
const shellPath = (path: string) =>
  path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);

function run(command: string) {
  const script = [
    jshn,
    shellFunction(rpcd, 'fail_json'),
    shellFunction(rpcd, 'fail_code'),
    shellFunction(rpcd, 'fail_helper'),
    `TRAVEL_ERR_FILE='${shellPath(join(root, 'err'))}'`,
    pkg('usr/share/travel/led.sh').match(/\nled_error\(\) \{[\s\S]*?\n\}\n/)![0],
    command,
  ].join('\n');
  const result = spawnSync(shell, ['-c', script], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'travel-err-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('fail_code', () => {
  it('sends the message, the code and the parameters', () => {
    const out = run('fail_code ntp_server_invalid "server NTP non valido: x y" server "x y"').stdout;
    expect(out.split('\n')).toEqual([
      'error=server NTP non valido: x y',
      'error_code=ntp_server_invalid',
      '{error_params',
      'server=x y',
      '}',
      '',
    ]);
  });
});

describe('fail_helper', () => {
  it('picks up the code a helper left behind, and cleans it up', () => {
    const out = run(
      'error=$(led_error led_busy "Modifica del LED in corso. Riprova." 2>&1); fail_helper "$error"; [ -e "$TRAVEL_ERR_FILE" ] && echo left',
    ).stdout;
    expect(out).toContain('error=Modifica del LED in corso. Riprova.');
    expect(out).toContain('error_code=led_busy');
    expect(out).not.toContain('left');
  });

  it('keeps parameters with spaces in one piece', () => {
    const out = run(
      'error=$(led_error wg_busy "gia attiva" name "Casa mia" 2>&1); fail_helper "$error"',
    ).stdout;
    expect(out).toContain('error_code=wg_busy');
    expect(out).toContain('name=Casa mia');
  });

  it('falls back to the bare message when no helper wrote a code', () => {
    const out = run('fail_helper "qualcosa e andato storto"').stdout;
    expect(out).toBe('error=qualcosa e andato storto\n');
  });

  it('still writes the message on stderr for the logs', () => {
    const result = run('led_error led_busy "Modifica del LED in corso. Riprova."');
    expect(result.stderr).toBe('Modifica del LED in corso. Riprova.\n');
  });
});
