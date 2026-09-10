# Supporto IPv6 dual-stack

## Context

L'app gestisce un router da viaggio GL.iNet Beryl 7 su OpenWrt 25.12: SPA Preact in `frontend/`,
plugin rpcd in shell + daemon ucode in `package/travel/files/`. **IPv6 oggi è escluso di proposito**,
e l'esclusione è portante in una dozzina di punti indipendenti — non è una svista da correggere in un
posto solo:

- `setup.sh:160,194,230` e `lan.ts:616` scrivono `ipv6=0` su ogni WAN gestita;
- `rpcd/travel:454-459` salta le interfacce `dhcpv6|6in4|6to4|6rd|464xlat` in `method_uplinks`;
- `lan.ts:53-101` è aritmetica a 32 bit (`ipToInt`), che IPv6 non può rappresentare;
- `default_gateway` (`rpcd:314-326`) confronta `target == "0.0.0.0"`, `active_l3_device` usa `ip -4`;
- `mwan3-setup.sh:146,252` scrive `family=ipv4` e `dest_ip=0.0.0.0/0`;
- `vpn-setup.sh` accende solo `net.ipv4.*` e dichiara a `:396-398` di non toccare IPv6;
- `method_clients` scarta le lease DHCPv6 e legge `ip neigh` con un sed IPv4-only;
- `wg_parse_conf:3455-3459` spezza `host:port` sull'ultimo `:`, **corrompendo in silenzio** un
  endpoint IPv6 nudo (`2001:db8::1` → host `2001:db8:`, porta `1`).

`docs/architettura.md:1247-1249` lo registra come funzionalità mancante. L'obiettivo è rendere
l'intero sistema indipendente dalla famiglia del protocollo, **senza cambiare il comportamento IPv4
attuale**.

### Decisioni prese

1. **WAN: dual-stack sempre, nessun interruttore.** `ipv6=0` sparisce ovunque; i router già
   installati vengono migrati una volta sola da `setup.sh`.
2. **LAN: prefix delegation + ULA, nessun campo prefisso.** La LAN prende il /64 dalla delega DHCPv6-PD
   più l'ULA di OpenWrt. La UI *mostra* gli indirizzi v6 e configura RA/DHCPv6 e i DNS v6 annunciati.
   Nessun `ip6addr` da compilare. **L'indirizzo IPv4 del router resta un /24 fisso**: `prefix24`,
   `lastOctet`, `isHostAddress`, `LAN_NETMASK`, `CANDIDATES` restano IPv4-only di proposito.
3. **Tutto, in fasi ordinate e verificabili.** Nessuna area esclusa.

### Stile

Commenti e stringhe in **italiano**, nello stile del progetto: il commento spiega *perché*, nominando
il guasto che evita. Vale in particolare per i punti in cui il codice giusto *sembra* sbagliato
(le parentesi tenute dentro `endpoint_host`, `findConflicts` che resta IPv4).

**Normalizzare al confine, non nei componenti** (`memory/normalizzare-ai-confini-non-nei-componenti.md`):
ogni campo nuovo dell'rpcd è **obbligatorio** sull'interfaccia TS e riempito in `lib/`, come fa
`withMacDefaults` (`lan.ts:458-465`). Un router con il pacchetto vecchio non manda i campi nuovi
(`memory/campi-rpcd-nuovi-vanno-normalizzati.md`), e la UI si aggiorna prima del pacchetto.

---

## Fase 0 — Verificare cinque fatti sul router (nessun codice)

Tutto il resto dipende da queste risposte; tirare a indovinare è il modo in cui questo piano
sbaglia. Da SSH:

1. `fw4 print | grep -n -A3 travel-killswitch` — la regola compare **una volta**, in una catena
   `inet`, **senza** `meta nfproto ipv4`? `travel_killswitch` è una `rule` senza `family` e senza
   indirizzi (`vpn-setup.sh:514-521`), quindi *dovrebbe* già coprire entrambe le famiglie. Se non è
   così, **la Fase 5 non parte** finché non esiste un gemello `travel_killswitch6`: un kill switch
   che perde IPv6 è peggio di nessun kill switch.
