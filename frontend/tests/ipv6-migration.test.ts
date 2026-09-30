import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// La migrazione vera, estratta da `setup.sh` vero ed eseguita con `uci`
// simulato. Non una copia del blocco: se qualcuno lo riscrive, questo test
// legge la riscrittura.
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const setup = readFileSync(
  resolve('../package/travel/files/usr/share/travel/setup.sh'),
  'utf8',
);

/** Il blocco `ipv6_init`, dalla sua `if` al primo `fi` in colonna zero. */
function migration(): string {
  const lines = setup.split('\n');
  const start = lines.findIndex(
    (l) => l.startsWith('if ') && l.includes('travel.globals.ipv6_init'),
  );
  if (start < 0) throw new Error('blocco ipv6_init non trovato in setup.sh');
  const end = lines.indexOf('fi', start);
  if (end < 0) throw new Error('fine del blocco ipv6_init non trovata');
  return lines.slice(start, end + 1).join('\n');
}

/**
 * Il ciclo che crea le gemelle `<net>6`.
 *
 * E' l'unico `for net in` in colonna zero: gli altri due cicli sulla zona wan
 * stanno dentro un blocco marcatore e sono quindi rientrati. Se un giorno ne
 * comparisse un secondo, l'estrazione fallisce invece di prendere quello
 * sbagliato in silenzio.
 */
function siblings(): string {
  const lines = setup.split('\n');
  const found = lines.reduce<number[]>(
    (acc, l, i) => (l.startsWith('for net in') ? [...acc, i] : acc),
    [],
  );
  if (found.length !== 1) {
    throw new Error(`atteso un solo ciclo <net>6 in colonna zero, trovati ${found.length}`);
  }
  const end = lines.indexOf('done', found[0]);
  if (end < 0) throw new Error('fine del ciclo delle gemelle non trovata');
  return lines.slice(found[0], end + 1).join('\n');
}

let root: string;
const file = (p: string) => join(root, p);
const shellPath = (p: string) =>
  p.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);

/**
 * `uci` finto su un archivio piatto `chiave=valore`.
 *
 * Le chiavi contengono `@zone[1]`, cioe' parentesi quadre: il confronto si fa
 * con awk per uguaglianza esatta e non con una regex di sed, che le
 * interpreterebbe come una classe di caratteri e non troverebbe niente.
 */
const stubs = (base: string) =>
  [
    `UCI_DB='${base}/uci.db'`,
    `LOG='${base}/log'`,
    'say() { printf \'say %s\\n\' "$*" >> "$LOG"; }',
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
    '\t\tdelete)',
    '\t\t\tawk -F= -v k="$2" \'$1!=k\' "$UCI_DB" > "$UCI_DB.t" && mv "$UCI_DB.t" "$UCI_DB"',
    '\t\t\tprintf \'delete %s\\n\' "$2" >> "$LOG" ;;',
    // Le liste uci qui sono una stringa separata da spazi: e' la forma in cui
    // `uci -q get` le restituisce, ed e' quella su cui il ciclo fa il word
    // splitting.
    '\t\tadd_list)',
    '\t\t\t_k="${2%%=*}"; _val="${2#*=}"',
    '\t\t\t_old=$(awk -F= -v k="$_k" \'$1==k { sub(/^[^=]*=/, ""); v=$0 } END { print v }\' "$UCI_DB")',
    '\t\t\tawk -F= -v k="$_k" \'$1!=k\' "$UCI_DB" > "$UCI_DB.t" && mv "$UCI_DB.t" "$UCI_DB"',
    '\t\t\tprintf \'%s=%s %s\\n\' "$_k" "$_old" "$_val" >> "$UCI_DB" ;;',
    '\t\tcommit) printf \'commit %s\\n\' "$2" >> "$LOG" ;;',
    '\tesac',
    '}',
  ].join('\n');

