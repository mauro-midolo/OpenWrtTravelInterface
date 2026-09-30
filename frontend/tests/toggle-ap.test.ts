import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Gli helper veri del router - `toggle.sh` e `ap.sh` - dentro una directory
// temporanea, con `uci` e `ubus` simulati. Come per WireGuard, la cosa che
// conta e' che l'interruttore non scriva `wireless` per conto suo ma passi da
// `ap_switch`, cioe' dallo stesso posto che decide quale sezione vale.
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const pkg = (path: string) => readFileSync(resolve(`../package/travel/files/${path}`), 'utf8');
const sources = {
  toggle: pkg('usr/share/travel/toggle.sh'),
  wg: pkg('usr/share/travel/wg.sh'),
  ap: pkg('usr/share/travel/ap.sh'),
};

let root: string;
const file = (path: string) => join(root, path);
const read = (path: string) => readFileSync(file(path), 'utf8').trim();
const shellPath = (path: string) =>
  path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);

/**
 * `uci` finto con un archivio piatto `chiave=valore`, e `ubus` che segna cosa
 * gli e' stato chiesto.
 *
 * Le chiamate finiscono in un file apposta: "l'access point non e' stato
 * toccato" e "e' stato riscritto uguale" si distinguono solo da li', e la
 * differenza conta - un `network reload` inutile fa cadere chi e' collegato.
 */
const stubs = (base: string) => [
  `UCI_DB='${base}/uci.db'`,
  `UBUS_LOG='${base}/ubus.log'`,
  'uci() {',
  '\t[ "$1" = "-q" ] && shift',
  '\tcase "$1" in',
  // La scelta della levetta non sta in `uci.db`: `toggle_write` la scrive in un
  // file uci dedicato, ed e' da li' che il router la rilegge.
  '\t\tget)',
  '\t\t\tif [ "$2" = travel_toggle.main.action ]; then',
  `\t\t\t\t_v=$(sed -n "s/.*option action '\\(.*\\)'.*/\\1/p" '${base}/etc/config/travel_toggle' 2>/dev/null)`,
  '\t\t\t\t[ -n "$_v" ] || return 1',
  "\t\t\t\tprintf '%s\\n' \"$_v\"",
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
  "\t\tcommit) printf 'commit %s\\n' \"$2\" >> \"$UBUS_LOG\" ;;",
  '\t\tadd_list|del_list) : ;;',
  '\tesac',
  '}',
  'ubus() { printf \'%s %s\\n\' "$2" "$3" >> "$UBUS_LOG"; }',
  'logger() { :; }',
].join('\n');

