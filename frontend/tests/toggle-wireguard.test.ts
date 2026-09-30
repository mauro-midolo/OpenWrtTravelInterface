import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Gli helper veri del router - `toggle.sh` e `wg.sh` - dentro una directory
// temporanea, con `uci`, `ubus` e netifd simulati. E' l'unico modo di provare
// la cosa che conta davvero: che l'interruttore non accenda i tunnel per conto
// suo ma passi da `wg_switch`, lo stesso cancello della scheda WireGuard.
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const pkg = (path: string) => readFileSync(resolve(`../package/travel/files/${path}`), 'utf8');
const sources = { toggle: pkg('usr/share/travel/toggle.sh'), wg: pkg('usr/share/travel/wg.sh') };

let root: string;
const file = (path: string) => join(root, path);
const read = (path: string) => readFileSync(file(path), 'utf8').trim();
const shellPath = (path: string) =>
  path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);

/**
 * `uci` finto, con un archivio piatto `chiave=valore`, e `ubus` che fa le veci
 * di netifd.
 *
 * L'elenco dei profili il router lo ricava da `uci show network`: una sezione
 * `=interface` con il nome giusto *e'* un profilo WireGuard, e non c'e' un
 * secondo registro da tenere allineato. Il finto `uci` deve quindi reggere
 * anche quello, non solo `get` e `set`.
 */
const stubs = (base: string) => [
  `UCI_DB='${base}/uci.db'`,
  'uci() {',
  '\t[ "$1" = "-q" ] && shift',
  '\tcase "$1" in',
  '\t\tget)',
  // La scelta della levetta non sta in `uci.db`: `toggle_write` la scrive in
  // un file uci dedicato, ed e' da li' che il router la rilegge.
  '\t\t\tif [ "$2" = travel_toggle.main.action ]; then',
  `\t\t\t\t_v=$(sed -n "s/.*option action '\\(.*\\)'.*/\\1/p" '${base}/etc/config/travel_toggle' 2>/dev/null)`,
  '\t\t\t\t[ -n "$_v" ] || return 1',
  "\t\t\t\tprintf '%s\n' \"$_v\"",
  '\t\t\t\treturn 0',
  '\t\t\tfi',
  '\t\t\t_v=$(sed -n "s|^$2=||p" "$UCI_DB" | tail -1)',
  '\t\t\t[ -n "$_v" ] || return 1',
  "\t\t\tprintf '%s\\n' \"$_v\" ;;",
  '\t\tset)',
  '\t\t\t_k="${2%%=*}"; _val="${2#*=}"',
  '\t\t\tsed -i "\\|^$_k=|d" "$UCI_DB"',
  "\t\t\tprintf '%s=%s\\n' \"$_k\" \"$_val\" >> \"$UCI_DB\" ;;",
  '\t\tshow) grep "^$2\\." "$UCI_DB" 2>/dev/null || return 1 ;;',
  '\t\tcommit|add_list|del_list) : ;;',
  '\tesac',
  '}',
  // netifd: alza le interfacce non disabilitate e abbatte le altre. E' cio' che
  // `wg_reload` aspetta prima di considerare fatto il lavoro.
  'ubus() {',
  "\tcase \"$2 $3\" in",
  "\t\t'network reload')",
  '\t\t\tfor _s in $(sed -n "s|^network\\.\\(travel_wg[0-9]*\\)=interface$|\\1|p" "$UCI_DB"); do',
  '\t\t\t\tif [ "$(uci -q get "network.$_s.disabled")" = "1" ]; then',
  `\t\t\t\t\trm -rf '${base}/sys/class/net/'"$_s"`,
  '\t\t\t\telse',
  `\t\t\t\t\tmkdir -p '${base}/sys/class/net/'"$_s"`,
  '\t\t\t\tfi',
  '\t\t\tdone ;;',
  '\tesac',
  '}',
  'logger() { :; }',
].join('\n');