2. `ubus call network.interface dump | jsonfilter -e '@.interface[*].interface'` con
   `network.wan.ipv6` non impostato — netifd crea un `wan_6` dinamico, o l'immagine ha una
   `config interface 'wan6'` esplicita? Decide l'appaiamento della Fase 3 e se la Fase 9 è possibile.
3. `ip -6 neigh show dev br-lan` — colonne esatte e quanti `fe80::` per client.
4. `uci -q get dhcp.odhcpd.leasefile` e `head -5` del file — conferma la scelta della Fase 6 di
   **non** analizzarlo.
5. `uci -q get network.globals.ula_prefix` — presente? `setup.sh` non lo genera oggi, e odhcpd non
   se lo inventa.

---

## Fase 1 — `lib/ip.ts`, senza cambi di comportamento

**Nuovo modulo `frontend/src/lib/ip.ts`.** Non un'estensione di `lan.ts`: quel file parla della rete
che il router *offre*, e l'aritmetica a 32 bit dentro non è un fatto della LAN — `MultiWan.tsx:363`
già importa `isValidIp` da `lan.ts` per validare le regole mwan3, che è il sintomo. Il parsing degli
indirizzi è un confine, come `lib/ubus.ts` lo è per il trasporto.

```ts
export type IpFamily = 4 | 6;
export interface IpAddr { family: IpFamily; bytes: Uint8Array; zone: string }
export interface IpNet  { addr: IpAddr; prefix: number }
```

`bytes` e non un intero: il motivo per cui il modulo esiste è che 32 bit non bastano, e un BigInt
riporterebbe lo stesso problema in forma nuova — mascherare, confrontare e formattare avrebbero due
strade a seconda della famiglia, cioè due posti dove sbagliare.

| Export | Note |
|---|---|
| `parseIp(text)` | Stacca `%zone` (rifiutata su v4), poi dispatch su `:` |
| `isValidIp(text, family?)` | **Firma allargata**: entrambe le famiglie se `family` è omessa |
| `formatIp(addr)` | Canonico RFC 5952: minuscolo, run di zeri più lungo compresso, il più a sinistra a parità, mai un gruppo singolo |
| `parseCidr(text)` | Prefisso opzionale; **range validato per famiglia** (0-32 / 0-128) |
| `subnetOf(net)` / `subnetOfMask(ip, mask)` | La seconda è v4-only: `findConflicts` riceve ancora una netmask puntata |
| `maskToPrefix` / `prefixToMask` | v4-only; `isValidNetmask` diventa `maskToPrefix(m) !== null` |
| `contains` / `overlaps` | **`overlaps` ritorna `false` fra famiglie diverse** — riga portante nuova |
| `hostForUrl(text)` | `2001:db8::1` → `[2001:db8::1]`, zone scartata |
| `hostPortSplit` / `hostPortJoin` | Il problema dell'endpoint WireGuard, con un nome e testabile lato TS |
| `sortKey(addr)` | Esadecimale a larghezza fissa, prefissato dalla famiglia |
| `isUla` / `isLinkLocal` / `isGua` | Etichette nella LAN; `isUla` decide cosa annuncia Tailscale |

Dettagli di parsing (tutti diventano test): v4 esattamente 4 ottetti ≤255, **zeri iniziali rifiutati**
(`010` è ottale per alcuni stack — cambio deliberato rispetto a `lan.ts:59`, da commentare); v6 al
massimo un `::`, ≤8 gruppi, quad puntato finale che consuma 2 gruppi (`::ffff:192.168.1.1`), esattamente
8 gruppi dopo l'espansione; zone `fe80::1%eth0` sì, `fe80::1%` no, `1.2.3.4%eth0` no.

In questa fase `lan.ts` **ri-esporta i vecchi nomi**, così niente si rompe. Verificato: `ipToInt`,
`intToIp`, `subnetOf`, `overlaps`, `isValidNetmask` **non hanno chiamanti fuori da `lan.ts`** — la
migrazione è contenuta.

