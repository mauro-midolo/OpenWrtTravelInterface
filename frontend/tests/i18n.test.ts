// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserLang, defineText, detectLang, getLang, locale, onLangChange, setLang } from '../src/i18n';
import { commonText } from '../src/i18n/common';

afterEach(() => {
  setLang('it');
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('browserLang', () => {
  it('reads Italian and English, whatever the region', () => {
    expect(browserLang(['it-IT'])).toBe('it');
    expect(browserLang(['it'])).toBe('it');
    expect(browserLang(['en-US'])).toBe('en');
    expect(browserLang(['en_GB'])).toBe('en');
  });

  it('takes the first language it knows, in the browser order', () => {
    expect(browserLang(['de-DE', 'it-CH', 'en-US'])).toBe('it');
    expect(browserLang(['fr-FR', 'en-US', 'it-IT'])).toBe('en');
  });

  it('falls back to English when the browser speaks neither', () => {
    expect(browserLang(['de-DE'])).toBe('en');
    expect(browserLang([])).toBe('en');
  });

  it('uses navigator.languages when not given a list', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['it-IT', 'en-US']);
    expect(browserLang()).toBe('it');
  });
});

describe('detectLang', () => {
  it('prefers the saved choice over the browser', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['it-IT']);
    localStorage.setItem('travel.lang', 'en');
    expect(detectLang()).toBe('en');
  });

  it('ignores a saved value that is not a language', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['it-IT']);
    localStorage.setItem('travel.lang', 'xx');
    expect(detectLang()).toBe('it');
  });
});

describe('setLang', () => {
  it('saves the choice, updates the document and notifies', () => {
    const seen: string[] = [];
    const stop = onLangChange((lang) => seen.push(lang));
    setLang('en');
    stop();
    setLang('it');
    expect(seen).toEqual(['en']);
    expect(localStorage.getItem('travel.lang')).toBe('it');
    expect(document.documentElement.lang).toBe('it');
  });

  it('switches texts and locale', () => {
    const text = defineText({ it: { hello: 'Ciao' }, en: { hello: 'Hello' } });
    expect(text().hello).toBe('Ciao');
    expect(locale()).toBe('it-IT');
    setLang('en');
    expect(getLang()).toBe('en');
    expect(text().hello).toBe('Hello');
    expect(locale()).toBe('en-GB');
  });
});

/** Le chiavi di un dizionario, con i percorsi annidati. */
function keys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key))
    .sort();
}

function values(value: unknown): unknown[] {
  if (value === null || typeof value !== 'object') return [value];
  return Object.values(value as Record<string, unknown>).flatMap(values);
}

describe('dictionaries', () => {
  const modules = import.meta.glob('../src/i18n/*.ts', { eager: true }) as Record<
    string,
    Record<string, unknown>
  >;
  const dictionaries = Object.entries(modules).flatMap(([file, exports]) =>
    Object.entries(exports)
      .filter(([name, value]) => name.endsWith('Text') && typeof value === 'function')
      .map(([name, value]) => [`${file}#${name}`, value as () => unknown] as const),
  );

  it('finds the dictionaries', () => {
    expect(dictionaries.map(([name]) => name)).toContain('../src/i18n/common.ts#commonText');
  });

  it.each(dictionaries)('%s has the same keys in both languages and no empty text', (_, text) => {
    setLang('it');
    const it = text();
    setLang('en');
    const en = text();
    expect(keys(en)).toEqual(keys(it));
    for (const value of [...values(it), ...values(en)]) {
      if (typeof value === 'string') expect(value.trim()).not.toBe('');
    }
  });

  it('has the login in both languages', () => {
    setLang('en');
    expect(commonText().login.submit).toBe('Sign in');
    setLang('it');
    expect(commonText().login.submit).toBe('Entra');
  });
});
