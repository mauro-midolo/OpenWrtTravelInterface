// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '../src/lib/ubus';
import {
  CLIENT_DNS_OPTIONS,
  clientDns,
  dnsEditable,
  dnsFieldsOk,
  matchDnsProvider,
  ROUTER_DNS_OPTIONS,
  stageLan,
} from '../src/lib/lan';
import type { LanConfig, LanSettings } from '../src/lib/lan';
import { isValidIp } from '../src/lib/ip';

vi.mock('../src/lib/ubus', async (original) => ({
  ...(await original<typeof import('../src/lib/ubus')>()),
  call: vi.fn(),
}));

const rpc = vi.mocked(call);

function lan(fields: Partial<LanConfig> = {}): LanConfig {
  return {
    device: 'br-lan',
    up: true,
    addresses: ['192.168.10.1'],
    netmask: '255.255.255.0',
    addresses6: [],
    ula: '',
    dhcp: { start: '100', limit: '150', leasetime: '12h', ignore: false },
    dns_client: [],
    dns_client6: [],
    dns_upstream: [],
    dnsmasq_section: 'cfg01',
    dhcp_options: [],
    ra: 'server',
    dhcpv6: 'server',
    ra_flags: ['managed-config', 'other-config'],
    ra_slaac: '',
    ra_default: '',
    ...fields,
  };
}

function settings(fields: Partial<LanSettings> = {}): LanSettings {
  return {
    address: '192.168.10.1',
    poolFrom: 100,
    poolTo: 249,
    dnsClient: [],
    dnsClient6: [],
    dnsUpstream: [],
    raMode: 'auto',
    ...fields,
  };
}

/** Tutte le `uci set` fatte, come coppie sezione/valori. */
function writes() {
  return rpc.mock.calls
    .filter((c) => c[1] === 'set')
    .map((c) => c[2] as { config: string; section: string; values: Record<string, unknown> });
}

/** Le opzioni cancellate, come "config.sezione.opzione". */
function deletions() {
  return rpc.mock.calls
    .filter((c) => c[1] === 'delete')
    .map((c) => {
      const a = c[2] as { config: string; section: string; option: string };
      return `${a.config}.${a.section}.${a.option}`;
    });
}

/** Il valore scritto per una certa opzione, ovunque sia stato scritto. */
function written(option: string): unknown {
  const found = writes().filter((w) => w.values[option] !== undefined);
  return found.length > 0 ? found[found.length - 1].values[option] : undefined;
}

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({});
});

describe('la trappola dei DNS IPv6', () => {
  it('nessun letterale IPv6 compare mai in dhcp_option', async () => {
    // E' LA proprieta' di questa fase. `dhcp_option 6,<csv>` e' solo DHCPv4:
    // un indirizzo v6 li' dentro non annuncia niente, e dnsmasq puo' rifiutare
    // l'intera lista per una voce che non gli piace - rompendo anche i DNS v4
    // mentre si crede di aggiungerne.
    await stageLan(
      settings({
        dnsClient: ['1.1.1.1', '1.0.0.1'],
        dnsClient6: ['2606:4700:4700::1111', '2606:4700:4700::1001'],
      }),
      null,
      lan(),
    );

    const options = written('dhcp_option') as string[];
    expect(options).toEqual(['6,1.1.1.1,1.0.0.1']);
    for (const entry of options) expect(entry).not.toContain(':');
  });

  it('i DNS v6 vanno in dhcp.lan.dns, che e’ un’opzione diversa', async () => {
    await stageLan(
      settings({ dnsClient: ['1.1.1.1'], dnsClient6: ['2606:4700:4700::1111'] }),
      null,
      lan(),
    );

    // Non `dhcp_option`: una lista a se', che legge odhcpd e non dnsmasq, e che
    // finisce sia nel campo RDNSS dell'RA sia nella risposta DHCPv6.
    expect(written('dns')).toEqual(['2606:4700:4700::1111']);
  });

  it('una lista v6 vuota viene cancellata, non scritta vuota', async () => {
    await stageLan(settings({ dnsClient: ['1.1.1.1'], dnsClient6: [] }), null, lan());

    expect(deletions()).toContain('dhcp.lan.dns');
    expect(written('dns')).toBeUndefined();
  });

  it('le due liste sono indipendenti: solo v6 non tocca i v4 altrui', async () => {
    // Le altre dhcp_option restano intatte quando si scrivono solo i v6.
    await stageLan(
      settings({ dnsClient: [], dnsClient6: ['2606:4700:4700::1111'] }),
      null,
      lan({ dhcp_options: ['3,192.168.10.1', '42,192.168.10.1'] }),
    );

    expect(written('dhcp_option')).toEqual(['3,192.168.10.1', '42,192.168.10.1']);
    expect(written('dns')).toEqual(['2606:4700:4700::1111']);
  });
});