**Nuovo test `frontend/tests/ip.test.ts`** (tabellare). Casi che un'implementazione a occhio sbaglia:
`2001:db8:0:1:0:0:0:1` → `2001:db8:0:1::1`; `1:0:0:2:0:0:0:3` → `1:0:0:2::3` (più a sinistra);
`0:0:1:0:0:0:0:0` → `0:0:1::`; `10.0.0.0/33` ✗, `::/129` ✗, `10.0.0.0/128` ✗; `overlaps` fra famiglie
sempre falso; `sortKey` con `fd00::9 < fd00::10` e ogni v4 prima di ogni v6.

**Verifica:** `npm test`, `npm run typecheck`, `npm run build`; il simulatore si comporta identico.

---

## Fase 2 — Migrare i chiamanti

Sposta i chiamanti su `ip.ts`, cancella `ipToInt`/`intToIp`/il vecchio `Subnet`, toglie le
ri-esportazioni. `findConflicts` (`lan.ts:122-139`) e `suggestAddress` passano a `subnetOfMask`/`IpNet`.

`isValidIp` allargata ai due chiamanti: `Lan.tsx:782-783` (DNS personalizzati) e `MultiWan.tsx:363`
(`isValidTarget`, riscritta su `parseCidr` — che corregge anche `/^\d{1,2}$/`, incapace di esprimere
`/128` e felice di accettare `10.0.0.0/33`). Il messaggio a `MultiWan.tsx:738` perde "IPv4".

**`findConflicts` resta IPv4-only, e va scritto nel commento** (`lan.ts:114-121`), altrimenti il
prossimo lettore lo generalizza per niente:

> IPv6 non entra in questo controllo, e non è una dimenticanza. La collisione è un problema degli
> indirizzi privati IPv4, che sono pochi e li usano tutti: un prefisso delegato è unico per
> costruzione, e due ULA che collidono sono un caso che non capita. Soprattutto, il prefisso v6 della
> LAN non lo sceglie nessuno — arriva dalla delega — quindi non ci sarebbe niente da proporre.

`WanSubnet`/`Conflict` restano invariati; `Lan.tsx:76-84` tiene il suo `filter(u => u.ipv4)`.
`stripPrefix` (`:183`) resta com'è — `split('/')[0]` è già v6-safe, e serve una riga di commento
perché nessuno lo "aggiusti".

**Nuovo test `lan-conflicts.test.ts`**: `findConflicts` / `suggestAddress` / `checkPool`, oggi
completamente scoperti. Include lo scenario collidente del mock, la netmask mancante,
`suggestAddress` che ritorna `null` con tutti e sette i candidati occupati, e una WAN v6 che non
produce conflitti.

---

## Fase 3 — WAN dual-stack in lettura

Il cuore della fase è il **problema `wan6`**. netifd tiene IPv6 in un'interfaccia logica a sé, e
l'elenco la salta di proposito perché accanto a `wan` comparirebbe come una seconda porta ethernet
inesistente. Dual-stack significa una porta sola con due famiglie: **gli indirizzi v6 si uniscono
alla riga del fratello v4**, non ne aprono una nuova.

`package/travel/files/usr/libexec/rpcd/travel`:

- `method_uplinks` (`:443-566`): tenere il salto a `:454-459`, aggiungere **una sola**
  `ubus call network.interface dump` in cima — è più economica di N `status` in più, ed è **l'unico
  modo di vedere un `wan_6` dinamico**, il cui nome non si può indovinare. Appaiare sul
  **`l3_device`**, non sul nome (`wan6` può chiamarsi in qualunque modo ma sta per forza sopra lo
  stesso device); ripiego sui nomi `${net}6`/`${net}_6` a interfaccia giù; **mai** sul `device` uci,
  che è un riferimento simbolico (`@wan`).
- Emettere `ipv6[]` (indirizzo/prefisso uniti), `gateway6`, `prefix6`, `dns6[]`.
- `default_gateway` (`:314-326`) prende il target come `$2` (`0.0.0.0` o `::`). **Non** farle
  accettare l'uno o l'altro: un nexthop v4 finirebbe in `gateway6`.
- `active_l3_device6()` accanto a `:416-419`, con `ip -6 route show default`. `active` diventa vero
  se il device corrisponde a **una delle due**, preferendo la risposta v4 e ripiegando su v6 solo
  quando un default v4 non c'è.

