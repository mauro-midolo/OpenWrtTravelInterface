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

## Fase 0 — Verificare cinque fatti sul router ✅ *(fatta il 2026-09-10)*

Eseguita via SSH su `192.168.10.1` — **GL.iNet GL-MT3600BE, OpenWrt 25.12.5 r33051-f5dae5ece4**
(non il Beryl 7 del Context: annotato perché il modello decide quali interfacce esistono).
Tutte letture; l'unica scrittura è stata una `uci set` **non committata e subito revertita** per far
rendere a `fw4` una regola disabilitata.

**1. Kill switch — copre già entrambe le famiglie. La Fase 5 non è bloccata.**
`travel_killswitch` è `enabled='0'` oggi, quindi `fw4 print` lo salta (`is disabled, ignoring
section`); staged a `1` senza commit, rende in `table inet fw4`, `chain forward_lan`:

```
meta l4proto tcp counter jump reject_to_wan comment "!fw4: travel-killswitch"
meta l4proto udp counter jump reject_to_wan comment "!fw4: travel-killswitch"
chain reject_to_wan { oifname { "eth0", "phy0.0-sta0" } counter jump handle_reject
                      comment "!fw4: reject wan IPv4/IPv6 traffic" }
```

Nessun `meta nfproto ipv4`, tabella `inet`, e il bersaglio se lo dice da solo: *IPv4/IPv6*.
**Niente gemello `travel_killswitch6`** — la voce corrispondente sparisce dalla Fase 7 e dai Rischi.

*Trovato per strada, non nel piano:* la regola rende **due** righe, `tcp` e `udp`, perché
`travel_killswitch` non ha `proto` e il default di fw4 è `tcp udp`. Il kill switch quindi **non
ferma ICMP**, e in v6 non ferma ICMPv6. È un buco che esiste già oggi in IPv4 e che IPv6 non
peggiora — non appartiene a questo piano, ma va deciso a parte se lasciarlo.

**2. `wan6` è esplicito nell'immagine — e i due casi convivono sullo stesso router.**
`ubus call network.interface dump` elenca `lan, loopback, travel_wg2, wan, wan6, wwan_radio0,
wwan_radio1`. In uci:

```
network.wan.device='eth0'   proto='dhcp'    ipv6='0'  metric='10'
network.wan6.device='eth0'  proto='dhcpv6'             metric='0'
network.wwan_radio0.ipv6='0'  network.wwan_radio1.ipv6='0'  network.wan_usb.ipv6='0'
firewall.@zone[1].network='wan' 'wan6' 'wwan_radio0' 'wwan_radio1' 'wan_usb'
```

Quindi: la WAN ethernet ha un gemello **statico** `wan6` già in zona firewall, mentre wwan/USB non
ne hanno nessuno e, tolto `ipv6=0`, prenderanno un `<net>_6` **dinamico** da netifd.
**L'appaiamento sul `l3_device` della Fase 3 è confermato ed è obbligatorio**: nessuna regola sui
nomi copre entrambi i casi. Nota che `wan6.device` è `'eth0'` letterale, non `'@wan'`.
Per la Fase 9 (opzionale): il gemello mwan3 è possibile **solo per `wan`**, che una sezione reale ce
l'ha; per wwan/USB andrebbe creata.

**3. `ip -6 neigh show dev br-lan` — stesse colonne di v4.**

```
fe80::44b9:79e1:3303:657a         lladdr 30:c5:99:13:12:bd REACHABLE
fd66:67c3:698b:0:c8c2:74c0:24e7:3eb lladdr 30:c5:99:13:12:bd DELAY
fd66:67c3:698b:0:c8:188e:f90e:be6c  lladdr 26:50:b7:ed:38:81 STALE
fe80::2450:b7ff:feed:3881         lladdr 26:50:b7:ed:38:81 STALE
```

`<indirizzo> lladdr <mac> <STATO>`, identico a v4 salvo che le righe v4 `FAILED` **non hanno affatto
il campo `lladdr`** (`192.168.10.205 FAILED`) — il sed deve reggerlo. Due indirizzi per client oggi
(un `fe80::` più un ULA), nessuna GUA perché non c'è upstream v6: con una WAN v6 collegata saranno
tre o quattro per client, il che conferma sia il salto di `fe80::` sia la scelta di **una riga per
MAC**.

