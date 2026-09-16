import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * ucode NON fa hoisting delle dichiarazioni di funzione.
 *
 * Chiamare una funzione scritta piu' in basso nel file non e' uno stile
 * discutibile, e' un errore di esecuzione: sotto `-S` diventa "access to
 * undeclared variable <nome>" e interrompe il giro di controllo del daemon.
 * Verificato sul router con un caso minimo, che produce esattamente quel
 * messaggio.
 *
 * `ucode -c` non lo vede: e' un errore a runtime, non di compilazione, quindi
 * un controllo statico qui e' l'unico modo di accorgersene prima del router. E
 * il punto in cui capita e' quello che decide quanto costa: `applyConnection`
 * scriveva la configurazione della STA, la committava, e moriva sulla riga
 * dopo - prima di `wifi up`. La radio non veniva mai alzata.
 */
const daemon = readFileSync(
  resolve('../package/travel/files/usr/share/travel/traveld.uc'),
  'utf8',
);

interface Use {
  name: string;
  usedAt: number;
  declaredAt: number;
}

/** Righe senza commenti: un nome dentro un commento non e' una chiamata. */
function stripComments(text: string): string[] {
  let inBlock = false;
  return text.split('\n').map((line) => {
    let out = line;
    if (inBlock) {
      const end = out.indexOf('*/');
      if (end < 0) return '';
      out = out.slice(end + 2);
      inBlock = false;
    }
    const block = out.indexOf('/*');
    if (block >= 0) {
      inBlock = out.indexOf('*/', block) < 0;
      out = out.slice(0, block) + (inBlock ? '' : out.slice(out.indexOf('*/', block) + 2));
    }
    const slash = out.indexOf('//');
    return slash >= 0 ? out.slice(0, slash) : out;
  });
}

/** Funzioni usate prima della riga in cui sono dichiarate. */
function usedBeforeDeclared(source: string): Use[] {
  const lines = stripComments(source);
  const declared = new Map<string, number>();

  lines.forEach((line, i) => {
    const match = /^function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
    if (match) declared.set(match[1], i + 1);
  });

  const found: Use[] = [];
  for (const [name, declaredAt] of declared) {
    // Preceduto da un punto e' un metodo di un oggetto, non questa funzione.
    const call = new RegExp(`(^|[^A-Za-z0-9_.])${name}\\s*\\(`);
    for (let i = 0; i < declaredAt - 1; i++) {
      if (call.test(lines[i])) {
        found.push({ name, usedAt: i + 1, declaredAt });
        break;
      }
    }
  }
  return found.sort((a, b) => a.usedAt - b.usedAt);
}

describe('ordine delle funzioni in traveld.uc', () => {
  it('nessuna funzione viene usata prima di essere dichiarata', () => {
    // Se questo test diventa rosso, il daemon si interrompe a meta' del giro
    // di controllo sul router: sposta la dichiarazione sopra al suo uso, non
    // il contrario.
    expect(usedBeforeDeclared(daemon)).toEqual([]);
  });

  it('il controllo sa davvero trovare il difetto che cerca', () => {
    // Un test che non puo' fallire non protegge niente: qui si riproduce la
    // forma esatta del bug - `applyHostname` chiamata trenta righe prima della
    // sua dichiarazione - e si pretende che venga trovata.
    const broken = [
      'function applyConnection(radio, net) {',
      "\tapplyHostname('wwan_' + radio, net);",
      '\treturn true;',
      '}',
      '',
      'function applyHostname(network, net) {',
      '\treturn network;',
      '}',
    ].join('\n');

    expect(usedBeforeDeclared(broken)).toEqual([
      { name: 'applyHostname', usedAt: 2, declaredAt: 6 },
    ]);
  });

  it('non scambia per chiamata un nome dentro un commento', () => {
    const fine = [
      '// applyHostname(x) va chiamata dopo, e questo commento non conta.',
      '/* nemmeno applyHostname(x) qui dentro */',
      'function applyHostname(network) { return network; }',
      'applyHostname("wan");',
    ].join('\n');

    expect(usedBeforeDeclared(fine)).toEqual([]);
  });

  it('non scambia per chiamata un metodo omonimo di un oggetto', () => {
    const fine = [
      'ctx.commit("network");',
      'function commit(what) { return what; }',
    ].join('\n');

    expect(usedBeforeDeclared(fine)).toEqual([]);
  });
});