/** Esegue un pezzo di `setup.sh` e riporta com'e' rimasta la configurazione. */
function run(block: string) {
  const script = [
    // `set -e` come nello script vero (setup.sh:8), e non e' un dettaglio: con
    // esso una lettura fallita di un'opzione assente - `x=$(uci -q get ...)` -
    // ferma tutto il file invece di lasciare la variabile vuota. Senza questa
    // riga il test girava in un mondo piu' clemente di quello reale e non
    // vedeva la differenza.
    'set -e',
    stubs(shellPath(root)),
    "WAN_ZONE='@zone[1]'",
    'NEED_NETWORK_RELOAD=0',
    'NEED_FIREWALL_RELOAD=0',
    'NEED_IPV6_NETWORK_RELOAD=0',
    'NEED_IPV6_FIREWALL_RELOAD=0',
    block,
    // Il ciclo delle gemelle gira dopo il blocco che ricarica rete e firewall,
    // quindi ha contatori suoi: si guardano entrambe le coppie, cosi' un flag
    // scritto in quello sbagliato - che non ricaricherebbe niente - si vede.
    'printf \'reload=%s fw=%s v6reload=%s v6fw=%s\\n\'' +
      ' "$NEED_NETWORK_RELOAD" "$NEED_FIREWALL_RELOAD"' +
      ' "$NEED_IPV6_NETWORK_RELOAD" "$NEED_IPV6_FIREWALL_RELOAD"',
  ].join('\n');

  const result = spawnSync(shell, ['-c', script], { encoding: 'utf8' });
  if (result.error) throw result.error;
  expect(result.status).toBe(0);

  return {
    reload: / reload=1|^reload=1/m.test(result.stdout),
    fwReload: / fw=1/.test(result.stdout),
    v6Reload: /v6reload=1/.test(result.stdout),
    v6FwReload: /v6fw=1/.test(result.stdout),
    db: readFileSync(file('uci.db'), 'utf8'),
    log: existsSync(file('log')) ? readFileSync(file('log'), 'utf8') : '',
  };
}

const migrate = () => run(migration());
const makeSiblings = () => run(siblings());

const WANS = ['wan', 'wwan_radio0', 'wwan_radio1', 'wan_usb'];