**4. Il lease file esiste, ha contenuto, e resta non analizzato.** `dhcp.odhcpd.leasefile` =
`/tmp/odhcpd.leases`; `dhcp.odhcpd.maindhcp='0'` (dnsmasq fa v4, odhcpd fa v6 — è la premessa della
Fase 5 su `dhcp.lan.dns`). Prima riga:

```
# br-lan 0001000130afdb8c30c5991312bd 630c599 Asus_Strix_G16 1789046852 2f3 128 fd66:67c3:698b::2f3/128
```

Il rifiuto **resta**, e ora c'è la prova di *perché* è una trappola: quel DUID è di tipo `0001`
(DUID-LLT) e il MAC ce l'ha dentro in coda (`30c5991312bd`), quindi l'unione *sembra* funzionare
sul primo client che si guarda. Ma il DUID del router stesso è `network.globals.dhcp_default_duid` =
`0004...` (DUID-UUID), che di MAC non ne contiene nessuno: chi scrivesse l'estrazione la vedrebbe
funzionare in laboratorio e fallire in albergo. Va scritto nel commento della Fase 6.
Secondo fatto: l'indirizzo in lease `fd66:67c3:698b::2f3/128` **non compare in `ip -6 neigh`** — quel
client usa i suoi indirizzi SLAAC. Non analizzando il file perdiamo l'indirizzo DHCPv6, non il
client: accettabile, perché una riga per MAC c'è comunque.

**5. `ula_prefix` c'è.** `network.globals.ula_prefix='fd66:67c3:698b::/48'`, e in più
`network.lan.ip6assign='60'` è già impostato. `setup.sh` non deve generarli. `lan_cidr6()` (Fase 7)
può contare sull'ULA su questo dispositivo ma **deve reggere l'assenza**, perché il piano non lo
crea.

### Due fatti in più, non chiesti, che cambiano la Fase 7

**L'inoltro IPv6 è già acceso, da OpenWrt stesso.** `/etc/sysctl.d/10-default.conf` contiene
`net.ipv6.conf.all.forwarding=1` e `net.ipv6.conf.default.forwarding=1`; `sysctl` conferma
`net.ipv6.conf.all.forwarding = 1`. `30-travel-forwarding.conf` scrive oggi solo `net.ipv4.ip_forward=1`.
Aggiungerci la riga v6 è quindi **un no-op che ribadisce un default**, non un cambio di stato — e il
rischio in cima al piano ("`forwarding=1` spegne IPv6") descrive una condizione che su questo
dispositivo **esiste già da prima di noi**.

**E infatti `accept_ra=0` ovunque** (`eth0`, `phy0.0-sta0`, `br-lan`, e `default`), con IPv6 che su
OpenWrt funziona lo stesso: `proto dhcpv6` gira su **odhcp6c in spazio utente**, che gli RA se li
legge da sé su socket raw e non dipende da `accept_ra` del kernel. La cura "`accept_ra=2` sulle WAN"
va quindi **riformulata prima di implementarla**: il controllo con `say "ATTENZIONE: ..."` così com'è
scritto oggi allarmerebbe su ogni router sano. **Da verificare in Fase 4**, quando una WAN v6 sarà
davvero su: se `wan6` prende un indirizzo con `accept_ra=0`, il controllo va tolto dalla Fase 7, non
riscritto.

**Stato di partenza di `dhcp.lan`** (utile alla Fase 5): `ra='server'`, `dhcpv6='server'`,
`ra_flags='managed-config' 'other-config'`, `ra_preference='medium'`, `ra_slaac` e `ra_default` non
impostate. È già esattamente la riga **"Automatico"** della tabella, quindi `matchRaMode()` su un
router appena installato deve rispondere `'automatico'` — con `ra_slaac` **assente** (default `1`),
non scritta: il match deve trattare l'assenza come `1`, o mostrerà "Personalizzato" a tutti.
Nessuna `dhcp_option` e nessuna `dhcp.*.dns` presente oggi.

---
## Fase 1 — `lib/ip.ts`, senza cambi di comportamento ✅ *(fatta il 2026-09-10)*

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

