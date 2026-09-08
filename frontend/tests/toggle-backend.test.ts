import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Come per il LED: gli helper veri, con sysfs, /var e la configurazione dentro
// una directory temporanea. Qui gira anche led.sh, perche' il punto e'
// verificare che l'interruttore passi da li' invece di scrivere per conto suo.
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const pkg = (path: string) => readFileSync(resolve(`../package/travel/files/${path}`), 'utf8');
const sources = {
  toggle: pkg('usr/share/travel/toggle.sh'),
  button: pkg('usr/share/travel/toggle-button.sh'),
  led: pkg('usr/share/travel/led.sh'),
};
let root: string;
const file = (path: string) => join(root, path);
const read = (path: string) => readFileSync(file(path), 'utf8').trim();
const write = (path: string, text: string) => writeFileSync(file(path), text);
const shellPath = (path: string) => path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);

// Un solo `uci` finto per le due configurazioni: e' quello che rende visibile
// dove ognuna delle due scrive.
const stubs = (base: string) => [
  'uci() {',
  '\tcase "$3" in',
  `\t\ttravel_led.main.enabled) sed -n "s/.*option enabled '\\\\(.*\\\\)'.*/\\\\1/p" '${base}/etc/config/travel_led' 2>/dev/null ;;`,
  `\t\ttravel_toggle.main.action) sed -n "s/.*option action '\\\\(.*\\\\)'.*/\\\\1/p" '${base}/etc/config/travel_toggle' 2>/dev/null ;;`,
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

/** L'evento del kernel, come arriva allo script di rilevamento. */
function press(action: string) {
  const result = run(`export ACTION=${action} BUTTON=BTN_0; . '${shellPath(file('toggle-button.sh'))}'`);
  sysfs();
  return result;
}

/**
 * Un file `trigger` non restituisce quello che ci si e' scritto: restituisce
 * l'elenco dei trigger con l'attivo fra parentesi. Senza rimetterlo in quella
 * forma, il comando successivo leggerebbe un file che sul router non esiste
 * cosi', e le due scritture di fila non si potrebbero provare.
 */
function sysfs() {
  for (const name of ['blue-status', 'white-status']) {
    const current = read(`sys/class/leds/${name}/trigger`);
    if (!current.includes('[')) write(`sys/class/leds/${name}/trigger`, `[${current}] timer\n`);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'travel-toggle-test-'));
  for (const name of ['blue-status', 'white-status']) {
    mkdirSync(file(`sys/class/leds/${name}`), { recursive: true });
    write(`sys/class/leds/${name}/brightness`, '1\n');
    write(`sys/class/leds/${name}/trigger`, 'none [timer]\n');
    write(`sys/class/leds/${name}/max_brightness`, '255\n');
  }
  for (const dir of ['etc/config', 'var/lock', 'var/run', 'usr/share/travel']) {
    mkdirSync(file(dir), { recursive: true });
  }
  const base = shellPath(root);
  const paths = (text: string) => text
    .replaceAll('/sys/class/leds/', `${base}/sys/class/leds/`)
    .replaceAll('/etc/config/', `${base}/etc/config/`)
    .replaceAll('/var/lock/', `${base}/var/lock/`)
    .replaceAll('/var/run/', `${base}/var/run/`)
    .replaceAll('/usr/share/travel/', `${base}/usr/share/travel/`);
  write('usr/share/travel/led.sh', paths(sources.led).replace(
    '. /lib/functions/leds.sh',
    'get_dt_led() { case "$1" in boot) echo white-status ;; *) echo blue-status ;; esac; }',
  ));
  write('toggle.sh', paths(sources.toggle));
  write('toggle-button.sh', paths(sources.button)
    .replace(`${base}/usr/share/travel/toggle.sh`, `${base}/toggle.sh`));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('router physical toggle', () => {
  it('does nothing until a function is chosen', () => {
    const result = run('toggle_get && echo "$TOGGLE_ACTION" && toggle_run on');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('none');
    // Il LED resta dov'era: nessuna funzione associata, nessuna scrittura.
    expect(read('sys/class/leds/blue-status/brightness')).toBe('1');
    expect(read('sys/class/leds/blue-status/trigger')).toBe('none [timer]');
    expect(existsSync(file('etc/config/travel_led'))).toBe(false);
  });

  it('saves the chosen function and keeps it after a reboot', () => {
    expect(run('toggle_set led').status).toBe(0);
    expect(read('etc/config/travel_toggle')).toContain("option action 'led'");
    // Processo nuovo, niente in memoria: la scelta arriva solo dal file.
    expect(run('toggle_get && echo "$TOGGLE_ACTION"').stdout.trim()).toBe('led');
  });

  it('refuses functions that are not in the registry, leaving the saved one alone', () => {
    expect(run('toggle_set led').status).toBe(0);
    const result = run('toggle_set apri-il-garage');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Azione non valida');
    expect(read('etc/config/travel_toggle')).toContain("option action 'led'");
  });

  it('drives the LED through led.sh, saving the state as the interface would', () => {
    expect(run('toggle_set led').status).toBe(0);
    expect(run('toggle_run on').status, 'accensione').toBe(0);
    expect(read('sys/class/leds/blue-status/brightness')).toBe('255');
    expect(read('sys/class/leds/blue-status/trigger')).toBe('none');
    expect(read('etc/config/travel_led')).toContain("option enabled '1'");
    sysfs();
    const off = run('toggle_run off');
    expect(off.status, `spegnimento: ${off.stderr}`).toBe(0);
    expect(read('sys/class/leds/blue-status/brightness')).toBe('0');
    expect(read('sys/class/leds/white-status/brightness')).toBe('0');
    expect(read('etc/config/travel_led')).toContain("option enabled '0'");
  });

  it('lines the LED up with the switch as soon as the function is chosen', () => {
    // La levetta e' in alto da prima, e nessuno la muovera' adesso: e' il caso
    // in cui il LED resterebbe spento a smentirla.
    expect(run('toggle_run on').status).toBe(0);
    sysfs();
    expect(run('toggle_set none').status).toBe(0);
    write('sys/class/leds/blue-status/brightness', '0\n');
    const result = run('toggle_set led');
    expect(result.status, result.stderr).toBe(0);
    expect(read('sys/class/leds/blue-status/brightness')).toBe('255');
    expect(read('etc/config/travel_toggle')).toContain("option action 'led'");
  });

  it('does not save a function it could not apply', () => {
    expect(run('toggle_run on').status).toBe(0);
    sysfs();
    // Nessun LED su questo router: la funzione scelta non avrebbe effetto.
    rmSync(file('sys/class/leds/blue-status'), { recursive: true });
    const result = run('toggle_set led');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Impossibile applicare');
    expect(existsSync(file('etc/config/travel_toggle'))).toBe(false);
  });

  it('leaves the LED alone when the choice cannot be saved', () => {
    // Situazione di partenza: levetta in alto, una funzione gia' scelta, e un
    // LED spento con la sua preferenza salvata.
    expect(run('toggle_run on').status).toBe(0);
    sysfs();
    expect(run('toggle_set none').status).toBe(0);
    // led.sh lo carica l'azione, non toggle.sh: qui serve a mano.
    const off = run(`. '${shellPath(file('usr/share/travel/led.sh'))}'; led_set 0`);
    expect(off.status, `LED spento di partenza: ${off.stderr}`).toBe(0);
    sysfs();
    const before = {
      toggle: read('etc/config/travel_toggle'),
      led: read('etc/config/travel_led'),
      brightness: read('sys/class/leds/blue-status/brightness'),
    };
    // Solo il salvataggio della scelta fallisce: quello del LED resta buono,
    // ed e' il punto - un LED acceso qui vorrebbe dire che l'allineamento e'
    // avvenuto per una funzione che non e' stata registrata.
    const stubborn = `mktemp() { case "$1" in */.travel-toggle.*) return 1 ;; *) command mktemp "$@" ;; esac; }`;
    const result = run(`${stubborn}\ntoggle_set led`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Impossibile salvare la scelta');
    expect(read('etc/config/travel_toggle'), 'la scelta di prima').toBe(before.toggle);
    expect(read('etc/config/travel_led'), 'la preferenza del LED').toBe(before.led);
    expect(read('sys/class/leds/blue-status/brightness')).toBe(before.brightness);
  });

  it('keeps a switch event out of a choice that is still being made', () => {
    // Situazione di partenza: levetta in alto, funzione `none`, LED acceso con
    // la sua preferenza salvata.
    expect(run('toggle_run on').status).toBe(0);
    sysfs();
    expect(run('toggle_set none').status).toBe(0);
    const lit = run(`. '${shellPath(file('usr/share/travel/led.sh'))}'; led_set 1`);
    expect(lit.status, `LED acceso di partenza: ${lit.stderr}`).toBe(0);
    sysfs();
    const before = {
      toggle: read('etc/config/travel_toggle'),
      led: read('etc/config/travel_led'),
      brightness: read('sys/class/leds/blue-status/brightness'),
    };
    // L'evento della levetta arriva nell'istante peggiore: la scelta `led` e'
    // gia' salvata, l'allineamento sta ancora girando e finira' male. Senza un
    // turno solo, quell'evento agirebbe sulla funzione appena scritta e
    // spegnerebbe il LED salvandolo, e il ritorno indietro rimetterebbe a
    // posto la scelta lasciando il LED dove l'evento l'ha messo.
    const intruder = `toggle_align() { ( TOGGLE_LOCK_WAIT=0; toggle_run off ); return 1; }`;
    const result = run(`${intruder}\ntoggle_set led`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Impossibile applicare');
    expect(read('etc/config/travel_toggle'), 'la scelta di prima').toBe(before.toggle);
    expect(read('etc/config/travel_led'), 'la preferenza del LED').toBe(before.led);
    expect(read('sys/class/leds/blue-status/brightness')).toBe(before.brightness);
    // L'evento non e' stato applicato, ma la posizione si', cosi' il prossimo
    // allineamento sa dov'e' finita davvero la levetta.
    expect(read('var/run/travel-toggle.position')).toBe('off');
  });

  it('always gives the turn back', () => {
    const lock = () => existsSync(file('var/lock/travel-toggle'));
    expect(run('toggle_set led').status, 'scelta riuscita').toBe(0);
    expect(lock()).toBe(false);
    expect(run('toggle_set apri-il-garage').status, 'scelta rifiutata').toBe(1);
    expect(lock()).toBe(false);
    expect(run('toggle_run on').status, 'evento').toBe(0);
    expect(lock()).toBe(false);
    sysfs();
    // Anche quando l'allineamento fallisce e si torna indietro.
    rmSync(file('sys/class/leds/blue-status'), { recursive: true });
    expect(run('toggle_set none').status).toBe(0);
    expect(run('toggle_set led').status, 'allineamento fallito').toBe(1);
    expect(lock()).toBe(false);
  });

  it('leaves the LED alone while the switch position is still unknown', () => {
    const result = run('toggle_set led');
    expect(result.status, result.stderr).toBe(0);
    expect(read('sys/class/leds/blue-status/brightness')).toBe('1');
    expect(existsSync(file('etc/config/travel_led'))).toBe(false);
    expect(read('etc/config/travel_toggle')).toContain("option action 'led'");
  });

  it('checks the switch position at boot, after the saved LED preference', () => {
    expect(run('toggle_set led').status).toBe(0);
    expect(run('toggle_run on').status).toBe(0);
    sysfs();
    // Riavvio: la posizione la riporta l'evento del kernel, il LED riparte
    // dalla preferenza salvata, e `apply` rimette d'accordo i due.
    write('sys/class/leds/blue-status/brightness', '0\n');
    write('sys/class/leds/blue-status/trigger', 'none [timer]\n');
    // La stessa riga che esegue l'init: `toggle.sh apply`.
    const result = run(`set -- apply; . '${shellPath(file('toggle.sh'))}'`);
    expect(result.status, result.stderr).toBe(0);
    expect(read('sys/class/leds/blue-status/brightness')).toBe('255');
  });

  it('remembers where the switch is, and admits when it does not know', () => {
    expect(run('toggle_position && echo "$TOGGLE_POSITION"').stdout.trim()).toBe('unknown');
    expect(run('toggle_run on && toggle_position && echo "$TOGGLE_POSITION"').stdout.trim()).toBe('on');
    expect(read('var/run/travel-toggle.position')).toBe('on');
    write('var/run/travel-toggle.position', 'a meta strada\n');
    expect(run('toggle_position && echo "$TOGGLE_POSITION"').stdout.trim()).toBe('unknown');
  });

  it('rejects a position that is neither on nor off', () => {
    const result = run('toggle_run forse');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Posizione non valida');
    expect(existsSync(file('var/run/travel-toggle.position'))).toBe(false);
  });

  it('translates the kernel event without knowing which function will run', () => {
    expect(run('toggle_set led').status).toBe(0);
    for (const [action, brightness] of [['pressed', '255'], ['released', '0']]) {
      const result = press(action);
      expect(result.status, `${action}: ${result.stderr}`).toBe(0);
      expect(read('sys/class/leds/blue-status/brightness')).toBe(brightness);
    }
    // Un evento che non e' uno spostamento della levetta non muove niente.
    write('sys/class/leds/blue-status/brightness', '7\n');
    expect(press('timeout').status).toBe(0);
    expect(read('sys/class/leds/blue-status/brightness')).toBe('7');
  });
});
