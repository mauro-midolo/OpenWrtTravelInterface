import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setLang } from '../src/i18n';
import { autoText, daemonMessage } from '../src/i18n/auto';
import { BACKEND_CODES, backendMessage } from '../src/i18n/backend';
import { backendError } from '../src/lib/ubus-error';

// Un codice che il router manda e l'interfaccia non conosce si vede in
// italiano anche a chi ha scelto l'inglese. Qui si leggono i sorgenti del
// pacchetto e si controlla che ognuno abbia la sua frase.
const pkg = (path: string) => readFileSync(resolve(`../package/travel/files/${path}`), 'utf8');

function codes(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

/** Senza i commenti: li' i codici compaiono come esempi, non come errori. */
const code = (source: string) =>
  source
    .split('\n')
    .filter((line) => !line.trim().startsWith('#') && !line.trim().startsWith('//'))
    .join('\n');

const rpcd = code(pkg('usr/libexec/rpcd/travel'));
const helpers = ['led', 'toggle', 'wg', 'ap'].map((name) => ({
  name,
  source: code(pkg(`usr/share/travel/${name}.sh`)),
}));
const traveld = code(pkg('usr/share/travel/traveld.uc'));

afterEach(() => setLang('it'));

describe('backend error codes', () => {
  it('has an English message for every rpcd code', () => {
    const found = [
      ...codes(rpcd, /\bfail_code ([a-z_0-9]+) /g),
      ...codes(rpcd, /json_add_string error_code ([a-z_0-9]+)/g),
      ...codes(rpcd, /WG_CODE=([a-z_0-9]+);/g),
      ...codes(rpcd, /json_add_string note_code ([a-z_0-9]+)/g),
    ];
    expect(found.length).toBeGreaterThan(50);
    expect(found.filter((code) => !BACKEND_CODES().includes(code))).toEqual([]);
  });

  it('has an English message for every helper code', () => {
    for (const { name, source } of helpers) {
      const found = codes(source, new RegExp(`\\b${name}_error ([a-z_0-9]+) `, 'g'));
      expect(found.length, name).toBeGreaterThan(0);
      expect(found.filter((code) => !BACKEND_CODES().includes(code)), name).toEqual([]);
    }
  });

  it('knows every traveld error and event code', () => {
    const errors = codes(traveld, /setError\("([a-z_]+)"/g);
    const events = codes(traveld, /note\('[a-z]+',[\s\S]*?,\s*'([a-z_]+)'/g);
    expect(errors.filter((code) => !BACKEND_CODES().includes(code))).toEqual([]);
    expect(events.length).toBeGreaterThan(5);
    expect(events.filter((code) => !(code in autoText().event))).toEqual([]);
  });

  it('leaves no error without a code', () => {
    // `fail_json "$message"` resta solo dentro `fail_helper`, per gli helper
    // che non hanno scritto un codice.
    expect(rpcd.match(/\bfail_json "[^$]/g)).toBeNull();
    for (const { name, source } of helpers) {
      expect(source.match(new RegExp(`\\b${name}_error ['"]`, 'g')), name).toBeNull();
    }
  });
});

describe('backendMessage', () => {
  it('rebuilds the router sentence in Italian from the code', () => {
    expect(backendMessage('invalid hour', 'hour_invalid')).toBe('ora non valida');
    expect(backendMessage('x', 'ntp_server_invalid', { server: 'pool.example' })).toBe(
      'server NTP non valido: pool.example',
    );
  });

  it('rebuilds the sentence in English from the code', () => {
    setLang('en');
    expect(backendMessage('x', 'hour_invalid')).toBe('invalid hour');
    expect(backendMessage('x', 'wg_blocked', { holder: 'wireguard', name: 'Casa' })).toBe(
      'cannot turn on WireGuard: the WireGuard tunnel "Casa" is already carrying all traffic',
    );
  });

  it('falls back to the router sentence, in English, for unknown or missing codes', () => {
    expect(backendMessage('a new sentence', 'future_code')).toBe('a new sentence');
    expect(backendMessage('no code')).toBe('no code');
  });

  it('backendError carries the code and the translated message', () => {
    const err = backendError({ error: 'unknown profile', error_code: 'profile_unknown' });
    expect(err.code).toBe('profile_unknown');
    expect(err.message).toBe('profilo sconosciuto');
  });
});

describe('daemonMessage', () => {
  it('rebuilds traveld events in the chosen language', () => {
    const event = {
      message: 'casa@5 worked, counters reset',
      code: 'recovered',
      params: { key: 'casa@5' },
    };
    expect(daemonMessage(event)).toBe('casa@5 ha funzionato, contatori azzerati');
    setLang('en');
    expect(daemonMessage(event)).toBe('casa@5 worked, counters reset');
  });

  it('shows the daemon sentence when there is no code', () => {
    expect(daemonMessage({ message: 'event from an older daemon' })).toBe(
      'event from an older daemon',
    );
  });
});