*Come è stato fatto davvero:* `ipToInt`, `isValidIp` e `isValidNetmask` sono ora involucri sopra
`ip.ts` (una sola implementazione dell'analisi, che era il punto), mentre `intToIp`, `Subnet`,
`subnetOf` e `overlaps` restano l'aritmetica intera di prima — non hanno una controparte a pari
firma in `ip.ts`, e riscriverli qui sarebbe già la Fase 2. `lan.ts` non contiene più parsing.

**Nuovo test `frontend/tests/ip.test.ts`** (tabellare). Casi che un'implementazione a occhio sbaglia:
`2001:db8:0:1:0:0:0:1` → `2001:db8:0:1::1`; `1:0:0:2:0:0:0:3` → `1:0:0:2::3` (più a sinistra);
`0:0:1:0:0:0:0:0` → `0:0:1::`; `10.0.0.0/33` ✗, `::/129` ✗, `10.0.0.0/128` ✗; `overlaps` fra famiglie
sempre falso; `sortKey` con `fd00::9 < fd00::10` e ogni v4 prima di ogni v6.

**Verifica:** `npm test`, `npm run typecheck`, `npm run build`; il simulatore si comporta identico.

### Esito

`npx tsc --noEmit` pulito, **287 test su 15 file** (120 nuovi in `ip.test.ts`), `npm run build` a
228 kB, sotto il limite di 300. Nessun test preesistente toccato.

**Un errore del piano, trovato da un test rosso.** Il piano scrive — qui, nella Fase 8 e nei Rischi —
che la giunzione ingenua produce `2001:db8::1:51820`, "un indirizzo IPv6 valido e diverso". **Non è
valido:** `51820` sono cinque cifre e un gruppo esadecimale ne ammette quattro. Con quella porta la
stringa è malformata e il guasto si vede subito. Il caso silenzioso è una porta di **al massimo
quattro cifre** — `443`, `8080` — che è anche un gruppo esadecimale legale: `2001:db8::1:443` è
valido, è un altro host, e niente protesta. La correzione conta perché cambia quale esempio va messo
nel commento: quello che sembra innocuo, non quello che sembra pericoloso. Commento e test lo dicono
entrambi, e la Fase 8 e i Rischi sono stati corretti di conseguenza.

**Una trappola per la Fase 2, scoperta qui.** `MultiWan.tsx:673` fa `ips.every(isValidIp)`, e
`Array.every` passa **l'indice** come secondo argomento: ri-esportare da `lan.ts` la `isValidIp`
allargata convaliderebbe il primo indirizzo contro la "famiglia 0" e il secondo contro la
"famiglia 1", rifiutandoli entrambi. Silenzioso, perché il tipo `IpFamily` non protegge una chiamata
che passa un `number`. Per questo `lan.ts` espone ancora una `isValidIp` a **un parametro solo**, e
la Fase 2 deve sistemare quel chiamante prima di togliere l'involucro.

**Due scelte non scritte nel piano**, entrambe commentate nel codice: `formatIp` rende un indirizzo
IPv4-mapped in esadecimale (`::ffff:c0a8:101`) invece della forma puntata suggerita da RFC 5952 §5 —
qui non compare mai e una seconda strada nella formattazione costa più di quanto vale; e `isLinkLocal`
copre anche `169.254/16`, così l'etichetta non ha un buco in IPv4.

---

## Fase 2 — Migrare i chiamanti ✅ *(fatta il 2026-09-10)*

Sposta i chiamanti su `ip.ts`, cancella `ipToInt`/`intToIp`/il vecchio `Subnet`, toglie le
ri-esportazioni. `findConflicts` (`lan.ts:122-139`) e `suggestAddress` passano a `subnetOfMask`/`IpNet`.

`isValidIp` allargata ai due chiamanti: `Lan.tsx:782-783` (DNS personalizzati) e `MultiWan.tsx:363`
(`isValidTarget`, riscritta su `parseCidr` — che corregge anche `/^\d{1,2}$/`, incapace di esprimere
`/128` e felice di accettare `10.0.0.0/33`). Il messaggio a `MultiWan.tsx:738` perde "IPv4".

**C'è un terzo chiamante, e va sistemato per primo**: `MultiWan.tsx:673` fa `ips.every(isValidIp)`, e
`Array.every` passa **l'indice** come secondo argomento. Con la firma allargata il primo indirizzo
verrebbe convalidato contro la "famiglia 0" e il secondo contro la "famiglia 1", cioè rifiutati
entrambi — e il tipo `IpFamily` non lo intercetta, perché la chiamata arriva da `every` e non dal
codice. Diventa `ips.every((ip) => isValidIp(ip))`. Finché non è fatto, l'involucro a un parametro in
`lan.ts` (Fase 1) è quello che tiene in piedi la schermata.

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

### Esito

`tsc --noEmit` pulito, **309 test su 16 file** (22 nuovi in `lan-conflicts.test.ts`), build a
229 kB. `lan.ts` non esporta più `ipToInt`, `intToIp`, `isValidIp`, `isValidNetmask`, `Subnet`,
`subnetOf` né `overlaps`, e nessun residuo li cerca. `intToIp` e `isValidNetmask` si sono rivelate
**esportazioni morte**, senza un chiamante nemmeno dentro `lan.ts`: cancellate invece che migrate.
`lastOctet` passa da `parseIp` e resta IPv4-only, con il perché scritto sopra.

Il test nuovo ha richiesto `// @vitest-environment jsdom`: le funzioni sono pure, ma `lan.ts` importa
`lib/ubus.ts`, che legge `sessionStorage` al caricamento del modulo.

### Tre punti in cui il piano si contraddiceva, e come sono stati risolti

Il filo comune: **allargare la validazione dove il valore va a finire in una scrittura ancora
mono-famiglia crea un guasto silenzioso**, cioè un campo che accetta un indirizzo e poi non funziona.
In tutti e tre i casi ha vinto la fase che descrive la scrittura, non la riga di riepilogo qui.

**1. I DNS annunciati ai dispositivi restano IPv4.** Il piano diceva di allargare `isValidIp` a
`Lan.tsx:782-783`, ma quel controllo copre *due* liste che finiscono in posti diversi, e la Fase 5 lo
dice già: `clientOne/clientTwo` vanno in `dhcp_option 6`, **un'opzione solo DHCPv4** in cui un
indirizzo v6 non annuncia niente e può far rifiutare a dnsmasq l'intera lista — rompendo anche i DNS
v4. Allargarla qui avrebbe introdotto esattamente la trappola che la Fase 5 descrive, prima che
esista `dhcp.lan.dns` che la risolve. Quindi: **client IPv4-only** (fino alla Fase 5),
**resolver del router allargati** (`dhcp.<sezione>.server`, che dnsmasq accetta in entrambe le
famiglie).

Di conseguenza `DnsChoice` ha una prop `ipv6` nuova, e non è cosmetica: i campi avevano
`inputMode="decimal"`, cioè un tastierino numerico **senza i due punti e senza lettere**. Sul campo
che ora accetta v6 sarebbe stato impossibile scrivere un indirizzo da telefono. Ogni lista dichiara
anche in chiaro cosa accetta.

**2. Le sonde mwan3 restano IPv4, e il messaggio tiene "IPv4".** Il piano voleva che il messaggio a
`MultiWan.tsx:738` perdesse la parola, ma quelle sonde sono i `track_ip` di interfacce mwan3 scritte
con `family='ipv4'`: mwan3 le controlla con un ping IPv4, e un indirizzo v6 lì dentro farebbe
risultare la WAN **sempre caduta**. La riga contraddice la decisione della Fase 9 ("fino alla Fase 8
compresa, mwan3 resta IPv4"), che è quella giusta. Validazione esplicita `isValidIp(ip, 4)`, messaggio
invariato.

**3. `isValidTarget` passa a `parseCidr` ma resta IPv4.** Il guadagno vero della riscrittura è quello
previsto — `/33` non passa più e il prefisso è validato sulla famiglia invece che su un massimo
scritto a mano — ma `ruleValues` (`mwan.ts:262`) scrive `family='ipv4'` su **ogni** regola: una regola
con `dest_ip` v6 verrebbe salvata e non combacerebbe mai. Il vincolo cade in Fase 9, insieme al resto.

**Da riportare in Fase 5 e Fase 9:** entrambe devono togliere il vincolo *e* il testo che lo annuncia
— il messaggio del campo DNS client, la prop `ipv6={false}`, il `4` in `isValidIp(ip, 4)` e quello in
`isValidTarget`. Sono quattro punti, tutti commentati sul posto con il nome della fase che li libera.

---

## Fase 3 — WAN dual-stack in lettura ✅ *(fatta il 2026-09-10)*

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
  **La Fase 0 ha confermato che i due casi convivono sullo stesso router**, quindi l'appaiamento sul
  `l3_device` non è prudenza ma necessità: `wan` ha un gemello statico `wan6` (`proto dhcpv6`,
  `device 'eth0'` letterale, in zona firewall), mentre `wwan_radio0/1` e `wan_usb` non ne hanno
  nessuno e, tolto `ipv6=0`, prenderanno un `<net>_6` dinamico. Nessuna regola sui soli nomi li
  copre entrambi. Attenzione al ripiego a interfaccia giù: qui il nome giusto è `wan6`, non `wan_6`.
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

### Esito

`tsc --noEmit` pulito, **329 test su 18 file** (20 nuovi), build a 230 kB. `sh -n` sull'rpcd e
`ucode -c` su `traveld.uc` — con l'interprete del router — passano entrambi.

**Correzione dopo la prima stesura: `up` e `l3_device` non bastava leggerli dalla v4.** La prima
versione emetteva entrambi dal solo `netstat` dell'interfaccia v4, e su una WAN v6-only quella è
*giù e senza device* — il lease DHCPv4 non arriva mai — mentre il gemello v6 è su e funziona. Il
risultato era che il caso per cui questa fase esiste restava classificato **"senza indirizzo" e
"inattivo"**: `up=false` mandava `uplinkState` su `no-address` a prescindere dagli indirizzi v6, e
`l3` vuoto rendeva impossibile il confronto con la rotta predefinita, quindi `active` era sempre
falso. Due righe di ripiego sul gemello, e `up` cambia significato: ora vuol dire **"almeno una
delle due famiglie è su"**, documentato sia sul campo `Uplink.up` sia accanto alle due letture.
Verificato sul router con lo scenario v6-only sintetico (`l3` → `eth0`, `up` → `true`,
`active` → `1`) e con un test dedicato.

**L'appaiamento è stato provato sul router**, contro un dump sintetico dato ad ash e jsonfilter veri,
perché oggi nessuna interfaccia ha IPv6 e il percorso non si eserciterebbe da solo. Cinque casi, tutti
verdi: gemello statico `wan6` appaiato sul device; gemello dinamico `wwan_radio1_6`, nome non
indovinabile; ripiego sul nome a interfaccia giù; nessun gemello → vuoto; e il fratello v4 che non
appaia se stesso. Verificato anche che `default_gateway "$v6stat" "0.0.0.0"` **non** restituisca
niente: è la riga che impedisce a un nexthop di finire nella famiglia sbagliata.

**Rumore su stderr:** le prime versioni ne aggiungevano 2 righe (jsonfilter su stato vuoto). Ora si
è tornati alla linea di partenza — 10 righe, tutte da punti preesistenti altrove — con una guardia in
`default_gateway` e i redirect mancanti.

### Il bug che è saltato fuori verificando: la netmask non è una netmask

`ubus` riporta `ipv4-address[0].mask` come **numero di bit** (`24`), non come maschera puntata, e
l'rpcd lo passava così com'è. Sul router vero:

```
{ "address": "192.168.0.91", "mask": 24 }   →   "netmask": "24"
```

`findConflicts` si aspetta `255.255.255.0`, e su `"24"` `subnetOfMask` risponde `null`: **la WAN
veniva saltata in silenzio e nessun conflitto è mai stato segnalato su un router vero.** Nel
simulatore funzionava, perché il mock scriveva la forma puntata — cioè il simulatore nascondeva il
guasto invece di mostrarlo. È un bug preesistente, non introdotto da IPv6: la vecchia `subnetOf`
faceva `ipToInt("24") → null` esattamente allo stesso modo.

Riconciliato **al confine**, in `withUplinkDefaults`, che è l'unico posto a vedere entrambe le forme
e anche i pacchetti vecchi. Il mock ora manda `'24'` come il router: un simulatore che semplifica
proprio la forma che il confine deve normalizzare non serve a niente.

### Scostamenti dal piano

- **`withIpv6Defaults()` si chiama `withUplinkDefaults()`.** Non riempie solo i campi v6: normalizza
  anche la netmask, e il nome vecchio avrebbe mentito.
- **Anche i DNS v4 ora filtrano gli indirizzi con i due punti.** Su una WAN `proto static` dual-stack
  `dns-server` può contenere entrambe le famiglie, e un resolver v6 sarebbe finito nella riga dei DNS
  v4. Una riga, e le due famiglie restano separate anche quando arrivano dalla stessa interfaccia.
- **Gli indirizzi v6 si leggono da entrambi gli stati**, non solo dal gemello: una WAN `proto static`
  configurata a mano li ha sulla propria interfaccia e di gemello non ne ha nessuno.
- **Le righe v6 nelle schermate compaiono solo se IPv6 c'è.** Quattro righe con un trattino su una
  rete v4-only direbbero che manca qualcosa, invece che "qui IPv6 non c'è".
- **`Connect.tsx` mostra il primo indirizzo v6** quando non c'è IPv4, gateway compreso: scrivere "IP"
  seguito dal vuoto farebbe sembrare rotta una connessione che funziona.

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

*Sbloccata: la risposta 1 della Fase 0 ha confermato che il kill switch è già dual-family.*

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
la `isValidIp` allargata — **già fatto in Fase 2**.

**Due vincoli della Fase 2 vanno tolti qui**, e vanno tolti insieme, perché il primo senza il secondo
lascia la schermata a dire il falso: in `Lan.tsx`, la validazione `isValidIp(clientOne, 4)` diventa
libera e la `<DnsChoice ipv6={false}>` della lista *client* diventa `ipv6`. Il testo del campo
("Solo indirizzi IPv4: ...") sparisce con loro. Nessuno dei due va toccato **prima** che
`dhcp.lan.dns` sia scritta davvero, altrimenti si riapre la trappola qui sopra. Le voci dei fornitori scrivono però **sempre entrambe le famiglie**, mai
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

**`vpn-setup.sh:18-63 enable_forwarding`** — **ridimensionata dalla Fase 0.** OpenWrt accende già
`net.ipv6.conf.all.forwarding=1` e `net.ipv6.conf.default.forwarding=1` in
`/etc/sysctl.d/10-default.conf`, e `sysctl` lo conferma a runtime. Aggiungere la riga v6 a
`30-travel-forwarding.conf` **ribadisce un default invece di cambiare stato**: la si scrive lo stesso,
per la stessa ragione per cui il file esiste in v4 (le interfacce nate fuori da netifd la mancano),
ma il commento deve dire che non è questo file ad accenderlo.

L'avvertenza che il piano portava qui — *l'inoltro globale fa smettere il kernel di accettare i
Router Advertisement, quindi la WAN non si autoconfigura e IPv6 muore* — descrive una condizione che
su questo dispositivo **esiste già, e non fa danno**: `accept_ra` è `0` su `eth0`, `phy0.0-sta0`,
`br-lan` e `default`, con l'inoltro a `1`, e IPv6 sulla LAN funziona (i client hanno indirizzi ULA).
Il motivo è che `proto dhcpv6` su OpenWrt è **odhcp6c in spazio utente**, che gli RA se li legge da
sé su socket raw e di `accept_ra` del kernel non ha bisogno.

**Quindi il controllo con `say "ATTENZIONE: ..."` non va scritto come previsto**: allarmerebbe su
ogni router sano. Decisione rinviata alla Fase 4, quando `wan6` sarà davvero su con un upstream v6:
se prende un indirizzo con `accept_ra=0`, il controllo si **toglie**, non si riscrive.

`iface_forwarding` (`:150-152`) guadagna il gemello v6 per `tailscale0` — lì serve davvero, perché
`tailscale0` nasce fuori da netifd e `.default.forwarding` vale solo per le interfacce create dopo
che il sysctl è stato applicato.

- **Zona `travel_vpn`**: `masq='1'` è solo IPv4 → aggiungere `masq6='1'`. Senza, l'indirizzo ULA di un
  client esce nel tailnet senza via di ritorno, e il sintomo è "alcune cose funzionano".
- **`travel_vpn_wg`** (`vpn-setup.sh:~494`, rpcd `:2874-2895`): il range v6 di Tailscale è
  `fd7a:115c:a1e0::/48`. Sezione **`travel_vpn_wg6`** gemella con `family='ipv6'`, scritta e commutata
  dalla stessa funzione — due sezioni esplicite e non una regola senza famiglia, perché la disciplina
  del file è "una sezione per cosa, sempre presente, commutata da `enabled`", e `src_ip` forzerebbe
  comunque la famiglia.
- **Kill switch**: ~~gemello `travel_killswitch6`~~ — **non serve, verificato in Fase 0.**
  `travel_killswitch` rende in `table inet fw4` senza `meta nfproto`, verso `reject_to_wan` che fw4
  stesso etichetta *reject wan IPv4/IPv6 traffic*. Nessun lavoro in questa fase. (Rende però solo
  `tcp` e `udp` — default di fw4 quando `proto` manca — quindi ICMP e ICMPv6 passano: buco
  preesistente in IPv4, fuori dal perimetro di questo piano, da decidere a parte.)
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
`"$endpoint_host:$endpoint_port"`, e senza parentesi ne uscirebbe `2001:db8::1:443`, che è un
indirizzo IPv6 valido e **diverso**. Il commento deve dirlo, o qualcuno lo "aggiusta".

*(Esempio corretto in Fase 1: con `51820` la giunzione dà una stringa **invalida** — cinque cifre non
sono un gruppo esadecimale — e il guasto si vede. Il caso silenzioso è una porta di al massimo
quattro cifre, che è anche un gruppo legale. Nel commento va quella.)*

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

**La Fase 0 dice quanta di questa fase è possibile:** `wan6` esiste già nell'immagine, quindi il
gemello mwan3 della WAN ethernet si può fare senza creare niente. `wwan_radio0/1` e `wan_usb`, no —
per loro andrebbero create sezioni `<wan>6` esplicite che oggi il piano non prevede. Se la fase si
fa, o si accetta che il failover v6 copra la **sola** WAN ethernet (e allora va scritto perché), o la
fase cresce di quel pezzo.

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

**Due vincoli della Fase 2 si sciolgono qui**, ed è questa fase a doverli togliere: `isValidTarget`
(`MultiWan.tsx:361`) smette di richiedere `family === 4` — la validazione su `parseCidr` c'è già — e
le sonde di tracking (`:673`, `isValidIp(ip, 4)`) si allargano **solo** dove esiste un gemello
`<wan>6` con un pool di tracking v6 suo; il messaggio "Serve almeno un indirizzo IPv4 valido" perde
la parola nello stesso momento, non prima. Se questa fase non si fa, i due vincoli restano — e sono
commentati sul posto proprio per questo.

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

- ~~**`net.ipv6.conf.all.forwarding=1` spegne IPv6**~~ e ~~**kill switch che perde IPv6**~~:
  **entrambi archiviati dalla Fase 0.** L'inoltro v6 è già un default di OpenWrt e IPv6 funziona lo
  stesso, perché odhcp6c legge gli RA in spazio utente; il kill switch è già dual-family.
- **`::/0` in tabella 53 senza `suppress_prefixlength`** ripete il blocco documentato a
  `vpn-setup.sh:262-267`, e in v6 è peggio: SSH su v4 continua a funzionare, quindi il router sembra
  a posto mentre ogni browser si pianta.
- **Router a metà aggiornamento** (UI nuova, pacchetto vecchio): ogni campo nuovo è riempito al
  confine, e nessun componente legge `lan.addresses6[0]` senza guardia.
- **GUA annunciata a Tailscale**: rotta stantia a ogni cambio di albergo. Solo ULA.
- **Le parentesi in `endpoint_host` sembrano un bug** e qualcuno le toglierà, reintroducendo
  `2001:db8::1:443`. Il commento deve dire che è netifd a fare la giunzione ingenua — e usare una
  porta di quattro cifre nell'esempio, perché è il caso che passa inosservato (vedi Fase 1).