function run(command: string) {
  const script = `${stubs(shellPath(root))}\n. '${shellPath(file('toggle.sh'))}'\n${command}`;
  const result = spawnSync(shell, ['-c', script], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

/**
 * Come lo chiamerebbe il plugin rpcd: `ap.sh` caricato per conto suo.
 *
 * Il plugin lo sorge in cima e non passa da `toggle.sh`, quindi e' cosi' che
 * va provato chi risponde alla domanda "chi comanda questo access point".
 */
const inAp = (command: string) =>
  run(`. '${shellPath(file('usr/share/travel/ap.sh'))}'; ${command}`);

/** Una radio con il suo access point, come li lascia `tools/setup-ap.sh`. */
function radio(name: string, band: '2g' | '5g', disabled: '0' | '1') {
  writeFileSync(
    file('uci.db'),
    `wireless.${name}=wifi-device\n` +
      `wireless.${name}.band=${band}\n` +
      `wireless.ap_${name}=wifi-iface\n` +
      `wireless.ap_${name}.device=${name}\n` +
      `wireless.ap_${name}.mode=ap\n` +
      `wireless.ap_${name}.ssid=ciao\n` +
      `wireless.ap_${name}.encryption=sae-mixed\n` +
      `wireless.ap_${name}.disabled=${disabled}\n`,
    { flag: 'a' },
  );
}

/**
 * La `wifi-iface` di default di OpenWrt: spenta, e soprattutto **aperta**.
 *
 * `tools/setup-ap.sh` le spegne apposta, avvertendo che abilitare la radio
 * senza toccarle accende una rete "OpenWrt" senza password. Restano pero' in
 * `wireless`, ed e' proprio con la nostra spenta - cioe' ogni volta che la
 * levetta e' in basso - che potevano prendere il suo posto.
 */
function defaultIface(radio: string) {
  writeFileSync(
    file('uci.db'),
    `wireless.default_${radio}=wifi-iface\n` +
      `wireless.default_${radio}.device=${radio}\n` +
      `wireless.default_${radio}.mode=ap\n` +
      `wireless.default_${radio}.ssid=OpenWrt\n` +
      `wireless.default_${radio}.disabled=1\n`,
    { flag: 'a' },
  );
}

/** Una radio senza nessun access point sopra. */
function bareRadio(name: string, band: '2g' | '5g') {
  writeFileSync(file('uci.db'), `wireless.${name}=wifi-device\nwireless.${name}.band=${band}\n`, {
    flag: 'a',
  });
}

/** `disabled` della sezione, come lo leggerebbe il plugin. `-` se non c'e'. */
const disabled = (section: string) =>
  run(`uci -q get wireless.${section}.disabled || printf -`).stdout.trim();

/** Che cosa e' stato chiesto a `ubus` e a `uci commit`. */
const traffic = () => (existsSync(file('ubus.log')) ? read('ubus.log') : '');
const forget = () => writeFileSync(file('ubus.log'), '');

/** L'evento del kernel, gia' tradotto: e' quello che riceve `toggle_run`. */
const flip = (position: string) => run(`toggle_run ${position}`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'travel-toggle-ap-'));
  for (const dir of ['etc/config', 'var/lock', 'var/run', 'usr/share/travel']) {
    mkdirSync(file(dir), { recursive: true });
  }
  writeFileSync(file('uci.db'), '');
  writeFileSync(file('ubus.log'), '');

  const base = shellPath(root);
  const paths = (text: string) =>
    text
      .replaceAll('/etc/config/', `${base}/etc/config/`)
      .replaceAll('/var/lock/', `${base}/var/lock/`)
      .replaceAll('/var/run/', `${base}/var/run/`)
      .replaceAll('/usr/share/travel/', `${base}/usr/share/travel/`);
  // I file si cercano a vicenda per nome: `toggle.sh` sta in cima alla
  // directory temporanea, quindi i riferimenti che gli fanno vanno portati li'.
  const toToggle = (text: string) =>
    text.replaceAll(`${base}/usr/share/travel/toggle.sh`, `${base}/toggle.sh`);
  writeFileSync(file('usr/share/travel/ap.sh'), toToggle(paths(sources.ap)));
  writeFileSync(file('usr/share/travel/wg.sh'), toToggle(paths(sources.wg)));
  writeFileSync(file('toggle.sh'), paths(sources.toggle));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('la levetta e gli access point WiFi', () => {
  it('offers one entry per band, alongside the other fixed actions', () => {
    const result = run('toggle_actions');
    expect(result.status, result.stderr).toBe(0);
    // Le bande sono due, sono sempre quelle, e non le crea chi usa il router:
    // stanno nel registro delle azioni fisse, non fra quelle nominate.
    expect(result.stdout.trim().split(/\s+/)).toEqual(['none', 'led', 'ap24', 'ap5']);
  });

  it('turns the chosen access point on as soon as it is chosen, without waiting for the switch to move', () => {
    radio('radio0', '2g', '1');
    radio('radio1', '5g', '1');
    // La levetta e' in alto da prima e nessuno la muovera' adesso: e' il caso
    // in cui l'access point resterebbe spento a smentirla.
    expect(flip('on').status).toBe(0);

    const result = run('toggle_set ap24');
    expect(result.status, result.stderr).toBe(0);
    expect(disabled('ap_radio0')).toBe('0');
    expect(read('etc/config/travel_toggle')).toContain("option action 'ap24'");
  });

  it('follows the switch afterwards, off and on again', () => {
    radio('radio0', '2g', '0');
    expect(run('toggle_set ap24').status).toBe(0);

    expect(flip('off').status).toBe(0);
    expect(disabled('ap_radio0')).toBe('1');
    expect(flip('on').status).toBe(0);
    expect(disabled('ap_radio0')).toBe('0');
  });

  // Le due bande sono due opzioni indipendenti: associarne una non deve
  // toccare l'altra, che sulla scheda della radio resta premibile e - se si e'
  // collegati da li' - e' l'unico modo di rientrare nel router.
  it('leaves the other band exactly where it was', () => {
    radio('radio0', '2g', '1');
    radio('radio1', '5g', '0');
    expect(run('toggle_set ap5').status).toBe(0);

    expect(flip('off').status).toBe(0);
    expect(disabled('ap_radio1')).toBe('1');
    expect(disabled('ap_radio0')).toBe('1');
    expect(flip('on').status).toBe(0);
    expect(disabled('ap_radio1')).toBe('0');
    // Mai accesa da nessuno: la levetta comanda una banda sola.
    expect(disabled('ap_radio0')).toBe('1');
  });

  // Fra piu' access point sulla stessa radio vince quello acceso: le sezioni
  // di default di OpenWrt restano li', spente, e non devono rubare il posto
  // alla nostra. E' la stessa regola che legge l'interfaccia, e sta scritta in
  // un punto solo apposta perche' le due non possano scegliere sezioni diverse.
  it('acts on the same section the interface shows', () => {
    radio('radio0', '2g', '0');
    defaultIface('radio0');
    expect(inAp('ap_section_of_radio radio0').stdout.trim()).toBe('ap_radio0');

    expect(run('toggle_set ap24').status).toBe(0);
    expect(flip('off').status).toBe(0);
    expect(disabled('ap_radio0')).toBe('1');
    expect(disabled('default_radio0')).toBe('1');
  });

  // Il caso che "vince quello acceso" da solo non copriva: con la nostra
  // spenta dalla levetta, sulla radio non c'e' piu' niente di acceso, e la
  // sezione di default di OpenWrt - aperta, senza password - poteva prendere
  // il suo posto nell'ordine di `uci show`. Riaccendere avrebbe alzato quella.
  it('comes back to our own access point, never to the open default', () => {
    // Prima la sezione di default, cosi' e' lei la prima che si incontra: e'
    // esattamente l'ordine in cui la vecchia regola sbagliava.
    defaultIface('radio0');
    radio('radio0', '2g', '0');
    expect(run('toggle_set ap24').status).toBe(0);

    expect(flip('off').status).toBe(0);
    expect(disabled('ap_radio0')).toBe('1');
    // Tutto spento: e' qui che si sceglie a chi tornare.
    expect(inAp('ap_section_of_radio radio0').stdout.trim()).toBe('ap_radio0');

    expect(flip('on').status).toBe(0);
    expect(disabled('ap_radio0')).toBe('0');
    expect(disabled('default_radio0')).toBe('1');
  });

  // La convenzione sul nome non puo' essere l'unica cosa che separa un
  // movimento della levetta dall'esporre la LAN: il divieto e' sul fatto.
  it('refuses to switch on an access point that has no password', () => {
    defaultIface('radio0');
    writeFileSync(file('uci.db'), 'wireless.radio0=wifi-device\nwireless.radio0.band=2g\n', {
      flag: 'a',
    });

    const result = inAp('ap_switch 2.4 on');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('has no password');
    expect(disabled('default_radio0')).toBe('1');

    // Spegnere invece resta lecito: il verso pericoloso e' uno solo.
    writeFileSync(file('uci.db'), 'wireless.default_radio0.disabled=0\n', { flag: 'a' });
    expect(inAp('ap_switch 2.4 off').status).toBe(0);
    expect(disabled('default_radio0')).toBe('1');
  });

  // Riscrivere uno stato gia' giusto vorrebbe dire un `network reload` a ogni
  // avvio, cioe' far cadere chi e' collegato per confermargli che va tutto
  // bene.
  it('does not reconfigure the radios when the access point is already where it should be', () => {
    radio('radio0', '2g', '0');
    expect(flip('on').status).toBe(0);
    expect(run('toggle_set ap24').status).toBe(0);
    forget();

    expect(run('toggle_apply').status).toBe(0);
    expect(traffic()).toBe('');
  });

  it('applies through ap_switch, which is what commits and reloads', () => {
    radio('radio0', '2g', '0');
    expect(run('toggle_set ap24').status).toBe(0);
    forget();

    expect(flip('off').status).toBe(0);
    expect(traffic()).toContain('commit wireless');
    expect(traffic()).toContain('network reload');
  });

  // Una banda senza access point non e' qualcosa da associare: la scelta non
  // resta scritta, come per una configurazione WireGuard che non esiste.
  it('refuses a band that has no access point configured', () => {
    radio('radio0', '2g', '0');
    bareRadio('radio1', '5g');
    expect(flip('on').status).toBe(0);

    const result = run('toggle_set ap5');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no access point configured');
    expect(existsSync(file('etc/config/travel_toggle'))).toBe(false);
  });

  it('tells the interface which band it commands, and nothing before it commands one', () => {
    radio('radio0', '2g', '0');
    expect(inAp('ap_toggle_band').status).not.toBe(0);

    expect(run('toggle_set ap24').status).toBe(0);
    const owned = inAp('ap_toggle_band');
    expect(owned.status, owned.stderr).toBe(0);
    expect(owned.stdout.trim()).toBe('2.4');
  });

  // Lo stesso caso del profilo WireGuard eliminato: una levetta associata a
  // qualcosa che non esiste piu' non comanda niente, e l'interfaccia deve
  // tornare a decidere invece di restare bloccata da un padrone fantasma.
  it('commands nothing once the access point on that band is gone', () => {
    radio('radio0', '2g', '0');
    expect(run('toggle_set ap24').status).toBe(0);
    writeFileSync(file('uci.db'), '');

    const orphan = inAp('ap_toggle_band');
    expect(orphan.status).not.toBe(0);
    expect(orphan.stdout.trim()).toBe('');
  });
});