describe('i DNS gia’ configurati non si perdono aprendo la schermata', () => {
  // Le due famiglie stanno in due opzioni uci diverse ma sono una scelta sola
  // nell'interfaccia. Se lo stato della schermata si costruisse sulla sola
  // meta' v4, la meta' v6 resterebbe fuori - e siccome il salvataggio riscrive
  // entrambe le opzioni, un salvataggio qualunque la cancellerebbe.

  it('una lista v6 senza v4 non viene scambiata per “automatico”', () => {
    // E' il caso che cancellava i dati: `dhcp.lan.dns` configurata a mano o da
    // LuCI, `dhcp_option 6` vuota. Guardando la sola v4 la modalita' risultava
    // `auto`, cioe' "nessun DNS", e salvare qualunque altra cosa - anche solo
    // il pool DHCP - cancellava i v6.
    const configured = lan({ dns_client: [], dns_client6: ['2606:4700:4700::1111'] });

    // Il difetto, scritto per esteso: guardando la sola lista v4 la risposta e'
    // "automatico", cioe' "nessun DNS scelto".
    expect(matchDnsProvider(configured.dns_client, CLIENT_DNS_OPTIONS)).toBe('auto');

    // Guardando tutte e due, no. E' l'unica differenza fra conservare quei DNS
    // e cancellarli al primo salvataggio.
    expect(matchDnsProvider(clientDns(configured), CLIENT_DNS_OPTIONS)).toBe('custom');
  });

  it('clientDns unisce le due meta’ nell’ordine in cui si leggono', () => {
    const configured = lan({ dns_client: ['1.1.1.1'], dns_client6: ['2606:4700:4700::1111'] });
    expect(clientDns(configured)).toEqual(['1.1.1.1', '2606:4700:4700::1111']);
  });

  it('una coppia mista scelta a mano fa il giro completo', async () => {
    // I due campi liberi si riempiono dalla lista unita, quindi risalvare senza
    // toccare niente riscrive esattamente quello che c'era.
    const configured = lan({ dns_client: ['1.1.1.1'], dns_client6: ['2606:4700:4700::1111'] });
    const [one, two] = clientDns(configured);

    await stageLan(
      settings({
        dnsClient: [one, two].filter((s) => !s.includes(':')),
        dnsClient6: [one, two].filter((s) => s.includes(':')),
      }),
      null,
      configured,
    );

    expect(written('dhcp_option')).toEqual(['6,1.1.1.1']);
    expect(written('dns')).toEqual(['2606:4700:4700::1111']);
    expect(deletions()).not.toContain('dhcp.lan.dns');
  });

  it('nessun DNS resta “automatico”, e li’ cancellare e’ giusto', () => {
    // Il caso opposto: entrambe vuote significa davvero "il router stesso", e
    // la cancellazione non perde niente.
    expect(matchDnsProvider(clientDns(lan()), CLIENT_DNS_OPTIONS)).toBe('auto');
  });

  it('un fornitore resta riconosciuto anche con la sua meta’ v6 gia’ scritta', () => {
    // Qui la meta' v6 e' derivata dalla scelta, non un dato da preservare:
    // risalvare riscrive gli stessi indirizzi.
    const configured = lan({
      dns_client: ['1.1.1.1', '1.0.0.1'],
      dns_client6: ['2606:4700:4700::1111', '2606:4700:4700::1001'],
    });
    expect(matchDnsProvider(clientDns(configured), CLIENT_DNS_OPTIONS)).toBe('cloudflare');
  });
});