**Frontend:** `Uplink` (`lib/wifi.ts:77-103`) e `DashWan` (`lib/dashboard.ts:28-71`) crescono
`ipv6: string[]`, `gateway6`, `prefix6`, `dns6[]` — **obbligatori**, riempiti da un nuovo
`withIpv6Defaults()` mappato in `getUplinks()`/`getDashboard()`.

**L'uplink v6-only.** Due punti che devono cambiare insieme:
`lib/wifi.ts:113-120` → `if (!u.up || (!u.ipv4 && u.ipv6.length === 0)) return 'no-address'`, e la
stessa condizione in `traveld.uc:196-235`. Senza entrambi, una rete mobile v6-only (464XLAT è comune)
resta per sempre "senza indirizzo" mentre funziona benissimo.

Righe di sola lettura: `Wifi.tsx:111-113`, `Dashboard.tsx:207-209`, `Connect.tsx:592`.

**Mock (`lib/mock.ts`)**: dare alla STA 5 GHz uno stack completo, lasciare la `wan` ethernet
**v4-only** (il caso albergo), e rendere `wan_usb` **v6-only** — è l'unico modo di vedere davvero il
passaggio `no-address` → `addressed`.

**Nuovi test:** `uplink-state.test.ts` (v4-only / v6-only / entrambi / nessuno / giù / disattivata) e
**`lan-defaults.test.ts`**, che dà a ogni funzione di confine un payload con **tutti i campi nuovi
tolti** e verifica che il risultato sia il comportamento di oggi. È l'unico test che dimostra che lo
stato intermedio dell'aggiornamento funziona.

---

## Fase 4 — WAN dual-stack accese

Togliere `ipv6=0` da `setup.sh:160,194,230` e da `lan.ts:616` (`stageEthPort`).

Migrazione una tantum in `setup.sh`, col pattern esistente (`travel.globals.eth_roles_init:118/179`,
`dhcp_hostname_init:256/266`, `saved_bands_init:292/385`): sotto marcatore
`travel.globals.ipv6_init`, **cancellare** `network.<wan>.ipv6` su ogni rete della zona firewall
`wan`. Cancellare e non scrivere `1`: si torna al default di OpenWrt invece di imporre un valore, ed
è la stessa distinzione di `macaddr` in `stageEthMac`.

**Nuovo test shell `ipv6-migration.test.ts`**, nello stile di `toggle-ap.test.ts` (script veri, `uci`
simulato, Git Bash su Windows): installazione nuova, aggiornamento, **seconda esecuzione che non
tocca niente**, e un utente che rimette `ipv6=0` dopo il marcatore se lo tiene.

---

## Fase 5 — LAN IPv6

*Dipende dalla risposta 1 della Fase 0.*

**Lettura** (`method_lan`, `rpcd:1054-1121`), da `ubus call network.interface.lan status`:
`@["ipv6-address"][*]` e soprattutto `@["ipv6-prefix-assignment"][*]` — è **questo** il /64
effettivamente delegato alla LAN, e `local-address` è l'indirizzo del router dentro. Emettere l'unione
deduplicata come `addresses6` **col prefisso attaccato**: a differenza degli `addresses` v4, che sono
nudi perché alimentano un campo di input, questi alimentano una riga di sola lettura e il prefisso è
la metà informativa. Più `ula` da `network.globals.ula_prefix`.

**RA/DHCPv6: una scelta a tre, non sette manopole.** Derivate da una funzione sola, rilette con un
`matchRaMode()` fatto come `matchDnsProvider` (`lan.ts:240-253`):

| Scelta | `ra` | `dhcpv6` | `ra_flags` | `ra_slaac` |
|---|---|---|---|---|
| **Automatico (consigliato)** | `server` | `server` | `managed-config`, `other-config` | `1` |
| **Solo SLAAC** | `server` | `disabled` | `other-config` | `1` |
| **Spento** | `disabled` | `disabled` | *(cancellata)* | — |