/** Configurazione di partenza; `ipv6` la mettono i singoli test. */
function config(lines: string[] = []) {
  writeFileSync(
    file('uci.db'),
    [
      `firewall.@zone[1].network=${WANS.join(' ')}`,
      ...WANS.flatMap((net) => [`network.${net}=interface`, `network.${net}.proto=dhcp`]),
      ...lines,
    ].join('\n') + '\n',
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ipv6-migration-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('migrazione IPv6 sulle WAN', () => {
  it('su un router aggiornato toglie ipv6=0 da tutte le WAN', () => {
    config(WANS.map((net) => `network.${net}.ipv6=0`));
    const { db, reload, log } = migrate();

    for (const net of WANS) {
      expect(db).not.toContain(`network.${net}.ipv6=`);
      expect(log).toContain(`delete network.${net}.ipv6`);
    }
    expect(reload).toBe(true);
  });

  it('cancella l’opzione invece di scrivere 1', () => {
    // Senza opzione vale il default di OpenWrt; scrivere `1` imporrebbe un
    // valore nostro su una scelta che non e' nostra. E' l'intera decisione
    // della fase, quindi va verificata e non solo commentata.
    config(WANS.map((net) => `network.${net}.ipv6=0`));
    const { db } = migrate();

    expect(db).not.toMatch(/\.ipv6=/);
    expect(db).not.toContain('ipv6=1');
  });

  it('su un’installazione nuova non tocca niente ma segna il marcatore', () => {
    // Le WAN appena create l'opzione non ce l'hanno gia': non c'e' niente da
    // cancellare, e soprattutto non si deve chiedere un reload della rete per
    // un lavoro che non e' stato fatto - farebbe cadere chi e' collegato.
    config();
    const { db, reload, log } = migrate();

    expect(reload).toBe(false);
    expect(log).not.toContain('delete');
    expect(db).toContain('travel.globals.ipv6_init=1');
  });

  it('la seconda esecuzione non fa piu’ niente', () => {
    config(WANS.map((net) => `network.${net}.ipv6=0`));
    expect(migrate().reload).toBe(true);

    // Il log si azzera fra i due giri, cosi' il secondo parla solo di se'.
    rmSync(file('log'), { force: true });
    const second = migrate();

    expect(second.reload).toBe(false);
    expect(second.log).not.toContain('delete');
  });

  it('chi rimette ipv6=0 dopo la migrazione se lo tiene', () => {
    // Dopo il marcatore la scelta e' dell'utente: rilanciare setup.sh non deve
    // riportarla indietro. E' la stessa regola delle altre migrazioni.
    config(WANS.map((net) => `network.${net}.ipv6=0`));
    migrate();

    writeFileSync(file('uci.db'), 'network.wan.ipv6=0\n', { flag: 'a' });
    rmSync(file('log'), { force: true });
    const second = migrate();

    expect(second.db).toContain('network.wan.ipv6=0');
    expect(second.log).not.toContain('delete');
    expect(second.reload).toBe(false);
  });

  it('da sola non accende IPv6: e’ il ciclo delle gemelle a farlo', () => {
    // Su OpenWrt 25.12 il proto `dhcp` l'opzione `ipv6` non la legge affatto.
    // Cancellarla e' innocuo ma inerte, e questo test tiene fermo il fatto che
    // la migrazione non basta - e' la lezione che e' costata un'interruzione.
    config(WANS.map((net) => `network.${net}.ipv6=0`));
    const { db } = migrate();

    for (const net of WANS) expect(db).not.toContain(`network.${net}6=`);
  });

  it('salta le reti elencate nella zona ma inesistenti', () => {
    // La zona firewall puo' nominare una rete che non c'e' - un residuo di una
    // porta tolta - e la migrazione non deve inventarsela.
    config([`firewall.@zone[1].network=${WANS.join(' ')} wan_fantasma`, 'network.wan.ipv6=0']);
    const { db, log } = migrate();

    expect(log).toContain('delete network.wan.ipv6');
    expect(log).not.toContain('wan_fantasma');
    expect(db).not.toContain('network.wan_fantasma');
  });
});

describe('gemelle <net>6', () => {
  it('ne crea una per ogni WAN v4, con proto dhcpv6 e device simbolico', () => {
    config();
    const { db, v6Reload } = makeSiblings();

    for (const net of WANS) {
      expect(db).toContain(`network.${net}6=interface`);
      expect(db).toContain(`network.${net}6.proto=dhcpv6`);
      // `@<net>` e non il nome del device: per una STA WiFi il device in uci
      // non c'e' proprio, e cambia a ogni riassociazione.
      expect(db).toContain(`network.${net}6.device=@${net}`);
    }
    expect(v6Reload).toBe(true);
  });

  it('le mette tutte nella zona firewall wan', () => {
    config();
    const { db, v6FwReload } = makeSiblings();

    const zone = db.split('\n').find((l) => l.startsWith('firewall.@zone[1].network=')) ?? '';
    for (const net of WANS) expect(zone.split(' ')).toContain(`${net}6`);
    expect(v6FwReload).toBe(true);
  });

  it('copia la metrica della sorella v4, cosi’ le due famiglie scelgono la stessa WAN', () => {
    config(['network.wan.metric=10', 'network.wwan_radio0.metric=30']);
    const { db } = makeSiblings();

    expect(db).toContain('network.wan6.metric=10');
    expect(db).toContain('network.wwan_radio06.metric=30');
  });

  it('non genera la gemella della gemella', () => {
    // `wan6` e' gia' `proto dhcpv6`: senza il filtro sul proto nascerebbe un
    // `wan66`, e al giro dopo un `wan666`.
    config();
    const first = makeSiblings();
    expect(first.db).not.toContain('network.wan66');

    const second = makeSiblings();
    expect(second.db).not.toContain('network.wan66');
    expect(second.v6Reload).toBe(false);
  });

  it('la seconda esecuzione non tocca niente', () => {
    config();
    makeSiblings();
    rmSync(file('log'), { force: true });

    const second = makeSiblings();
    expect(second.v6Reload).toBe(false);
    expect(second.v6FwReload).toBe(false);
    expect(second.log).toContain("gia' presente");
  });

  it('rispetta una gemella gia’ esistente invece di riscriverla', () => {
    // E' il caso del `wan6` dell'immagine di fabbrica, e anche di chi ci ha
    // messo `disabled 1` per spegnere IPv6 su quella WAN: sopravvive.
    config([
      'network.wan6=interface',
      'network.wan6.proto=dhcpv6',
      'network.wan6.device=eth0',
      'network.wan6.disabled=1',
    ]);
    const { db } = makeSiblings();

    expect(db).toContain('network.wan6.device=eth0');
    expect(db).toContain('network.wan6.disabled=1');
    expect(db).not.toContain('network.wan6.device=@wan');
  });
});

describe('metrica delle gemelle: l’ordine dentro setup.sh', () => {
  it('senza nessuna metrica non interrompe il setup', () => {
    // Lo scenario vero: `mwan3-setup.sh` esce prima di assegnare le metriche
    // quando mwan3 non e' installabile perche' manca Internet - e lo dice pure,
    // promettendo che "tutto il resto funziona". Con `set -e` una assegnazione
    // da un'opzione assente fermerebbe `setup.sh` proprio li', saltando VPN,
    // travelD e il riavvio di rpcd. Il controllo e' l'uscita a zero, che `run`
    // verifica a ogni chiamata.
    config();
    const { db } = makeSiblings();

    // E il lavoro si fa lo stesso: le gemelle nascono, solo senza metrica.
    for (const net of WANS) expect(db).toContain(`network.${net}6=interface`);
  });

  it('senza metrica v4 non ne inventa una', () => {
    // La regressione: le metriche v4 le assegna mwan3-setup.sh, e il ciclo
    // delle gemelle gira DOPO di lui. Se qualcuno lo rispostasse piu' in alto,
    // qui non ci sarebbe nessuna metrica da copiare - e scrivere 0 darebbe a
    // tutte le gemelle la stessa metrica, per giunta la migliore. Siccome le
    // sezioni si creano una volta sola, quel valore non lo correggerebbe piu'
    // nessuno: meglio nessuna metrica che una sbagliata e definitiva.
    config();
    const { db } = makeSiblings();

    for (const net of WANS) {
      expect(db).toContain(`network.${net}6=interface`);
      expect(db).not.toContain(`network.${net}6.metric=`);
    }
  });

  it('il ciclo sta dopo mwan3-setup.sh, che e’ chi assegna le metriche v4', () => {
    // Il test sopra dice cosa succede se l'ordine e' sbagliato; questo tiene
    // fermo l'ordine, che e' l'unica cosa che lo rende irrilevante.
    const lines = setup.split('\n');
    const mwan = lines.findIndex((l) => l.includes('sh /usr/share/travel/mwan3-setup.sh'));
    const loop = lines.findIndex((l) => l.startsWith('for net in'));

    expect(mwan).toBeGreaterThan(0);
    expect(loop).toBeGreaterThan(mwan);
  });

  it('riallinea la metrica quando quella della sorella v4 cambia', () => {
    // Riordinare le priorita' delle WAN dall'interfaccia riscrive le metriche
    // v4: se la gemella restasse indietro, IPv6 uscirebbe da una WAN diversa
    // da IPv4.
    config(['network.wan.metric=10']);
    expect(makeSiblings().db).toContain('network.wan6.metric=10');

    writeFileSync(file('uci.db'), 'network.wan.metric=25\n', { flag: 'a' });
    const second = makeSiblings();

    expect(second.db).toContain('network.wan6.metric=25');
    expect(second.db).not.toContain('network.wan6.metric=10');
    expect(second.v6Reload).toBe(true);
  });

  it('allinea anche il wan6 dell’immagine, che nasce con metrica 0', () => {
    // La metrica di una gemella non e' una preferenza dell'utente: e' la meta'
    // v6 di una coppia, e deve seguire la sorella.
    config([
      'network.wan6=interface',
      'network.wan6.proto=dhcpv6',
      'network.wan6.metric=0',
      'network.wan.metric=10',
    ]);
    const { db } = makeSiblings();

    expect(db).toContain('network.wan6.metric=10');
  });

  it('a metrica gia’ allineata non chiede nessun reload', () => {
    config(['network.wan.metric=10']);
    makeSiblings();

    const second = makeSiblings();
    expect(second.v6Reload).toBe(false);
  });
});