describe('una lista che non entra in due campi non si sovrascrive', () => {
  // Il residuo della prima correzione: unire le due meta' ha risolto il caso
  // "v6 senza v4", ma i campi liberi restano DUE mentre la lista unita puo'
  // averne fino a quattro. Mostrarne solo i primi due e poi salvare
  // riscriverebbe la lista troncata.

  it('due v4 piu’ un v6 sono tre voci, e tre non ci stanno', () => {
    const configured = lan({
      dns_client: ['192.168.1.1', '192.168.1.2'],
      dns_client6: ['fd00::1'],
    });
    const all = clientDns(configured);

    expect(all).toHaveLength(3);
    expect(matchDnsProvider(all, CLIENT_DNS_OPTIONS)).toBe('custom');
    expect(dnsEditable(all, CLIENT_DNS_OPTIONS)).toBe(false);
  });

  it('e in quel caso il salvataggio non tocca nessuna delle due opzioni', async () => {
    // `null` significa "non toccare". Senza, il terzo indirizzo sparirebbe: i
    // campi ne mostrano due, e il salvataggio riscrive quello che vede.
    await stageLan(
      settings({ dnsClient: null, dnsClient6: null, dnsUpstream: null }),
      null,
      lan({ dns_client: ['192.168.1.1', '192.168.1.2'], dns_client6: ['fd00::1'] }),
    );

    expect(written('dhcp_option')).toBeUndefined();
    expect(written('dns')).toBeUndefined();
    expect(written('server')).toBeUndefined();
    expect(deletions()).not.toContain('dhcp.lan.dns');
    expect(deletions()).not.toContain('dhcp.lan.dhcp_option');
  });

  it('due voci ci stanno, e restano modificabili', () => {
    const configured = lan({ dns_client: ['192.168.1.1'], dns_client6: ['fd00::1'] });
    expect(dnsEditable(clientDns(configured), CLIENT_DNS_OPTIONS)).toBe(true);
  });

  it('un fornitore resta modificabile anche con quattro indirizzi', () => {
    // Li' le voci non sono un dato da conservare: sono la definizione della
    // scelta, e risalvare le riscrive identiche.
    const cloudflare = [...CLIENT_DNS_OPTIONS.find((o) => o.id === 'cloudflare')!.servers,
      ...(CLIENT_DNS_OPTIONS.find((o) => o.id === 'cloudflare')!.servers6 ?? [])];

    expect(cloudflare).toHaveLength(4);
    expect(dnsEditable(cloudflare, CLIENT_DNS_OPTIONS)).toBe(true);
  });

  it('vale anche per i resolver del router, dove il troncamento esisteva gia’', () => {
    // Tre resolver v4 scelti a mano troncavano al secondo anche prima di IPv6:
    // la divisione delle famiglie ha reso comune un guasto che c'era gia'.
    expect(dnsEditable(['9.9.9.9', '1.1.1.1', '8.8.8.8'], ROUTER_DNS_OPTIONS)).toBe(false);
    expect(dnsEditable([], ROUTER_DNS_OPTIONS)).toBe(true);
  });
});

describe('un elenco non modificabile non blocca il salvataggio', () => {
  it('i campi che non si mostrano non si convalidano', () => {
    // Il difetto: la convalida girava comunque sui campi nascosti. Un elenco
    // mostrato e non toccato spegneva il pulsante Salva dell'INTERA rete
    // locale - indirizzo e pool compresi - e non c'era nessun campo dove
    // sistemare il valore che non passava.
    expect(dnsFieldsOk(false, 'custom', '/example.com/192.168.1.1', '1.1.1.1')).toBe(true);
  });

  it('e’ un caso reale, non un valore inventato', () => {
    // `dhcp.<sezione>.server` accetta forme che indirizzi non sono: questa
    // manda un dominio a un resolver dedicato, ed e' configurazione legittima.
    expect(isValidIp('/example.com/192.168.1.1')).toBe(false);

    const configured = ['/example.com/192.168.1.1', '1.1.1.1', '8.8.8.8'];
    expect(dnsEditable(configured, ROUTER_DNS_OPTIONS)).toBe(false);
    expect(dnsFieldsOk(false, 'custom', configured[0], configured[1])).toBe(true);
  });

  it('quando i campi si mostrano, la convalida vale eccome', () => {
    expect(dnsFieldsOk(true, 'custom', 'non un indirizzo', '')).toBe(false);
    expect(dnsFieldsOk(true, 'custom', '1.1.1.1', 'nemmeno questo')).toBe(false);
    expect(dnsFieldsOk(true, 'custom', '1.1.1.1', '')).toBe(true);
    expect(dnsFieldsOk(true, 'custom', '1.1.1.1', '2606:4700:4700::1111')).toBe(true);
  });

  it('un fornitore o l’automatico non hanno campi da convalidare', () => {
    expect(dnsFieldsOk(true, 'cloudflare', '', '')).toBe(true);
    expect(dnsFieldsOk(true, 'auto', '', '')).toBe(true);
  });
});