"Automatico" è il default di OpenWrt ed è l'unica combinazione in cui Android (solo SLAAC) e Windows
(preferisce DHCPv6) funzionano entrambi. **"Spento" deve esistere**: è la risposta a "IPv6 mi ha
rotto la connessione in albergo", e senza si recupera solo da SSH. `matchRaMode` ritorna `'custom'`
quando la configurazione non è nessuna delle tre, e in quel caso la schermata mostra i valori grezzi
**in sola lettura** e si rifiuta di sovrascriverli — stessa regola di `matchDnsProvider`: non si
mostra mai uno stato in cui il router non è. `ra_default` resta fisso a `0` senza interruttore, e va
commentato: `1` annuncerebbe il router come gateway v6 predefinito anche senza upstream v6, facendo
sparire IPv6 in ogni rete v4-only.

**La trappola dei DNS v6** — da scrivere per esteso nel codice. `dhcp_option 6,<csv>` è **solo
DHCPv4**. Un indirizzo v6 lì dentro non annuncia niente, e dnsmasq può rifiutare l'intera lista per
una voce malformata: si romperebbero anche i DNS v4 mentre si crede di aggiungerne. L'opzione giusta
è `dhcp.lan.dns`, una **lista letta da odhcpd** (non da dnsmasq) e annunciata sia nel campo RDNSS
dell'RA sia nella risposta DHCPv6. Quindi `stageLan` (`lan.ts:310-389`) scrive **due cose
indipendenti**, riusando `clear()` (`:335-341`) per cancellare invece di scrivere vuoto.

`PROVIDERS` (`lan.ts:213-218`) guadagna `servers6` (Google `2001:4860:4860::8888/::8844`, Cloudflare
`2606:4700:4700::1111/::1001`, Quad9 `2620:fe::fe/::9`, AdGuard `2a10:50c0::ad1:ff/::ad2:ff`).
`matchDnsProvider` **confronta solo la lista v4** e tratta la v6 come derivata: altrimenti un router
configurato dalla UI precedente mostrerebbe "Personalizzato" invece di "Cloudflare".

I resolver del router (`dhcp.<dnsmasq_section>.server`) accettano v6 senza sintassi speciale: basta
la `isValidIp` allargata. Le voci dei fornitori scrivono però **sempre entrambe le famiglie**, mai
solo v6, perché un upstream v6 è raggiungibile solo con una WAN v6.

Le scritture RA passano da `useApply` con un `verify` che rilegge `travel.lan` e controlla che la
modalità abbia preso, come già fa `Lan.tsx:801-812`.

**Nessuna modifica agli ACL** in tutto il piano: `dhcp`, `network`, `firewall`, `mwan3` sono già in
scrittura in `acl.d/travel.json`. Vale la pena dirlo, perché un ACL mancante fallisce con un errore
di permesso opaco.

**Nuovi test:** `lan-ra.test.ts` (le tre modalità e il round-trip di `matchRaMode`, `'custom'` per
una combinazione non riconosciuta) e `lan-dns.test.ts` (**nessun letterale v6 compare mai in
`dhcp_option`**, e `dhcp.lan.dns` vuota viene cancellata).

---

## Fase 6 — Dispositivi collegati

**Non analizzare il lease file di odhcpd.** La seconda colonna è un DUID, e un DUID non è un MAC:
un client v6 preso da lì non si può unire in modo affidabile al suo stesso io v4, che è tutto il
punto. Il rifiuto già presente a `rpcd:1475-1487` **resta**, col commento esteso a dire che quelle
righe non sono solo da saltare, sono inutilizzabili come chiave di unione.

Si usa `ip -6 neigh show dev br-lan`, che dà la stessa chiave su cui la lista è già costruita. Il sed
a `:1492` è IPv4-only, e allargare la classe di caratteri farebbe combaciare il MAC come indirizzo:
servono **due comandi con due sed stretti**. Saltare `FAILED`/`INCOMPLETE`; **saltare `fe80::`** nella
lista mostrata (ce l'hanno tutti, non informa, e quattro indirizzi per dispositivo rendono la lista
illeggibile) — ma usarlo per stabilire la *presenza* di un client senza v6 globale.

