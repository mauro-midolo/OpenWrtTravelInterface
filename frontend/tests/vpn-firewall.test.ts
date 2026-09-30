import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Le funzioni vere del plugin rpcd, estratte dal file vero ed eseguite con
// `uci` simulato. Non una copia: se qualcuno le riscrive, il test legge la
// riscrittura.
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const rpcd = readFileSync(resolve('../package/travel/files/usr/libexec/rpcd/travel'), 'utf8');

/** Una funzione shell dal file, dalla sua riga di apertura al `}` in colonna zero. */
function fn(name: string): string {
  const lines = rpcd.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  if (start < 0) throw new Error(`funzione ${name} non trovata nel plugin rpcd`);
  const end = lines.indexOf('}', start);
  if (end < 0) throw new Error(`fine di ${name} non trovata`);
  return lines.slice(start, end + 1).join('\n');
}

let root: string;
const file = (p: string) => join(root, p);
const shellPath = (p: string) =>
  p.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);

/**
 * `uci` finto su un archivio piatto.
 *
 * Il confronto delle chiavi si fa con awk per uguaglianza esatta: `sed`
 * tratterebbe come metacaratteri i punti dei nomi di sezione.
 */
const stubs = (base: string) =>
  [
    `UCI_DB='${base}/uci.db'`,
    'uci() {',
    '\t[ "$1" = "-q" ] && shift',
    '\tcase "$1" in',
    '\t\tget)',
    '\t\t\t_v=$(awk -F= -v k="$2" \'$1==k { sub(/^[^=]*=/, ""); v=$0 } END { print v }\' "$UCI_DB")',
    '\t\t\t[ -n "$_v" ] || return 1',
    '\t\t\tprintf \'%s\\n\' "$_v" ;;',
    '\t\tset)',
    '\t\t\t_k="${2%%=*}"; _val="${2#*=}"',
    '\t\t\tawk -F= -v k="$_k" \'$1!=k\' "$UCI_DB" > "$UCI_DB.t" && mv "$UCI_DB.t" "$UCI_DB"',
    '\t\t\tprintf \'%s=%s\\n\' "$_k" "$_val" >> "$UCI_DB" ;;',
    '\tesac',
    '}',
  ].join('\n');

/** Esegue `ts_exit_wg_rule` con il valore chiesto e riporta com'e' rimasto uci. */
function toggle(want: '0' | '1') {
  const script = [
    stubs(shellPath(root)),
    fn('ts_exit_wg_one'),
    fn('ts_exit_wg_rule'),
    `ts_exit_wg_rule ${want}`,
    'printf \'changed=%s\\n\' "$?"',
  ].join('\n');

  const result = spawnSync(shell, ['-c', script], { encoding: 'utf8' });
  if (result.error) throw result.error;

  const db = readFileSync(file('uci.db'), 'utf8');
  const get = (key: string) =>
    db.split('\n').find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';

  return { db, get, changed: result.stdout.includes('changed=0') };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vpn-fw-'));
  writeFileSync(file('uci.db'), '');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('l’uscita del tailnet dentro WireGuard', () => {
  it('crea due sezioni, una per famiglia', () => {
    // Due sezioni esplicite e non una regola senza `family`: `src_ip` forza
    // comunque la famiglia, e una regola sola non puo' avere due sorgenti di
    // famiglie diverse.
    const { get } = toggle('1');

    expect(get('firewall.travel_vpn_wg.family')).toBe('ipv4');
    expect(get('firewall.travel_vpn_wg.src_ip')).toBe('100.64.0.0/10');
    expect(get('firewall.travel_vpn_wg6.family')).toBe('ipv6');
    // Il range IPv6 del tailnet.
    expect(get('firewall.travel_vpn_wg6.src_ip')).toBe('fd7a:115c:a1e0::/48');
  });

  it('accetta tutti i protocolli, ICMP compreso', () => {
    // Senza `proto`, fw4 NON accetta tutto: rende due regole `meta l4proto tcp`
    // e `meta l4proto udp`, e ICMP resta fuori. In IPv6 e' un guasto vero -
    // niente "Packet Too Big", e i router v6 non frammentano - quindi i
    // pacchetti grandi sparirebbero in silenzio.
    const { get } = toggle('1');

    expect(get('firewall.travel_vpn_wg.proto')).toBe('all');
    expect(get('firewall.travel_vpn_wg6.proto')).toBe('all');
  });

  it('mette proto su una regola nata senza, e chiede il reload', () => {
    // Le regole scritte prima che `proto` esistesse vanno allineate: restare
    // senza vorrebbe dire tenere il guasto su un router aggiornato.
    writeFileSync(
      file('uci.db'),
      [
        'firewall.travel_vpn_wg=rule',
        'firewall.travel_vpn_wg.family=ipv4',
        'firewall.travel_vpn_wg.enabled=1',
        'firewall.travel_vpn_wg6=rule',
        'firewall.travel_vpn_wg6.family=ipv6',
        'firewall.travel_vpn_wg6.enabled=1',
      ].join('\n') + '\n',
    );

    const { get, changed } = toggle('1');

    expect(get('firewall.travel_vpn_wg.proto')).toBe('all');
    expect(get('firewall.travel_vpn_wg6.proto')).toBe('all');
    // Niente e' cambiato in `enabled`, ma la regola resa e' diversa: il
    // firewall va ricaricato lo stesso.
    expect(changed).toBe(true);
  });

  it('le accende insieme', () => {
    const { get, changed } = toggle('1');

    expect(get('firewall.travel_vpn_wg.enabled')).toBe('1');
    expect(get('firewall.travel_vpn_wg6.enabled')).toBe('1');
    expect(changed).toBe(true);
  });

  it('le spegne insieme', () => {
    toggle('1');
    const { get, changed } = toggle('0');

    // Mai una accesa e l'altra spenta: meta' del traffico uscirebbe dal tunnel
    // e meta' verrebbe rifiutata, e chi guarda vedrebbe "internet a tratti"
    // invece di un guasto pulito.
    expect(get('firewall.travel_vpn_wg.enabled')).toBe('0');
    expect(get('firewall.travel_vpn_wg6.enabled')).toBe('0');
    expect(changed).toBe(true);
  });

  it('non segnala un cambiamento quando non c’e’', () => {
    // Chi chiama usa la risposta per decidere se ricaricare il firewall: un
    // "sì" di troppo e' un reload di troppo a ogni salvataggio.
    toggle('1');
    expect(toggle('1').changed).toBe(false);
  });

  it('crea la gemella mancante su un router configurato prima che esistesse', () => {
    // Solo la sezione v4, com'e' su un router aggiornato a meta': la v6 deve
    // comparire senza pretendere un altro deploy, e allineata alla prima.
    writeFileSync(
      file('uci.db'),
      [
        'firewall.travel_vpn_wg=rule',
        'firewall.travel_vpn_wg.family=ipv4',
        'firewall.travel_vpn_wg.enabled=1',
      ].join('\n') + '\n',
    );

    const { get, changed } = toggle('1');

    expect(get('firewall.travel_vpn_wg6.enabled')).toBe('1');
    expect(get('firewall.travel_vpn_wg6.family')).toBe('ipv6');
    // La v4 era gia' a posto, ma la v6 e' stata creata: il firewall va
    // ricaricato lo stesso.
    expect(changed).toBe(true);
  });
});