function run(command: string) {
  const script = `${stubs(shellPath(root))}\n. '${shellPath(file('toggle.sh'))}'\n${command}`;
  const result = spawnSync(shell, ['-c', script], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

/** Un profilo salvato, come lo lascerebbe `wg_import`. */
function profile(section: string, name: string, disabled: '0' | '1') {
  writeFileSync(
    file('uci.db'),
    `network.${section}=interface\n` +
      `network.${section}.travel_name=${name}\n` +
      `network.${section}.disabled=${disabled}\n` +
      `network.${section}_peer.endpoint_host=vpn.example\n`,
    { flag: 'a' },
  );
  if (disabled === '0') mkdirSync(file(`sys/class/net/${section}`), { recursive: true });
}

/**
 * Quale configurazione e' accesa adesso.
 *
 * `toggle_wg_load` prima: gli helper di WireGuard il router li carica quando
 * servono, e un test che li chiama direttamente deve fare lo stesso.
 */
const active = () => run('toggle_wg_load; wg_active || true').stdout.trim();
/** L'evento del kernel, gia' tradotto: e' quello che riceve `toggle_run`. */
const flip = (position: string) => run(`toggle_run ${position}`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'travel-toggle-wg-'));
  for (const dir of ['etc/config', 'var/lock', 'var/run', 'usr/share/travel', 'sys/class/net', 'bin']) {
    mkdirSync(file(dir), { recursive: true });
  }
  writeFileSync(file('uci.db'), '');
  // `wg_installed` guarda questi due: senza, non si accende niente.
  writeFileSync(file('bin/wg'), '#!/bin/sh\n', { mode: 0o755 });
  // Fuori da `usr/share/travel/`: quella cartella viene riscritta anche lei, e
  // un percorso sostituito due volte non esiste.
  writeFileSync(file('lib-wireguard.sh'), '');
  // L'instradamento non si prova qui: lo fa `vpn-setup.sh`, e questo test
  // guarda chi decide che il tunnel sia su, non come ci passa il traffico.
  writeFileSync(file('usr/share/travel/vpn-setup.sh'), '#!/bin/sh\n:\n');

  const base = shellPath(root);
  const paths = (text: string) =>
    text
      .replaceAll('/usr/bin/wg', `${base}/bin/wg`)
      .replaceAll('/lib/netifd/proto/wireguard.sh', `${base}/lib-wireguard.sh`)
      .replaceAll('/sys/class/net/', `${base}/sys/class/net/`)
      .replaceAll('/etc/config/', `${base}/etc/config/`)
      .replaceAll('/var/lock/', `${base}/var/lock/`)
      .replaceAll('/var/run/', `${base}/var/run/`)
      .replaceAll('/usr/share/travel/', `${base}/usr/share/travel/`);
  // I due si cercano a vicenda per nome: `toggle.sh` sta in cima alla
  // directory temporanea, quindi il riferimento che `wg.sh` gli fa va portato li'.
  writeFileSync(
    file('usr/share/travel/wg.sh'),
    paths(sources.wg).replaceAll(`${base}/usr/share/travel/toggle.sh`, `${base}/toggle.sh`),
  );
  writeFileSync(file('toggle.sh'), paths(sources.toggle));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('la levetta e le configurazioni WireGuard', () => {
  it('offers one entry per saved configuration, and nothing generic', () => {
    profile('travel_wg1', 'Casa', '1');
    profile('travel_wg2', 'Ufficio', '1');
    const result = run('toggle_actions');
    expect(result.status, result.stderr).toBe(0);
    // Non esiste un "accendi WireGuard": ne porta il traffico una alla volta,
    // quindi si sceglie quale.
    expect(result.stdout.trim().split(/\s+/)).toEqual([
      'none', 'led', 'ap24', 'ap5', 'wg:travel_wg1', 'wg:travel_wg2',
    ]);
  });

  it('refuses to be associated with a configuration that does not exist', () => {
    profile('travel_wg1', 'Casa', '1');
    const result = run('toggle_set wg:travel_wg9');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid action');
    expect(existsSync(file('etc/config/travel_toggle'))).toBe(false);
  });

  it('turns the chosen configuration on as soon as it is chosen, without waiting for the switch to move', () => {
    profile('travel_wg1', 'Casa', '1');
    // La levetta e' in alto da prima e nessuno la muovera' adesso: e' il caso
    // in cui il tunnel resterebbe spento a smentirla.
    expect(flip('on').status).toBe(0);
    const result = run('toggle_set wg:travel_wg1');
    expect(result.status, result.stderr).toBe(0);
    expect(active()).toBe('travel_wg1');
    expect(read('etc/config/travel_toggle')).toContain("option action 'wg:travel_wg1'");
  });

  it('follows the switch afterwards, off and on again', () => {
    profile('travel_wg1', 'Casa', '1');
    expect(run('toggle_set wg:travel_wg1').status).toBe(0);
    const up = flip('on');
    expect(up.status, up.stderr).toBe(0);
    expect(active()).toBe('travel_wg1');
    expect(flip('off').status).toBe(0);
    expect(active()).toBe('');
    expect(flip('on').status).toBe(0);
    expect(active()).toBe('travel_wg1');
  });

  // Il vincolo di sempre - una sola alla volta - vale anche quando ad accendere
  // e' una levetta, e lo fa rispettare `wg_switch`: qui non c'e' una seconda
  // copia della logica da tenere allineata.
  it('turns off whatever else was on, in one go', () => {
    profile('travel_wg1', 'Casa', '1');
    profile('travel_wg2', 'Ufficio', '0');
    expect(active()).toBe('travel_wg2');
    expect(flip('on').status).toBe(0);
    const result = run('toggle_set wg:travel_wg1');
    expect(result.status, result.stderr).toBe(0);
    expect(active()).toBe('travel_wg1');
    expect(existsSync(file('sys/class/net/travel_wg2'))).toBe(false);
  });

  // Un blocco che puo' lasciare un tunnel senza interruttore non e' un blocco.
  it('leaves nothing running when the switch is down at the moment it takes command', () => {
    profile('travel_wg1', 'Casa', '1');
    profile('travel_wg2', 'Ufficio', '0');
    expect(flip('off').status).toBe(0);
    expect(run('toggle_set wg:travel_wg1').status).toBe(0);
    expect(active()).toBe('');
  });

  it('takes activation away from the interface, and gives it back when the association ends', () => {
    profile('travel_wg1', 'Casa', '1');
    profile('travel_wg2', 'Ufficio', '1');
    expect(run('toggle_set wg:travel_wg1').status).toBe(0);
    expect(run('toggle_wg_load; wg_toggle_owner').stdout.trim()).toBe('travel_wg1');

    // Ne' quella comandata ne' le altre: accenderne un'altra spegnerebbe
    // questa, e la levetta resterebbe dov'e' a dire il contrario.
    for (const section of ['travel_wg1', 'travel_wg2']) {
      const result = run(`toggle_wg_load; wg_switch ${section} on ui`);
      expect(result.status, section).toBe(1);
      expect(result.stderr).toContain('physical switch');
    }
    expect(active()).toBe('');

    // Tolta l'associazione il comando torna all'interfaccia, e lo stato del
    // tunnel non viene toccato: si restituisce il comando, non si cambia niente.
    expect(run('toggle_set none').status).toBe(0);
    expect(run('toggle_wg_load; wg_toggle_owner').status).toBe(1);
    expect(run('toggle_wg_load; wg_switch travel_wg2 on ui').status).toBe(0);
    expect(active()).toBe('travel_wg2');
  });

  // L'interfaccia invece continua a non scambiare da sola: due passi espliciti
  // valgono l'istante in cui il traffico uscirebbe in chiaro.
  it('still refuses to swap when the request comes from the interface', () => {
    profile('travel_wg1', 'Casa', '0');
    profile('travel_wg2', 'Ufficio', '1');
    const result = run('toggle_wg_load; wg_switch travel_wg2 on ui');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('deactivate it before');
    expect(active()).toBe('travel_wg1');
  });

  it('does not save an association it could not apply', () => {
    profile('travel_wg1', 'Casa', '1');
    // Qualcos'altro sta gia' decidendo da dove esce il traffico.
    writeFileSync(file('uci.db'), 'mwan3.travel_default.use_policy=travel_balance\n', { flag: 'a' });
    expect(flip('on').status).toBe(0);
    const result = run('toggle_set wg:travel_wg1');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('load balancing');
    expect(active()).toBe('');
    expect(existsSync(file('etc/config/travel_toggle'))).toBe(false);
  });

  // Un profilo eliminato lascia una scelta che indica il vuoto: e' un
  // puntatore vecchio, non una configurazione rotta, e vale "non fare nulla".
  it('degrades to doing nothing when the associated configuration is gone', () => {
    profile('travel_wg1', 'Casa', '1');
    expect(run('toggle_set wg:travel_wg1').status).toBe(0);
    writeFileSync(file('uci.db'), 'travel_toggle.main.action=wg:travel_wg1\n');
    const result = run('toggle_get && echo "$TOGGLE_ACTION"');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('none');
    // E l'interfaccia torna a comandare: una levetta associata al vuoto non
    // deve lasciare i pulsanti spenti per sempre.
    expect(run('toggle_wg_load; wg_toggle_owner').status).toBe(1);
  });

  it('always gives the turn back, even when the tunnel cannot come up', () => {
    profile('travel_wg1', 'Casa', '1');
    rmSync(file('bin/wg'));
    expect(flip('on').status).toBe(0);
    expect(run('toggle_set wg:travel_wg1').status).toBe(1);
    expect(existsSync(file('var/lock/travel-toggle'))).toBe(false);
  });

  // Il caso che rende la corsa reale: alzare un tunnel tiene il turno per una
  // quindicina di secondi, cioe' piu' dei cinque che un evento aspetta in coda.
  // Chi si sposta in quel mezzo registra la posizione e rinuncia; senza il giro
  // in piu' di `toggle_align`, quel movimento sarebbe perso e resterebbe un
  // tunnel acceso su una levetta che dice "no".
  it('catches a switch movement that happened while the tunnel was coming up', () => {
    profile('travel_wg1', 'Casa', '1');
    expect(run('toggle_set wg:travel_wg1').status).toBe(0);
    // La levetta va su, e si sposta di nuovo mentre l'accensione e' in corso.
    const moved = [
      'toggle_do_wg() {',
      '\tprintf "%s " "$2" >> "$UCI_DB.visto"',
      '\t[ -f "$UCI_DB.mosso" ] || {',
      '\t\t: > "$UCI_DB.mosso"',
      '\t\tprintf "off\n" > "$TOGGLE_POSITION_FILE"',
      '\t}',
      '\twg_switch "$1" "$2" toggle',
      '}',
    ].join('\n');
    const result = run(`${moved}\ntoggle_run on`);
    expect(result.status, result.stderr).toBe(0);
    // Prima "on", poi "off": la posizione nuova viene ripresa prima di mollare
    // il turno, e il tunnel finisce dove sta davvero la levetta.
    expect(read('uci.db.visto')).toBe('on off');
    expect(active()).toBe('');
  });

  it('stops chasing a switch that never settles, leaving its position for later', () => {
    profile('travel_wg1', 'Casa', '1');
    expect(run('toggle_set wg:travel_wg1').status).toBe(0);
    // Una levetta che si muove a ogni giro: si rincorre qualche volta e poi si
    // lascia perdere, invece di restare nel ciclo per sempre.
    const restless = [
      'toggle_do_wg() {',
      '\tprintf "%s " "$2" >> "$UCI_DB.visto"',
      '\tcase "$2" in',
      '\t\ton) printf "off\n" > "$TOGGLE_POSITION_FILE" ;;',
      '\t\t*)  printf "on\n" > "$TOGGLE_POSITION_FILE" ;;',
      '\tesac',
      '\twg_switch "$1" "$2" toggle',
      '}',
    ].join('\n');
    const result = run(`${restless}\ntoggle_run on`);
    // 2, non 1: qualcosa e' stato applicato. La differenza serve a chi disfa.
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('keeps moving');
    expect(read('uci.db.visto').split(' ').filter(Boolean)).toHaveLength(3);
    // Il turno torna comunque libero, e l'ultima posizione resta scritta per
    // il prossimo evento.
    expect(existsSync(file('var/lock/travel-toggle'))).toBe(false);
    expect(read('var/run/travel-toggle.position')).toBe('off');
  });

  // Rinunciare al turno non e' un fallimento: chi ce l'ha riguarda la posizione
  // prima di mollarlo, quindi il movimento non va perso.
  it('does not report a failure when the turn is busy', () => {
    profile('travel_wg1', 'Casa', '1');
    mkdirSync(file('var/lock/travel-toggle'));
    const result = run('TOGGLE_LOCK_WAIT=0; toggle_run on');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('whoever holds the turn will apply it');
    expect(read('var/run/travel-toggle.position')).toBe('on');
  });

  // Il ritorno indietro di `toggle_set` esiste per non lasciare scritta una
  // funzione che non ha avuto effetto. Quando invece l'effetto c'e' stato, e a
  // finire male e' la rincorsa, disfare la scelta sarebbe il contrario di cio'
  // che serve: lascerebbe il tunnel dove l'ultimo tentativo riuscito lo ha
  // messo, e nessuno a comandarlo.
  it('keeps an association that worked, even when the switch would not settle', () => {
    profile('travel_wg1', 'Casa', '1');
    const restless = [
      'toggle_do_wg() {',
      '\tcase "$2" in',
      '\t\ton) printf "off\n" > "$TOGGLE_POSITION_FILE" ;;',
      '\t\t*)  printf "on\n" > "$TOGGLE_POSITION_FILE" ;;',
      '\tesac',
      '\twg_switch "$1" "$2" toggle',
      '}',
    ].join('\n');
    expect(flip('on').status).toBe(0);
    const result = run(`${restless}\ntoggle_set wg:travel_wg1`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Function saved');
    // La scelta resta: e' l'unica cosa che potra' riallineare il tunnel al
    // prossimo spostamento della levetta.
    expect(read('etc/config/travel_toggle')).toContain("option action 'wg:travel_wg1'");
    expect(run('toggle_wg_load; wg_toggle_owner').stdout.trim()).toBe('travel_wg1');
  });

  it('keeps an association whose first alignment worked and whose second one failed', () => {
    profile('travel_wg1', 'Casa', '1');
    // Il primo giro accende davvero; poi la levetta si sposta e il secondo giro
    // non riesce. Lo stato non e' quello voluto, ma la scelta si': disfarla
    // toglierebbe l'unica cosa che sa rimetterlo a posto.
    const thenBroken = [
      'toggle_do_wg() {',
      '\t[ -f "$UCI_DB.fatto" ] && return 1',
      '\t: > "$UCI_DB.fatto"',
      '\tprintf "off\n" > "$TOGGLE_POSITION_FILE"',
      '\twg_switch "$1" "$2" toggle',
      '}',
    ].join('\n');
    expect(flip('on').status).toBe(0);
    const result = run(`${thenBroken}\ntoggle_set wg:travel_wg1`);
    expect(result.status, result.stderr).toBe(0);
    expect(read('etc/config/travel_toggle')).toContain("option action 'wg:travel_wg1'");
    expect(active()).toBe('travel_wg1');
  });

  // E il contratto di prima resta intero: se il primo tentativo fallisce non e'
  // stato toccato niente, e la scelta si disfa per intero.
  it('still undoes an association whose very first alignment did nothing', () => {
    profile('travel_wg1', 'Casa', '1');
    rmSync(file('bin/wg'));
    expect(flip('on').status).toBe(0);
    const result = run('toggle_set wg:travel_wg1');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Could not apply');
    expect(existsSync(file('etc/config/travel_toggle'))).toBe(false);
    expect(active()).toBe('');
  });
});