`LanClient` (`lan.ts:646-660`) guadagna `ips6: string[]`, riempito da un nuovo `withClientDefaults()`
in `listClients()`. **Una riga per MAC, non per indirizzo**: un dispositivo è un dispositivo, e
triplicare la lista rende più difficile — non più facile — l'unica domanda a cui serve rispondere.
`clientTitle` (`:687`) → `name || ip || ips6[0] || mac`; `clientDetail` (`:698-704`) aggiunge il primo
v6 quando non c'è v4, o `· +2 IPv6` quando c'è. L'ordinamento (`:669-678`) passa da
`localeCompare(numeric)` a `sortKey`: `localeCompare` azzecca `192.168.10.9 < 192.168.10.10` per caso
e sbaglia `fd00::9 < fd00::10`.

Lato rpcd, `client_object()` (`:1419-1434`) guadagna `json_add_array ips6`; l'unione richiede un
accumulatore `mac→indirizzi` costruito dalle due letture `ip neigh` prima di emettere.

**Nuovo test:** `clients-sort.test.ts`.

---

## Fase 7 — Firewall, inoltro e VPN

**`vpn-setup.sh:18-63 enable_forwarding`** — aggiungere `net.ipv6.conf.all.forwarding=1` al file
sysctl.d e a `/proc`, mantenendo la struttura leggi-e-riporta. **L'avvertenza va nel commento**,
perché è il modo in cui questa fase spegne IPv6 credendo di accenderlo:

> Il kernel accetta i Router Advertisement solo quando NON sta inoltrando: `accept_ra=1` significa
> "accetta se non inoltro". Accendere l'inoltro globale fa quindi smettere di accettare gli RA su
> ogni interfaccia rimasta a 1 — cioè la WAN smette di autoconfigurarsi e IPv6 muore. La cura è
> `accept_ra=2` sulle WAN, che netifd scrive da solo per le interfacce che gestisce con IPv6 attivo:
> qui non lo si tocca, lo si **controlla** e si avvisa se non è così.

Aggiungere quel controllo con lo stesso `say "ATTENZIONE: ..."` della verifica esistente, nominando il
device. `iface_forwarding` (`:150-152`) guadagna il gemello v6 per `tailscale0`.

- **Zona `travel_vpn`**: `masq='1'` è solo IPv4 → aggiungere `masq6='1'`. Senza, l'indirizzo ULA di un
  client esce nel tailnet senza via di ritorno, e il sintomo è "alcune cose funzionano".
- **`travel_vpn_wg`** (`vpn-setup.sh:~494`, rpcd `:2874-2895`): il range v6 di Tailscale è
  `fd7a:115c:a1e0::/48`. Sezione **`travel_vpn_wg6`** gemella con `family='ipv6'`, scritta e commutata
  dalla stessa funzione — due sezioni esplicite e non una regola senza famiglia, perché la disciplina
  del file è "una sezione per cosa, sempre presente, commutata da `enabled`", e `src_ip` forzerebbe
  comunque la famiglia.
- **Kill switch**: confermato dalla Fase 0. Se risulta v4-only, gemello `travel_killswitch6`
  **prima** che la Fase 5 accenda IPv6 sulla LAN.
- **Tailscale `--advertise-routes`** (rpcd `:2459-2462`, `lan_cidr()` `:2503-2521`): aggiungere
  `lan_cidr6()` e unire con la virgola. **Annunciare solo l'ULA, mai la GUA derivata dalla delega**:
  il prefisso delegato cambia a ogni albergo, e una rotta GUA annunciata diventa stantia appena ci si
  sposta — un buco nero che sopravvive alla riconnessione. `method_vpn` (`:2689`) emette `lan_cidr6`;
  `Vpn.tsx:487` mostra entrambi.

---

## Fase 8 — WireGuard IPv6

**Il bug concreto**, `rpcd:3455-3459`: `Endpoint = 2001:db8::1` diventa host `2001:db8:` e porta `1`.
Due valori plausibili e sbagliati scritti in uci — il modo peggiore di sbagliare: il tunnel si scrive,
netifd non si lamenta, l'handshake non arriva mai e nessuno sa dire perché.