describe('scrittura di RA', () => {
  it('ra_default resta a 0 e non ha un interruttore', async () => {
    // A 1 il router si annuncerebbe come gateway v6 predefinito anche senza un
    // upstream v6: i client uscirebbero da una strada che non porta da nessuna
    // parte, e IPv6 sparirebbe in ogni rete v4-only.
    await stageLan(settings({ raMode: 'auto' }), null, lan());
    expect(written('ra_default')).toBe('0');
  });

  it('spento cancella i flag invece di scriverli vuoti', async () => {
    await stageLan(settings({ raMode: 'off' }), null, lan());

    expect(written('ra')).toBe('disabled');
    expect(written('dhcpv6')).toBe('disabled');
    expect(deletions()).toContain('dhcp.lan.ra_flags');
    expect(deletions()).toContain('dhcp.lan.ra_slaac');
  });

  it('custom non scrive NIENTE di RA', async () => {
    // Il router e' in una configurazione che non e' nessuna delle tre:
    // sovrascriverla butterebbe via una scelta fatta altrove.
    await stageLan(settings({ raMode: 'custom' }), null, lan());

    for (const option of ['ra', 'dhcpv6', 'ra_flags', 'ra_slaac', 'ra_default']) {
      expect(written(option)).toBeUndefined();
    }
    expect(deletions()).not.toContain('dhcp.lan.ra_flags');
  });
});

describe('fornitori DNS e famiglie', () => {
  it('ogni fornitore porta entrambe le famiglie, mai la sola v6', () => {
    // Un resolver v6 e' raggiungibile solo con una WAN v6: offrirlo da solo
    // darebbe una configurazione che smette di risolvere cambiando albergo.
    for (const provider of CLIENT_DNS_OPTIONS) {
      if (provider.servers.length === 0) {
        expect(provider.servers6 ?? []).toEqual([]);
        continue;
      }
      expect(provider.servers6?.length).toBeGreaterThan(0);
      for (const address of provider.servers) expect(address).not.toContain(':');
      for (const address of provider.servers6 ?? []) expect(address).toContain(':');
    }
  });

  it('riconosce un fornitore anche quando la lista contiene entrambe le famiglie', () => {
    // I resolver del router stanno in una lista sola: confrontarla intera non
    // combacerebbe con nessun fornitore, che di v4 ne dichiara due.
    const cloudflare = ROUTER_DNS_OPTIONS.find((o) => o.id === 'cloudflare')!;
    const mixed = [...cloudflare.servers, ...(cloudflare.servers6 ?? [])];

    expect(matchDnsProvider(mixed, ROUTER_DNS_OPTIONS)).toBe('cloudflare');
  });

  it('riconosce un fornitore su un router configurato dalla versione precedente', () => {
    // Solo i v4 scritti, nessun v6: pretendere anche quelli mostrerebbe
    // "Personalizzato" al posto del fornitore che il router ha davvero.
    expect(matchDnsProvider(['1.1.1.1', '1.0.0.1'], ROUTER_DNS_OPTIONS)).toBe('cloudflare');
  });

  it('una lista scelta a mano resta personalizzata', () => {
    expect(matchDnsProvider(['192.168.1.1'], ROUTER_DNS_OPTIONS)).toBe('custom');
    expect(matchDnsProvider(['fd00::1'], ROUTER_DNS_OPTIONS)).toBe('custom');
    expect(matchDnsProvider([], ROUTER_DNS_OPTIONS)).toBe('auto');
  });
});
