/**
 * Lingua dell'interfaccia: italiano o inglese.
 *
 * Niente librerie: i testi sono oggetti TypeScript, uno per area
 * (`defineText`), con le due lingue una accanto all'altra. Il tipo
 * dell'inglese e' quello dell'italiano, quindi una chiave dimenticata o
 * scritta male e' un errore di `npm run typecheck`, non una schermata con un
 * buco.
 *
 * La lingua e' uno stato del modulo e non un contesto Preact: la leggono
 * anche le funzioni di `lib/` che preparano testi fuori dai componenti, e i
 * componenti provati da soli nei test non hanno un provider sopra. Al cambio,
 * `main.tsx` ridisegna tutto l'albero (vedi `onLangChange`).
 */

export type Lang = 'it' | 'en';

/** Le lingue offerte, ognuna col nome scritto nella propria lingua. */
export const LANGS: ReadonlyArray<{ id: Lang; label: string }> = [
  { id: 'it', label: 'Italiano' },
  { id: 'en', label: 'English' },
];

const STORAGE_KEY = 'travel.lang';

/** Quando il browser non parla nessuna delle due, l'inglese e' il piu' capito. */
const FALLBACK: Lang = 'en';

function isLang(value: unknown): value is Lang {
  return value === 'it' || value === 'en';
}

function stored(): Lang | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLang(value) ? value : null;
  } catch {
    // Navigazione privata, dati del sito bloccati, test senza DOM.
    return null;
  }
}

/** La prima lingua del browser che sappiamo parlare. */
export function browserLang(languages?: readonly string[]): Lang {
  const list =
    languages ??
    (typeof navigator === 'undefined'
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : [navigator.language]);
  for (const entry of list) {
    const base = (entry ?? '').toLowerCase().split(/[-_]/)[0];
    if (isLang(base)) return base;
  }
  return FALLBACK;
}

/** La scelta salvata vince; altrimenti quella del browser. */
export function detectLang(): Lang {
  return stored() ?? browserLang();
}

let current: Lang = detectLang();
const listeners = new Set<(lang: Lang) => void>();

function applyToDocument(lang: Lang): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

applyToDocument(current);

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Non si ricorda, ma per questa pagina vale lo stesso.
  }
  if (lang === current) return;
  current = lang;
  applyToDocument(lang);
  for (const listener of listeners) listener(lang);
}

/** Avvisa a ogni cambio di lingua. Restituisce la funzione per smettere. */
export function onLangChange(listener: (lang: Lang) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Il locale per date e numeri, coerente con la lingua scelta. */
export function locale(): string {
  return current === 'it' ? 'it-IT' : 'en-GB';
}

/**
 * Testi di un'area nelle due lingue. Restituisce la funzione che da' quelli
 * della lingua corrente: si chiama a ogni render, non una volta sola, cosi'
 * un cambio di lingua si vede subito.
 */
export function defineText<T>(text: { it: T; en: NoInfer<T> }): () => T {
  return () => text[current];
}