`wg_split_endpoint()` con quattro forme (`host:porta`, `[v6]:porta`, `[v6]`, `v6 nudo` riconosciuto da
due o più `:` — nessun nome di host e nessun IPv4 può contenerne due). **Le parentesi si tengono
dentro `endpoint_host`**, e sembra sbagliato ma non lo è: netifd ricompone l'endpoint come
`"$endpoint_host:$endpoint_port"`, e senza parentesi ne uscirebbe `2001:db8::1:51820`, che è un
indirizzo IPv6 valido e **diverso**. Il commento deve dirlo, o qualcuno lo "aggiusta".

- `valid_wg_host()` accanto a `valid_wg_key` (`:3107`), chiamata da `wg_validate` (`:3168`), dove
  l'host dell'endpoint oggi **non è controllato affatto**.
- `valid_wg_addrs` (`:3115-3124`) oggi accetta `::::::` e `/999`: separare per famiglia e validare il
  range del prefisso.
- Default AllowedIPs (`:3463`): **resta `0.0.0.0/0`**. Un file che non dice AllowedIPs è un file che
  non ha pensato a v6, e indovinare `::/0` creerebbe un buco nero su ogni profilo del genere.
- `WireGuard.tsx:33` → `hostPortJoin(...)` da `lib/ip.ts`, idempotente sulle parentesi. I campi
  `:84-89`, oggi senza alcuna validazione lato client, ne prendono una che rispecchia `valid_wg_host`.
- **Routing in tabella 53** (`vpn-setup.sh:227-289`): gemelli `ip -6` per rotta e regole,
  **solo quando gli AllowedIPs del profilo contengono davvero un range v6**. Una default v6 in un
  tunnel senza AllowedIPs v6 fa sparire IPv6. La sonda `lan_probe_addr` (`:275-289`) ha bisogno del
  suo gemello v6: il commento a `:262-267` è portante, e la sua controparte v6 lo è di più — lo
  stesso blocco in v6 lascia SSH-su-v4 funzionante, quindi il router *sembra* a posto mentre ogni
  browser che preferisce v6 si pianta. `wg_routing_down` deve smontare anche le regole v6.
- `WgRouting` (`lib/vpn.ts:248-256`) guadagna `route6`/`rule6` (default `false`); `wgRoutingSteps`
  (`:493-521`) mostra le due righe **solo** se il profilo ha AllowedIPs v6, altrimenti un tunnel
  v4-only mostrerebbe un rosso permanente e la gente imparerebbe a ignorare l'elenco.

**Nuovo test shell `wg-endpoint.test.ts`**: cinque `.conf` attraverso `wg_parse_conf`. Proprietà da
verificare: `[2001:db8::1]:51820` fa round-trip identico, e `2001:db8::1` diventa
`[2001:db8::1]:51820` — non identico all'incollato, ma **corretto e stabile al secondo giro**.

---

## Fase 9 — mwan3 IPv6 *(opzionale, ultima)*

`mwan3.<interfaccia>` è **mono-famiglia** e il nome della sezione deve coincidere con quello
dell'interfaccia netifd: un gemello v6 richiede una `config interface '<wan>6'` reale
(`proto dhcpv6`, `device '@<wan>'`), perché una `wan_6` dinamica non è tracciabile in modo affidabile.

**Fino alla Fase 8 compresa, mwan3 resta IPv4** — `family=ipv4` a `mwan3-setup.sh:146` e
`dest_ip=0.0.0.0/0` a `:252` restano, **con un commento che dice che restano di proposito**. Il modo
di fallire è compreso e accettabile: quando la WAN primaria cade, odhcpd ritira il prefisso delegato,
i client perdono la GUA e Happy Eyeballs ripiega su v4. Degrado, non rottura.

Se si fa la fase: gemelli `<wan>6` in `mwan3-setup.sh` con un pool di tracking v6 ruotato dallo stesso
`pick_track_ips` (`:114-127`); politiche `travel_failover6`/`travel_balance6`; **`travel_default6`
vero con `dest_ip='::/0'`**, ricreato da `moveDefaultRuleLast` (`mwan.ts:292-314`) insieme al v4 così
restano entrambi in fondo. `setPriorityOrder`/`setWeight`/`setEnabled` toccano due sezioni
**nella stessa transazione o in nessuna**: priorità disallineate mandano v4 e v6 su WAN diverse, cioè
metà del web carica — molto più difficile da diagnosticare di un guasto pulito. `ruleValues` (`:259`)
deduce `family` da `parseCidr`, e rifiuta lato client una regola che mescola le famiglie.

**Nuovo test:** `mwan-rules.test.ts`.

---

## Fase 10 — Documentazione

`docs/architettura.md` va riallineato: `:528-539` (multi-WAN IPv4, "non esiste una gestione completa
IPv6"), `:597-603` (LAN IPv4 /24), `:1247-1249` ("IPv6 gestito dall'app" fra le cose mancanti), più
`README.md:85`. Aggiungere una sezione IPv6 che scrive **la tabella delle modalità RA** e **la
distinzione fra `dhcp_option 6` e `dhcp.lan.dns`**: sono le due cose che si sbagliano rileggendo il
codice fra sei mesi. Se una fase introduce un'operazione di apply nuova, aggiornare la tabella dei
timeout a `:159-167`.

---

## Dipendenze

1 → 2 e 3 → 4 sono le uniche catene rigide. **5, 6, 7, 8 dipendono da 3-4 ma non l'una dall'altra**,
quindi si possono riordinare. 9 è opzionale. La Fase 5 è però **subordinata alla risposta 1 della
Fase 0**.

## Verifica

**Per fase, in sviluppo:** `cd frontend && npm run typecheck && npm test && npm run build`. Il
simulatore (`npm run dev` senza `VITE_ROUTER`) deve mostrare le tre WAN — dual-stack, v4-only,
v6-only — con gli stati giusti, la LAN con prefisso delegato e ULA, e un client v6-only nell'elenco.
I test shell richiedono Git Bash nel percorso standard su Windows.

**Sul router,** dopo `tools/deploy.ps1`:

- Fase 4: `ubus call network.interface.wan status | jsonfilter -e '@["ipv6-address"]'` non è vuoto, e
  `uci -q get network.wan.ipv6` non esiste più. Rieseguire `setup.sh` e verificare che non tocchi
  niente.
- Fase 5: un telefono in LAN prende un indirizzo v6, `ping -6` e una risoluzione DNS su v6
  funzionano; scegliere "Spento" riporta al comportamento di prima.
- Fase 7: `fw4 print` mostra le regole attese; con kill switch acceso un client v6 **non** esce.
- Fase 8: importare deliberatamente un profilo `::/0` e verificare che la sonda smonti il routing
  invece di lasciare il router irraggiungibile.
- Fase 9: staccare il cavo della WAN primaria e guardare v6 fare failover insieme a v4.

**Regressione IPv4:** dopo ogni fase, indirizzo LAN, pool DHCP, conflitti con le WAN, regole mwan3 e
un tunnel WireGuard v4 devono comportarsi come prima. `lan-defaults.test.ts` copre il caso
UI-nuova/pacchetto-vecchio, che è lo stato normale fra il deploy della SPA e quello del pacchetto.

## Rischi — cosa può chiudere fuori dal router

- **`net.ipv6.conf.all.forwarding=1` spegne IPv6** se le WAN non hanno `accept_ra=2` (Fase 7).
- **Kill switch che perde IPv6** se la Fase 5 parte prima della verifica della Fase 0.
- **`::/0` in tabella 53 senza `suppress_prefixlength`** ripete il blocco documentato a
  `vpn-setup.sh:262-267`, e in v6 è peggio: SSH su v4 continua a funzionare, quindi il router sembra
  a posto mentre ogni browser si pianta.
- **Router a metà aggiornamento** (UI nuova, pacchetto vecchio): ogni campo nuovo è riempito al
  confine, e nessun componente legge `lan.addresses6[0]` senza guardia.
- **GUA annunciata a Tailscale**: rotta stantia a ogni cambio di albergo. Solo ULA.
- **Le parentesi in `endpoint_host` sembrano un bug** e qualcuno le toglierà, reintroducendo
  `2001:db8::1:51820`. Il commento deve dire che è netifd a fare la giunzione ingenua.
