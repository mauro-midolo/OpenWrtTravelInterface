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
ferma ICMP**, e in v6 non ferma ICMPv6.

> **Correzione, dalla Fase 7.** Qui era scritto che è «un buco che esiste già in IPv4 e che IPv6 non
> peggiora». **Non è vero:** accendere IPv6 sulla LAN raddoppia le famiglie in cui quella perdita
> esiste, quindi IPv6 la peggiora. La stessa opzione mancante si è ripresentata in Fase 7 sulla
> regola d'uscita del tailnet, dove il verso era rovesciato — su un ACCEPT il `proto` mancante
> *blocca* invece di lasciar passare — ed è stata corretta lì. Sul kill switch resta aperta: fuori
> dal perimetro di questo piano, ma da decidere, e non da archiviare come innocua.

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

## Fase 4 — WAN dual-stack accese ✅ *(rifatta il 2026-09-10; verifica sul campo da fare)*

> **La premessa originale della fase era sbagliata.** `option ipv6 '0'` su una `proto dhcp` non fa
> niente su OpenWrt 25.12: `/lib/netifd/proto/dhcp.sh` non nomina `ipv6` da nessuna parte, e nessuno
> script in `/lib/netifd/proto/` crea alias `<net>_6`. Toglierla è **inerte**. IPv6 su una WAN si
> accende in un modo solo, con una **`config interface '<net>6'` esplicita** — quella che l'immagine
> di fabbrica porta già per `wan`. La fase è stata riscritta di conseguenza; il racconto di come si è
> scoperto sta in «Cosa è successo davvero sul router».

**Come è fatta adesso.** Due blocchi in `setup.sh`, in due punti diversi del file:

1. La migrazione `travel.globals.ipv6_init`, che **resta** dov'era: toglie un'opzione morta, e
   lasciarla scritta suggerirebbe al prossimo lettore che serva a qualcosa.
2. Un ciclo sulle reti della zona firewall `wan` che, per ogni WAN `proto dhcp` **senza** gemella,
   crea `<net>6` con `proto dhcpv6` e `device '@<net>'`, la aggiunge alla zona firewall, e **riallinea
   la metrica a quella della sorella v4 a ogni giro**.

`device '@<net>'` e non il nome del device: per una STA WiFi il device in uci non c'è affatto — glielo
assegna la sezione wireless — e cambia a ogni riassociazione. Il riferimento simbolico segue la
sorella v4 dovunque vada.

**Il ciclo sta dopo `sh mwan3-setup.sh`, e non è un dettaglio di ordinamento.** Le metriche delle WAN
v4 le assegna quello script (`mwan3-setup.sh:99-105`), e su un'installazione nuova prima del suo giro
**non esistono**. Messo più in alto — dov'era nella prima stesura — ogni gemella nasceva con
`metric=0`: tutte uguali, tutte "migliori", e siccome le sezioni si creano una volta sola quel valore
sbagliato non lo avrebbe corretto più nessuno. Esattamente il guasto che la metrica copiata doveva
evitare, cioè v4 e v6 che escono da WAN diverse e «metà del web carica».

Due conseguenze di quello spostamento, entrambe necessarie:

- **La metrica si riallinea a ogni esecuzione**, non solo alla creazione. Riordinare le priorità
  delle WAN dall'interfaccia riscrive le metriche v4, e una gemella rimasta indietro spezzerebbe la
  coppia. Vale anche per il `wan6` dell'immagine, che nasce con metrica `0`: quella non è una
  preferenza dell'utente, è la metà v6 di una coppia.
- **Il ciclo ha i suoi `NEED_IPV6_*_RELOAD` e la sua ricarica in fondo**, perché gira *dopo* il
  blocco che ricarica rete e firewall (`setup.sh:464-469`). Riusare i `NEED_*` di sopra non avrebbe
  ricaricato niente — sono già stati letti — e avrebbe fatto credere al lettore successivo che quel
  reload copra anche questa parte.
- **La lettura della metrica vuole `|| true`**, ed è l'idioma che il file già documenta a `:334-336`:
  con `set -e` (`setup.sh:8`) un'assegnazione da un'opzione che non c'è ferma tutto lo script. Qui il
  caso non è teorico: `mwan3-setup.sh` esce a `:28` **prima di assegnare qualunque metrica** quando
  mwan3 non è installabile perché manca Internet — e lo dice, promettendo che «tutto il resto
  funziona». Senza la guardia, `setup.sh` sarebbe morto proprio lì, saltando `vpn-setup.sh`, l'avvio
  di travelD e il riavvio di rpcd. La prima installazione di un router senza Internet, cioè il caso
  peggiore possibile.

Si crea **solo se manca**: il `wan6` dell'immagine resta intatto, e chi vuole IPv6 spento su una WAN
mette `disabled 1` sulla sua `<net>6` — che sopravvive, mentre cancellarla la farebbe solo ricreare.
`stageEthPort` fa lo stesso per le porte create dall'interfaccia, così una porta nuova non nasce
IPv4-only.

Togliere `ipv6=0` da `setup.sh:160,194,230` e da `lan.ts:616` (`stageEthPort`).

Migrazione una tantum in `setup.sh`, col pattern esistente (`travel.globals.eth_roles_init:118/179`,
`dhcp_hostname_init:256/266`, `saved_bands_init:292/385`): sotto marcatore
`travel.globals.ipv6_init`, **cancellare** `network.<wan>.ipv6` su ogni rete della zona firewall
`wan`. Cancellare e non scrivere `1`: si torna al default di OpenWrt invece di imporre un valore, ed
è la stessa distinzione di `macaddr` in `stageEthMac`.

**Nuovo test shell `ipv6-migration.test.ts`**, nello stile di `toggle-ap.test.ts` (script veri, `uci`
simulato, Git Bash su Windows): installazione nuova, aggiornamento, **seconda esecuzione che non
tocca niente**, e un utente che rimette `ipv6=0` dopo il marcatore se lo tiene.

### Esito

I tre `uci set ... ipv6=0` di `setup.sh` e quello di `stageEthPort` sono spariti — non sostituiti da
`ipv6=1`: l'opzione non si scrive affatto, perché nessuno la legge. Il blocco
`travel.globals.ipv6_init` sta accanto al gemello `dhcp_hostname_init`, che è il pattern che imita.

`tsc --noEmit` pulito, **352 test su 20 file** (23 nuovi), build a 231 kB, `sh -n` su `setup.sh`.

Il test **estrae i due blocchi dal `setup.sh` vero** invece di ricopiarli: se qualcuno li riscrive, il
test legge la riscrittura, e se il ciclo delle gemelle diventasse ambiguo l'estrazione fallisce invece
di prendere quello sbagliato in silenzio.

Sulla migrazione: aggiornamento, installazione nuova (niente da cancellare, e soprattutto **nessun
reload chiesto per un lavoro non fatto** — un `network reload` inutile fa cadere chi è collegato),
seconda esecuzione, utente che rimette `ipv6=0` dopo il marcatore, verifica esplicita che `1` non
venga mai scritto, rete nominata nella zona ma inesistente, e — il test che tiene ferma la lezione —
**che da sola non crei nessuna `<net>6`**, cioè che non accenda niente.

Sulle gemelle: una per WAN con `proto dhcpv6` e `device '@<net>'`, l'ingresso nella zona firewall, la
metrica copiata, la **gemella della gemella che non nasce** (senza il filtro sul proto uscirebbe un
`wan66`, e al giro dopo un `wan666`), la seconda esecuzione che non tocca niente, e una gemella
esistente — il `wan6` di fabbrica, o una con `disabled 1` — lasciata intatta.

Sulla metrica e sull'ordine, dopo la correzione: che **senza metrica v4 non ne inventi una** (meglio
nessuna che una sbagliata e definitiva), che il riallineamento avvenga quando la sorella cambia, che
tocchi anche il `wan6` a metrica `0`, che a metrica già allineata **non chieda nessun reload**, e —
il test che rende irrilevanti gli altri — che **il ciclo stia dopo `mwan3-setup.sh` dentro il file**.
Quest'ultimo è stato provato al contrario, invertendo davvero i due blocchi: fallisce con
`expected 620 to be greater than 700`.

Il runner controlla **entrambe** le coppie di contatori, `NEED_*` e `NEED_IPV6_*`, così un flag
scritto in quella sbagliata — che non ricaricherebbe niente — si vede invece di passare inosservato.

**E gira sotto `set -e`, come lo script vero.** Non c'era, e senza di esso il test viveva in un mondo
più clemente di quello reale: l'assegnazione della metrica su un'opzione assente lasciava
tranquillamente la variabile vuota invece di uccidere lo script. Aggiungendolo, **tutti e sei** i
test sulle gemelle sono passati da verdi a rossi con `expected 1 to be +0` — cioè il difetto c'era da
subito e il test non poteva vederlo. Il controllo sull'uscita a zero vale ora per ogni chiamata, ed è
il vero contenuto del test «senza nessuna metrica non interrompe il setup».

*Lezione, più generale di questa fase:* un test che esegue pezzi di uno script deve riprodurne anche
le opzioni di shell, non solo il testo.

Lo stub di `uci` confronta le chiavi con `awk` e non con una regex di `sed`: le chiavi contengono
`@zone[1]`, e `sed` interpreterebbe `[1]` come una classe di caratteri senza trovare niente.

### Cosa è successo davvero sul router

Deploy eseguito e `setup.sh` lanciato. **La migrazione ha funzionato come scritto**: le quattro
opzioni cancellate, `wan6` saltata perché non ne aveva, marcatore a `1`, nessuna modifica pendente.

**Ma IPv6 non si è acceso**, e non per un errore di esecuzione: `ubus call network.interface dump`
non mostra nessun `wwan_radio0_6`, non gira nessun `odhcp6c`, non c'è nessuna rotta predefinita v6 e
`ping6` risponde *Network unreachable*. La ragione, verificata sul router:

```
grep -n ipv6 /lib/netifd/proto/dhcp.sh      → nessuna riga
grep -rn "_6" /lib/netifd/proto/*.sh        → nessuna riga
```

Il proto `dhcp` di netifd **non legge affatto** l'opzione `ipv6`, e nessuno script di protocollo crea
alias `<net>_6`. Su questo OpenWrt IPv6 su una WAN si ottiene in un modo solo: una **`config
interface '<net>6'` esplicita con `proto dhcpv6`** — esattamente quella che l'immagine GL.iNet
fornisce per `wan`, e che la Fase 0 aveva trovato senza che se ne cogliesse il significato. Quel
`wan6` non è una particolarità dell'immagine: è *l'unico meccanismo esistente*.

**Ricadute sulle fasi già fatte:**

- **Fase 4 va rifatta.** Cancellare `ipv6=0` è innocuo ma non basta: servono sezioni `<net>6`
  (`proto dhcpv6`, device della WAN) create per ogni WAN e aggiunte alla zona firewall `wan`. La
  migrazione attuale può restare — toglie un'opzione morta — ma non è la fase.
- **Fase 3 regge, con una correzione al commento.** L'appaiamento sul `l3_device` resta quello
  giusto, e anzi diventa l'unico possibile; ma il caso «`<net>_6` dinamica creata da netifd»
  **non esiste su questa piattaforma**. Il ripiego sul nome `${net}_6` è innocuo e non combacerà mai,
  mentre `${net}6` è il caso vero.
- **Fase 9 diventa più fattibile di quanto scritto**, non meno: se ogni WAN ha già la sua `<net>6`
  esplicita, il gemello mwan3 è possibile per tutte e non solo per `wan`.

**L'interruzione di Internet.** `setup.sh` ha chiesto un `network reload` (`NEED_NETWORK_RELOAD=1`,
di suo progetto quando tocca la rete): netifd ha riavviato la STA WiFi, che si è riassociata e ha
preso un lease nuovo (`192.168.0.91` → `192.168.0.87`). Nella finestra fra i due la LAN è rimasta
senza uscita. Si è ripreso da sola — uplink su e stabile, 5 ping su 5, e la macchina in LAN naviga —
ma **il costo è stato pagato per un cambiamento che non ha alcun effetto**, ed è la ragione per cui
questa scoperta va scritta qui e non lasciata al prossimo giro.

### Verifica sul router: com'era pianificata

La migrazione è stata provata **in sola lettura** contro la configurazione vera di
`192.168.10.1`, simulando cosa farebbe:

```
marcatore travel.globals.ipv6_init: assente  → la migrazione partirebbe
  wan          → cancellerebbe ipv6=0
  wan6         → già a posto, non tocca      (il gemello statico non ha l'opzione)
  wwan_radio0  → cancellerebbe ipv6=0
  wwan_radio1  → cancellerebbe ipv6=0
  wan_usb      → cancellerebbe ipv6=0
```

Dei tre controlli previsti, il primo è passato (`uci -q get network.wan.ipv6` non esiste più); il
secondo — `ubus call network.interface.wan status` con un `ipv6-address` non vuoto — **è fallito**,
ed è quello che ha portato alla scoperta qui sopra. Il terzo, la riesecuzione che non tocca niente,
resta coperto da `ipv6-migration.test.ts`.

**Aggiornamento: la fase è stata verificata sul router.** Il `setup.sh` corretto — con il ciclo dopo
`mwan3-setup.sh` e il `|| true` sulla metrica — è stato installato ed eseguito, e ha fatto
esattamente quel che doveva:

```
  wan=[10]          wan6=[10]          device6=[eth0]
  wwan_radio0=[30]  wwan_radio06=[30]  device6=[@wwan_radio0]
  wwan_radio1=[20]  wwan_radio16=[20]  device6=[@wwan_radio1]
  wan_usb=[40]      wan_usb6=[40]      device6=[@wan_usb]

zona wan: wan wan6 wwan_radio0 wwan_radio1 wan_usb wwan_radio06 wwan_radio16 wan_usb6
```

Le quattro metriche sono **allineate a coppie**, il che dimostra sul campo sia l'ordine dentro
`setup.sh` sia il riallineamento: il `wan6` dell'immagine è passato da `0` a `10`, come previsto, e la
sua `device='eth0'` originale non è stata toccata. Tutte e quattro le gemelle sono in zona firewall.

Resta da verificare **solo** che una WAN v6 prenda davvero un indirizzo, e per quello serve un
upstream che offra IPv6.

**Attenzione a cosa può dire la prova.** La rete a monte di questo router (`192.168.0.1`) potrebbe
non offrire IPv6 affatto: in quel caso le `<net>6` si alzeranno senza prendere niente, e non si
saprà distinguere «il codice non funziona» da «non c'è IPv6 da prendere». Un controllo preliminare —
un `wan6` su cavo verso una linea con IPv6, o un tethering su rete mobile — vale più della prova
stessa.

**La domanda della Fase 0 resta aperta.** Se `accept_ra=0` basti perché una WAN v6 si autoconfiguri
non è ancora verificabile: nessuna WAN v6 è mai salita. Si potrà rispondere solo dopo che le sezioni
`<net>6` esisteranno davvero — e serve un upstream che IPv6 lo offra, cosa che la rete a monte
(`192.168.0.1`) potrebbe non fare.

### Bug trovato in `traveld.uc` — fuori piano, ma grave

Controllando il router è emerso che il daemon interrompeva **ogni** giro di controllo:

```
"last_error": "giro di controllo interrotto: access to undeclared variable applyHostname"
```

**ucode non fa hoisting delle dichiarazioni di funzione.** Verificato sul router con un caso minimo,
che produce lo stesso messaggio parola per parola. In `applyConnection` c'erano due chiamate a
funzioni scritte più in basso — `applyHostname` (usata a `:309`, dichiarata a `:339`) e `penaltyKey`
(`:326` / `:388`) — ed è **preesistente**: c'era già prima della Fase 0.

Il punto in cui capitava è quel che lo rende serio: `applyConnection` scriveva la sezione STA,
faceva `commit`, e moriva sulla riga dopo — **prima di `wifi up`**. La radio non veniva mai alzata,
`radioBusyUntil` e `lastAction` non venivano mai aggiornati, e la funzione non tornava mai `true`. La
riconnessione automatica era rotta per intero.

Le due dichiarazioni sono state spostate sopra `applyConnection`. **Andavano corrette insieme**:
`penaltyKey` sta più in basso di `applyHostname` nel corpo della funzione, quindi sistemare solo la
prima avrebbe spostato il guasto di diciassette righe facendolo sembrare risolto.

**Nuovo test `traveld-order.test.ts`**, che è il vero rimedio: `ucode -c` compila senza lamentarsi
perché l'errore è a runtime, quindi un controllo statico è l'unico modo di accorgersene prima del
router. Cerca ogni funzione usata prima della riga in cui è dichiarata, sa distinguere i commenti e i
metodi omonimi di un oggetto, e verifica su un campione sintetico di saper trovare il difetto che
cerca. Provato contro la versione precedente del file: segnala entrambi i casi, con le righe esatte.

### Bug trovato in `tools/deploy.ps1`

Il deploy è fallito con `tar: invalid magic`. Il tar in locale è integro e misura **179410** byte,
quello arrivato sul router **179413**: tre byte in più, cioè un **BOM UTF-8** che lo `StreamWriter`
di `$proc.StandardInput` antepone allo stream binario prima della `CopyTo` su `.BaseStream`
(`deploy.ps1:99-113`). Non c'entra con IPv6 ed è indipendente da questo piano, ma **il deploy da
PowerShell è rotto** finché non viene sistemato. Aggirato trasferendo il tar con
`cat file | ssh root@router 'cat > ...'`, che è binario-sicuro.

---

## Fase 5 — LAN IPv6 ✅ *(fatta il 2026-09-10)*

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

**~~Due vincoli della Fase 2 vanno tolti qui~~ — fatto**, e vanno tolti insieme, perché il primo senza il secondo
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

### Esito

`tsc --noEmit` pulito, **393 test su 22 file** (41 nuovi), build a 234 kB, `sh -n` sull'rpcd.
`method_lan` è stato provato **sul router vero**, e restituisce:

```json
"addresses6": ["fd66:67c3:698b::1/60"],  "ula": "fd66:67c3:698b::/48",
"ra": "server",  "dhcpv6": "server",  "ra_slaac": "",  "ra_default": "",
"ra_flags": ["managed-config", "other-config"],  "dns_client6": []
```

**La lettura conferma perché `ipv6-prefix-assignment` era la scelta giusta**: su questo router
`ipv6-address` è **vuoto** — non c'è upstream v6 — mentre l'assegnazione c'è, e da lì esce l'unico
indirizzo v6 che la LAN ha davvero. Leggere solo `ipv6-address`, che è la cosa che verrebbe naturale,
avrebbe mostrato una LAN senza IPv6 mentre i client ne hanno uno e comunicano.

E conferma anche la nota della Fase 0: `ra_slaac` e `ra_default` sono **assenti**, non vuote. Per
questo `matchRaMode` tratta l'assenza come `1` — altrimenti avrebbe risposto `'custom'` sulla
configurazione più comune che esista, cioè un router OpenWrt appena installato.

**ACL verificato, non assunto:** `acl.d/travel.json:19` ha già `dhcp` in scrittura. Niente da
toccare, come previsto.

### Scelte prese qui, non nel piano

- **`raValues()` è la sola funzione che sa cosa scrive ogni modalità**, e `matchRaMode` la rilegge
  invece di avere una tabella propria. Due copie della tabella sono il modo in cui scrittura e
  rilettura si disallineano: si salverebbe una combinazione che poi non viene più riconosciuta, e la
  schermata direbbe «Personalizzato» subito dopo aver salvato. Un test verifica il giro completo per
  tutte e tre.
- **«Spento» non guarda i flag.** Senza RA non si annuncia niente comunque, e pretenderli vuoti
  avrebbe mostrato «Personalizzato» su un router spento che si porta dietro i flag di prima.
- **`resolveDns` ora divide per famiglia** invece di restituire una lista sola: i v4 vanno in
  `dhcp_option`, i v6 in `dhcp.lan.dns`. Nei campi liberi la divisione si fa su cosa è stato
  scritto, così due caselle bastano per una coppia mista.
- **`matchDnsProvider` filtra la lista ai soli v4 prima di confrontare.** I resolver del router
  stanno in una lista unica con entrambe le famiglie: confrontarla intera non avrebbe combaciato con
  nessun fornitore, che di v4 ne dichiara due. È il round-trip di «scegli Cloudflare, salva,
  riapri».
- **Il `verify` di `useApply` controlla anche la modalità RA.** È una scrittura su `dhcp` e non su
  `network`, quindi può fallire per conto suo mentre l'indirizzo prende: senza il controllo la
  conferma direbbe di sì a metà del lavoro.
- **`clientDns(lan)` unisce le due metà prima di costruire lo stato della schermata.** È la
  correzione di un difetto che la prima stesura aveva: vedi qui sotto.

### Il difetto della prima stesura: aprire la schermata cancellava i DNS IPv6

Dividere le due famiglie in due opzioni uci ha creato un modo nuovo di perdere dati, e la prima
stesura ci è caduta. Lo stato della schermata si costruiva sulla **sola** `dns_client`, cioè la metà
v4:

```
dhcp_option 6  →  (vuota)          matchDnsProvider(dns_client) → 'auto'
dhcp.lan.dns   →  2606:4700:...    ...cioè "nessun DNS scelto"
```

Un router con i DNS v6 configurati — da LuCI, o da un salvataggio precedente — risultava in modalità
«Automatico». E siccome il salvataggio riscrive **entrambe** le opzioni, bastava salvare qualunque
altra cosa — spostare il pool DHCP, cambiare l'indirizzo — per cancellarli, senza che niente lo
dicesse.

La causa è che le due famiglie sono due opzioni uci ma **una scelta sola** nell'interfaccia: la metà
non letta resta fuori dallo stato, e il salvataggio la sovrascrive con il vuoto. `clientDns()` le
unisce, e sia la modalità sia i due campi liberi si costruiscono da lì — così una coppia mista fa il
giro completo e risalvare senza toccare niente riscrive esattamente quello che c'era.

Cinque test nuovi in `lan-dns.test.ts`, fra cui quello che **scrive il difetto per esteso**: afferma
che la lettura della sola v4 risponde `'auto'` e che quella unita risponde `'custom'`, perché è
l'unica differenza fra conservare quei DNS e cancellarli.

*Nota per le fasi che verranno:* ogni volta che un dato v6 finisce in un'opzione uci separata dalla
sua controparte v4, la schermata che le scrive deve leggerle **entrambe**, o la scrittura cancella
quella che non ha letto.

### Il residuo: due campi non contengono quattro indirizzi

Unire le due metà risolveva il caso «v6 senza v4», ma non tutto: i campi liberi sono **due**, mentre
la lista unita può arrivare a quattro. Con `dns_client` di due indirizzi scelti a mano più un
`dns_client6`, la lista ha tre voci — i campi ne mostrano due, la terza cade fuori, e il salvataggio
riscrive la lista troncata.

Il troncamento **esisteva già in IPv4** — tre resolver scelti a mano si comportavano così da sempre —
ma serviva configurarli a mano; dividere le famiglie lo ha reso il caso normale.

La cura non è aggiungere campi, è `dnsEditable()`: una lista che non corrisponde a nessun fornitore e
non entra in due campi **non si modifica da questa schermata**. Si mostra intera, e il salvataggio
passa `null` — che in `LanSettings` significa *non toccare*. È la stessa regola già adottata poche
righe sopra per la modalità RA che non si riconosce, e vale ora per entrambi gli elenchi, compreso
quello dei resolver del router: chiude anche il troncamento IPv4 preesistente.

Un fornitore riconosciuto resta sempre modificabile, per lunga che sia la lista: lì le quattro voci
non sono un dato da conservare, sono la definizione della scelta.

Sei test nuovi, fra cui quello che verifica che con una lista da tre voci **nessuna delle due opzioni
venga scritta né cancellata**.

### E la coda di quella cura: un elenco intoccabile che spegneva il pulsante Salva

Rendere un elenco non modificabile ha creato un terzo difetto, in un punto che sembrava estraneo: la
convalida `dnsOk` continuava a girare sui campi **non più mostrati**. Un elenco che la schermata
espone e non tocca spegneva quindi il pulsante Salva dell'**intera** rete locale — indirizzo e pool
DHCP compresi — e non c'era nessun campo dove sistemare il valore che non passava.

Il caso è reale, non un valore inventato: `dhcp.<sezione>.server` accetta forme che indirizzi non
sono, per esempio `/example.com/192.168.1.1` per mandare un dominio a un resolver dedicato. È
configurazione legittima, `isValidIp` la rifiuta, e con tre voci l'elenco diventa non modificabile.

`dnsFieldsOk(editable, mode, one, two)` risponde `true` quando i campi non si possono modificare:
**quello che non si scrive non può bloccare il salvataggio**. Quattro test, fra cui quello che verifica
che la convalida continui invece a valere quando i campi ci sono davvero.

*Terzo giro sullo stesso punto, e vale la pena dirlo:* ogni volta che si toglie qualcosa
dall'interfaccia — un campo, un elenco, una scelta — va tolto **anche** da tutto ciò che lo
presupponeva ancora presente: la scrittura, la convalida, lo stato. Qui la scrittura era stata
sistemata e la convalida no.

### I due vincoli della Fase 2, sciolti

Il campo dei **DNS annunciati ai dispositivi** accetta ora entrambe le famiglie (`isValidIp` senza
`4`, `<DnsChoice ipv6>`), perché ora esiste il posto dove metterli. Il testo del campo è cambiato di
conseguenza: non più «Solo indirizzi IPv4…» ma «anche uno per tipo: vanno al posto giusto da soli».
Restano da sciogliere solo i due della Fase 9, che dipendono da mwan3.

---

## Fase 6 — Dispositivi collegati ✅ *(fatta il 2026-09-10)*

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

### Esito

`tsc --noEmit` pulito, **405 test su 23 file** (12 nuovi), build a 235 kB, `sh -n` sull'rpcd.
`method_clients` è stato provato **sul router vero**, con tre dispositivi in LAN:

```json
{ "mac": "26:50:b7:ed:38:81", "ip": "192.168.10.205", "name": "Pixel-6-Pro",
  "ips6": [ "fd66:...:f90e:be6c", "fd66:...:4e69:5684", "fd66:...:6821:9805" ] }
```

**Il telefono ha tre indirizzi v6 globali contemporaneamente** — estensioni di privacy — e li ha
*davvero*, non in un caso costruito. È la prova sul campo della scelta di contarli invece di
elencarli: una riga con tre indirizzi lunghi più il v4 più il MAC non si legge. I `fe80::` non
compaiono, e la riga `FAILED` presente nella tabella dei vicini viene scartata.

### Dettagli decisi qui

- **`ip -4 neigh` esplicito.** La forma senza famiglia elenca anche i vicini v6, e a non farli
  entrare era soltanto la classe `[0-9.]` del sed. Dirlo al comando rende visibile che le letture
  sono due, e che quella è la v4. La v6 ha il suo sed, che distingue l'indirizzo dal MAC
  pretendendo un `:` **e** l'ancoraggio a inizio riga: allargare la classe di un sed solo avrebbe
  fatto combaciare il MAC come indirizzo, perché di quegli stessi caratteri è fatto.
- **Un passaggio in più sui soli vicini v6.** Un dispositivo v6-only non ha né lease DHCPv4 né voce
  ARP: senza, sparirebbe dall'elenco pur essendo in rete. Qui il link-local conta — come indirizzo da
  mostrare non vale niente, come prova di presenza vale tutto — ed è per questo che `fe80::` viene
  scartato al momento di emettere e non al momento di leggere. Sorgente nuova: `neigh6`.
- **`withClientDefaults` ordina anche `ips6`.** `ip neigh` li elenca nell'ordine in cui il kernel se
  li ritrova, che cambia fra una lettura e l'altra: senza ordinarli, il «primo indirizzo v6» mostrato
  per un dispositivo v6-only ballerebbe a ogni aggiornamento della schermata.
- **`clientAddress()` nuova**, perché «l'indirizzo del dispositivo» serviva in tre punti — titolo,
  dettaglio, ordinamento — e le tre definizioni sarebbero divergute.
- **Il conteggio non conta due volte.** Senza IPv4 il primo v6 fa da indirizzo principale, quindi gli
  «altri» sono `length - 1`: un dispositivo con tre indirizzi mostra `+2 IPv6`, non `+3`.

### Il commento sul lease file, esteso

Il rifiuto di analizzare `/tmp/odhcpd.leases` resta, e ora porta con sé la prova raccolta in Fase 0:
un DUID **non** è un MAC. Quelli di tipo `0001` (DUID-LLT) il MAC ce l'hanno in coda, quindi
l'estrazione *sembra* funzionare sul primo dispositivo che si guarda; ma il tipo `0004` (DUID-UUID) —
quello che questo stesso router usa per sé, in `network.globals.dhcp_default_duid` — di MAC non ne
contiene nessuno. Chi scrivesse quell'unione la vedrebbe funzionare in laboratorio e fallire in
albergo. È scritto per esteso nel codice, perché è esattamente il genere di scorciatoia che il
prossimo lettore troverebbe ragionevole.

---

## Fase 7 — Firewall, inoltro e VPN ✅ *(fatta il 2026-09-10)*

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

### Esito

`tsc --noEmit` pulito, **412 test su 24 file** (7 nuovi), build a 235 kB, `sh -n` su rpcd e
`vpn-setup.sh`. `method_vpn` provato **sul router vero**:

```
"lan_cidr": "192.168.10.0/24",  "lan_cidr6": "fd66:67c3:698b::/60"
```

**Il filtro ULA è stato provato a parte**, con sei payload sintetici dati alla funzione vera su ash e
jsonfilter del router — perché sul dispositivo non c'è nessuna GUA, e il ramo che conta non si
sarebbe esercitato da solo:

| caso | risposta |
|---|---|
| solo ULA | `fd66:67c3:698b::/60` |
| **solo GUA delegata** | **vuoto** — non la annuncia |
| GUA prima, ULA dopo | sceglie l'ULA |
| `fc00::` (l'altra metà di `fc00::/7`) | accettato |
| nessuna assegnazione | vuoto |
| maiuscole | accettato |

### L'avviso su `accept_ra` non è stato scritto, ed è la decisione della fase

Il piano prevedeva un controllo con `say "ATTENZIONE: ..."` sulle WAN che non avessero `accept_ra=2`.
**Non c'è**, e al suo posto c'è un commento che spiega perché non ci sarà. La regola del kernel dice
davvero che `accept_ra=1` significa «accetta gli RA solo se non inoltro», ma su OpenWrt le WAN v6 le
gestisce **odhcp6c in spazio utente**, che gli RA se li legge da sé su socket raw e di `accept_ra`
non ha bisogno: sul dispositivo vale `0` su tutte le interfacce, con l'inoltro a `1` e IPv6 che
funziona. Quel controllo avrebbe allarmato su ogni router sano.

La Fase 4 doveva confermarlo osservando una WAN v6 davvero su, e non ha potuto — nessuna è mai
salita. La decisione si regge quindi sul meccanismo, non sull'osservazione, e questo è scritto nel
codice.

### Dettagli decisi qui

- **`masq6` sta fuori dal blocco di creazione della zona**, così arriva anche sui router dove la
  zona `travel_vpn` esiste da prima. È idempotente. Senza, l'indirizzo ULA di un client uscirebbe nel
  tailnet senza via di ritorno, e la zona *sembrerebbe* a posto: c'è, è configurata, e il traffico v6
  esce lo stesso — solo che non torna.
- **`enable_forwarding` scrive la riga v6 pur non essendo lei ad accenderla.** OpenWrt la mette già
  in `10-default.conf`; si scrive per la stessa ragione della riga v4, cioè le interfacce nate fuori
  da netifd, e il commento dice che ribadisce un default invece di cambiarlo. Nessun allarme sul v6:
  quello sul v4 resta perché lì il valore era davvero osservato a zero.
- **`ts_exit_wg_rule` si è spaccata in due**, con `ts_exit_wg_one` per la singola sezione. Le due
  famiglie si commutano **in una chiamata sola**: lasciarne accesa una e spenta l'altra è lo stato
  peggiore possibile, perché metà del traffico esce e metà viene rifiutata, e chi guarda vede
  «internet a tratti» invece di un guasto pulito.
- **`lan_cidr6` legge `ipv6-prefix-assignment`, non `network.globals.ula_prefix`.** Quello è il /48
  da cui il router pesca; questo è il prefisso davvero assegnato a `br-lan`. Annunciare più di quello
  che si instrada sarebbe un altro modo di creare un buco nero.

**Nuovo test `vpn-firewall.test.ts`**, che estrae le due funzioni dal plugin rpcd vero e le esegue
con `uci` simulato: le due sezioni con le due famiglie, accese insieme, spente insieme, nessun
cambiamento segnalato quando non ce n'è — chi chiama usa quella risposta per decidere se ricaricare
il firewall — e la gemella v6 creata su un router che ha solo la v4.

### La trappola del `proto` mancante, di nuovo

La prima stesura della gemella v6 non aveva `proto`, ed è **la stessa trappola trovata in Fase 0 sul
kill switch**: senza quell'opzione fw4 non accetta tutto, accetta `tcp udp`. Verificato sul router:

```
senza proto:  meta l4proto tcp ip saddr 100.64.0.0/10 ... jump accept_to_vpn
              meta l4proto udp ip saddr 100.64.0.0/10 ... jump accept_to_vpn
con proto=all:            ip saddr 100.64.0.0/10 ... jump accept_to_vpn
                          ip6 saddr fd7a:115c:a1e0::/48 ... jump accept_to_vpn
```

**Su una regola di ACCEPT il verso del guasto si rovescia**, e in IPv6 diventa serio. Quello che
restava fuori è ICMPv6, che porta il *Packet Too Big*; e siccome i router IPv6 **non frammentano**,
la scoperta della MTU del percorso è l'unico meccanismo esistente. Senza quei messaggi i pacchetti
grandi spariscono in silenzio — esattamente il guasto contro cui la zona mette `mtu_fix`, che però
limita la MSS del solo TCP e lascia UDP scoperto.

`proto='all'` su **entrambe** le gemelle, dentro i blocchi di creazione e con un allineamento
idempotente fuori, per le regole già scritte. Non toglie niente alla protezione: a decidere chi entra
restano `src_ip` e la coppia di zone, che non cambiano. La correzione tocca anche la regola IPv4,
che aveva lo stesso buco da sempre — lì costava un ping che non passa, non un buco nero.

> **Resta aperto, ed è la stessa opzione:** `travel_killswitch` non ha `proto`, quindi ferma `tcp` e
> `udp` e lascia passare ICMP e **ICMPv6**. Su una regola di REJECT è una perdita, non un blocco, e
> ora che la LAN ha IPv6 quella perdita esiste in due famiglie invece che in una. La Fase 0 l'aveva
> archiviata come «buco preesistente in IPv4 che IPv6 non peggiora»: **quella valutazione andrebbe
> rifatta**, perché IPv6 lo peggiora eccome. Fuori dal perimetro di questo piano, ma da decidere.

---

## Fase 8 — WireGuard IPv6 ✅ *(fatta il 2026-09-10)*

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

### Esito

`tsc --noEmit` pulito, **457 test su 26 file** (45 nuovi), build a 236 kB, `sh -n` su rpcd e
`vpn-setup.sh`. Le funzioni sono state provate **con l'ash del router**, non solo con Git Bash:

```
vpn.example.com:51820  -> host=[vpn.example.com]  port=[51820]
[2001:db8::1]:51820    -> host=[[2001:db8::1]]    port=[51820]
[2001:db8::1]          -> host=[[2001:db8::1]]    port=[51820]
2001:db8::1            -> host=[[2001:db8::1]]    port=[51820]   ← era host "2001:db8:" e porta "1"
```

E `method_wg_get` sul router, prima e dopo aver aggiunto (in staging, poi revertito) un AllowedIPs
v6 al profilo acceso:

```
"has_v6": false, "rule6": false, "route6": false     ← profilo v4-only: le due righe non compaiono
"has_v6": true,  "rule6": false, "route6": false     ← con ::/0: compaiono, e segnalano cosa manca
```

### Dettagli decisi qui

- **`valid_wg_addrs` è stata riscritta per famiglia**, con `wg_v6_form` a parte. La classe di
  caratteri unica di prima — `[0-9a-fA-F:.]+(/[0-9]{1,3})?` — accettava `::::::`, `::1::2`, `1:2:3:`
  e `10.0.0.0/999`: sono tutti caratteri leciti, in un ordine che indirizzo non è. E il prefisso ora
  si confronta con il massimo della **sua** famiglia: `/33` su IPv4 e `/129` su IPv6 sono errori
  quanto `/999`.
- **`valid_wg_host` rifiuta un IPv6 nudo**, e non è una svista: `wg_split_endpoint` lo mette sempre
  fra parentesi, quindi accettarlo significherebbe accettare uno stato che il resto del codice non
  produce. Lato browser invece `wgEndpointProblem` lo accetta — lì è la forma in cui lo si incolla
  da un `.conf`, e le parentesi gliele mette il router.
- **`wg_has_v6_routes` esiste in due copie**, una in `vpn-setup.sh` e una nell'rpcd
  (`wg_profile_has_v6`), e il commento lo dice: se le due divergessero, la schermata segnerebbe come
  mancante una regola che nessuno ha motivo di scrivere — o tacerebbe su una che manca davvero.
- **La prova di sicurezza v6 non è una copia della v4.** Il commento spiega perché lì conta di più:
  lo stesso errore in v6 lascia SSH-su-v4 funzionante, quindi il router *sembra* a posto mentre ogni
  browser che preferisce IPv6 si pianta. In v4 la sessione cadeva e ci si accorgeva subito.
- **Il campo Endpoint ha una validazione lato client**, che prima non aveva affatto: un endpoint
  sbagliato si scriveva, il tunnel si creava, e il guasto si scopriva solo dal log di netifd. Il
  messaggio prende il posto del suggerimento invece di aggiungersi — due righe sotto un campo si
  leggono come una sola, e si perde quella che conta.
- **Il default AllowedIPs resta `0.0.0.0/0`**, come previsto: un file che non lo dice è un file che a
  IPv6 non ha pensato, e indovinare `::/0` creerebbe un buco nero su ogni profilo del genere.

### Due difetti che la prima stesura aveva introdotti

**1. Il modulo non passa da `wg_split_endpoint`.** L'importazione da file sì; il salvataggio dal
modulo no, perché lì i campi arrivano già divisi dal browser. `wg_validate` chiamava quindi
`valid_wg_host` su quello che l'utente aveva scritto — e `valid_wg_host` rifiuta un IPv6 nudo, cioè
**esattamente la forma che il suggerimento sotto il campo dichiara di accettare** («anche senza
parentesi: le mette il router»). Il router rifiutava quello che il browser prometteva.

E se anche l'avesse accettato sarebbe stato peggio: l'indirizzo sarebbe finito in uci **senza
parentesi**, cioè con il bug che questa fase esiste per chiudere. `wg_normalize_host` mette le
parentesi prima di convalidare, e un test verifica che tutto ciò che normalizza, `valid_wg_host` poi
lo accetti.

**2. Le righe IPv6 cambiavano il verdetto su «il tunnel porta traffico».** `wgCarrying` fa `.every()`
sulla lista di `wgRoutingSteps`, e aggiungerci le due righe v6 significava che un profilo dual-stack
con l'instradamento v6 non ancora scritto risultava **non funzionante** — che è lo stato normale di
ogni router finché `vpn-setup.sh runtime` non viene rieseguito, ed è esattamente quello osservato sul
dispositivo (`has_v6: true, rule6: false, route6: false`).

Conta dove finisce quel verdetto: `killSwitchHasTunnel` lo usa per decidere se un tunnel c'è. Un «no»
lì direbbe a chi ha il tunnel su e Internet che funziona di non essere protetto da niente — che è
proprio ciò contro cui il commento di `wgCarrying` metteva in guardia.

Le due righe sono ora `advisory`: si mostrano, con un testo che dice cosa comporta la loro assenza
(«il traffico IPv6 esce dalla WAN in chiaro»), ma non entrano nel verdetto. **Una rotta v6 mancante
significa che una parte del traffico non passa dal tunnel, non che il tunnel non porta traffico** — e
quella perdita il kill switch la chiude comunque, perché la sua regola è dual-family (Fase 0).

*Nel passare, un terzo:* `wg_v6_form` accettava `::1:`, perché un `case` solo con
`*::|::*` guardava l'inizio e non tornava più a guardare la fine. I due estremi ora si controllano
separatamente.

**Nuovo test `wg-carrying.test.ts`**, che tiene ferma la distinzione: le righe v6 compaiono solo con
`has_v6`, sono marcate `advisory`, quelle IPv4 no; `wgCarrying` resta vero con la catena v6
incompleta e **falso se manca un anello IPv4** — perché il verdetto non doveva essere indebolito, solo
riportato a ciò che decide davvero.

---

## Fase 9 — mwan3 IPv6 ✅ *(fatta il 2026-09-10, benché opzionale)*

`mwan3.<interfaccia>` è **mono-famiglia** e il nome della sezione deve coincidere con quello
dell'interfaccia netifd: un gemello v6 richiede una `config interface '<wan>6'` reale
(`proto dhcpv6`, `device '@<wan>'`), perché una `wan_6` dinamica non è tracciabile in modo affidabile.

**La Fase 0 dice quanta di questa fase è possibile:** `wan6` esiste già nell'immagine, quindi il
gemello mwan3 della WAN ethernet si può fare senza creare niente. `wwan_radio0/1` e `wan_usb`, no —
per loro andrebbero create sezioni `<wan>6` esplicite che oggi il piano non prevede. Se la fase si
fa, o si accetta che il failover v6 copra la **sola** WAN ethernet (e allora va scritto perché), o la
fase cresce di quel pezzo.

> ~~**Fino alla Fase 8 compresa, mwan3 resta IPv4**~~ — *superato: la fase è stata fatta.* Il piano
> prevedeva che `family=ipv4` e `dest_ip=0.0.0.0/0` restassero, accettando un degrado noto: caduta la
> WAN primaria, odhcpd ritira il prefisso delegato, i client perdono la GUA e Happy Eyeballs ripiega
> su v4. Era un ripiego ragionevole, e non serve più: le sezioni `<net>6` che la Fase 4 ha creato
> rendono possibile il failover v6 vero, su tutte le WAN.

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

### Esito

`tsc --noEmit` pulito, **475 test su 27 file** (18 nuovi), build a 237 kB, `sh -n` su
`mwan3-setup.sh`. Sul router tutte e quattro le gemelle esistono già — le ha create la Fase 4 — quindi
la fase è realizzabile per **ogni** WAN e non solo per `wan`, che era il limite scritto qui sopra.

### `travel_failover6` non esiste, e non poteva esistere

```
travel_failover    15 caratteri   ← il massimo che mwan3 accetta
travel_fail6       12
travel_bal6        11
o6_wwan_radio0     14
```

mwan3 impone **15 caratteri** ai nomi delle politiche — è il limite dei nomi di catena di iptables —
e `travel_failover` li usa già tutti. `travel_failover6` ne farebbe 16 e verrebbe **rifiutata in
silenzio**: la politica non viene applicata e le regole che la usano non fanno niente, esattamente
come è già successo in questo progetto con `only_wwan_radio0`. Da qui `travel_fail6` e `travel_bal6`,
e un test che verifica la lunghezza invece di fidarsi.

Per lo stesso motivo il limite sulle politiche per WAN scende da 13 a **12** caratteri: il prefisso
IPv6 è di tre caratteri (`o6_`) invece di due, e `o6_wwan_radio0` è già a 14.

### «Nella stessa transazione o in nessuna»

La garanzia c'è, e viene dall'architettura invece che da un meccanismo nuovo: le scritture sono
`uci set` in staging, e **niente prende effetto finché `applyMwan()` non viene chiamata**. Chi chiama
la invoca dopo *tutte* le scritture, dentro lo stesso `try`: se una fallisce, l'apply non viene
raggiunto e non prende effetto niente. Le quattro scritture di una WAN stanno comunque adiacenti nello
stesso giro di ciclo, così una interruzione lascia al più una WAN disallineata in staging.

`setIfPresent()` salta le gemelle che non esistono: su un router non ancora aggiornato le sezioni
`<net>6` non ci sono, e trattarne l'assenza come un errore bloccherebbe una modifica IPv4 valida.
Due test coprono quel router.

### Il vincolo sui tracking IP NON si scioglie, e il piano diceva di sì

Qui sopra è scritto che le sonde si allargano e che il messaggio «Serve almeno un indirizzo IPv4
valido» perde la parola. **È sbagliato.** Quel campo scrive in `mwan3.<net>`, che è la sezione
`family=ipv4`: un indirizzo v6 lì dentro verrebbe pingato con `ping` e la WAN risulterebbe caduta per
sempre. Le sonde v6 stanno nella gemella `<net>6`, e le sceglie `mwan3-setup.sh` da un pool suo —
devono restare diverse fra le WAN, e non c'è niente da chiedere a chi guarda.

Quello che invece va condiviso sono i **tempi**: `setHealth` scrive intervallo, timeout, conteggi e
affidabilità su entrambe le sezioni. Sono la stessa decisione — ogni quanto controllare, dopo quanti
fallimenti dichiararla caduta — e tenerli diversi farebbe cadere le due famiglie in momenti diversi
sulla stessa WAN.

Si scioglie invece l'altro vincolo: **`isValidTarget` accetta ora entrambe le famiglie**, perché
`ruleValues` deduce la famiglia dai criteri invece di scrivere sempre `ipv4`.

### Quattro difetti della prima stesura, tutti la stessa forma

Tre erano **scritture di una famiglia sola** in punti che non avevo cercato, e uno era un nome
ambiguo. Il filo comune: aver reso dual-stack le funzioni che *sapevo* di dover toccare, senza
cercare tutti i posti che scrivono le stesse cose.

**1. Il nome delle politiche per WAN era ambiguo.** `o_<net>6` non si rilegge: una porta ethernet
chiamata `lan6` produce l'interfaccia `wan_lan6`, e `o_wan_lan6` non direbbe più se la WAN è
`wan_lan` in IPv6 o `wan_lan6` in IPv4. `parsePolicy` rispondeva quindi con una WAN che non esiste,
il modulo la caricava così, e al salvataggio scriveva **`o_wan_lan66`** — una politica inesistente,
cioè una regola che non fa niente. Il `6` è passato **in testa**: `o6_<net>`, `p6_<net>`. Un test
verifica il giro completo proprio su una WAN che finisce per `6`.

**2. `travel_default6` compariva fra le regole dell'utente.** L'rpcd filtrava solo `travel_default`.
Non sono regole dell'utente: sono la modalità multi-WAN vista da sotto, e mostrarle vuol dire poterle
cancellare — togliendo IPv6 dal failover senza che niente lo dica.

**3. e 4. La modalità veniva riportata su una sola predefinita**, in due punti diversi: quando
`mwan_apply` rifiuta il bilanciamento e lo riporta a failover, e quando si applica un profilo
salvato. In entrambi i casi IPv4 finiva su una politica e IPv6 restava sull'altra — precisamente il
guasto «metà del web carica» che questa fase esiste per evitare, e in uno dei due casi su un percorso
di *errore*, cioè quello in cui si guarda meno. Ora c'è `mwan_set_mode`, ed è l'unico posto che sa
come si scrive una modalità.

### `ruleFamily`, e cosa rifiuta

Una regola con `src_ip` v4 e `dest_ip` v6 non è scrivibile: `mwan3.<rule>.family` è un valore solo,
e scritta comunque uno dei due criteri non combacerebbe mai — una regola che non si applica, in
silenzio. `ruleFamily` risponde `null`, e `ruleValues` solleva **prima di scrivere qualunque cosa**:
un test verifica che dopo il rifiuto non ci sia nessuna scrittura in staging.

---

## Audit prima della chiusura — *(fatto il 2026-09-10)*

Passata sistematica sul codice cercando quello che le nove fasi non avevano toccato: comandi `ip`
senza famiglia esplicita, letterali IPv4, regex `[0-9.]`, decisioni prese sul solo `ipv4`. Ne sono
usciti **tre buchi veri**, due corretti e uno lasciato aperto con cognizione.

### 1. Tailscale non aveva instradamento IPv6 — corretto

Il buco più serio, e **l'ho lasciato io nella Fase 7**: lì è stata aggiunta la regola *firewall*
`travel_vpn_wg6` sul range v6 del tailnet, ma non la *rotta*. Verificato sul router:

```
ip -6 addr show tailscale0   → fd7a:115c:a1e0::ca2f:d005/128   ← il router E' sul tailnet in v6
ip -6 route show table 52    → (vuota)
ip -6 route get fd7a:115c:a1e0::1   → Network unreachable
```

Il router non raggiungeva **nessun** peer in IPv6, e le risposte a chi lo contattava di là non
avevano dove tornare: le regole v6 di mwan3 stanno a preferenze più basse di quella che tailscaled si
scrive da solo, quindi il traffico marcato sarebbe uscito dalla WAN. È **lo stesso guasto documentato
per IPv4** in `ensure_ts_route`, e la regola firewall della Fase 7 non aveva niente da lasciar
passare.

`ensure_ts_route` e `ensure_ts_rule` hanno ora la gemella v6. Provato sul dispositivo: scritta la
rotta, `ip -6 route get fd7a:115c:a1e0::1` risponde `dev tailscale0 table 52`, marcatura mwan3
compresa. Router riportato allo stato di prima.

### 2. La sonda di connettività era cieca su IPv6 — corretto

`travel_online()` provava solo `1.1.1.1 8.8.8.8 9.9.9.9`. Su un uplink **v6-only** — quello che la
Fase 3 ha insegnato a riconoscere come funzionante — avrebbe sempre risposto «niente Internet», e chi
la chiama (`setup.sh`, `vpn-setup.sh`, `mwan3-setup.sh`) avrebbe rinunciato a installare i pacchetti
su un router che Internet ce l'ha. Ora prova entrambe le famiglie, con gli IPv4 per primi perché sono
la maggioranza dei casi.

### 3. Il captive portal resta IPv4-only — **scelta, non dimenticanza**

`portal_resolve` (`rpcd:2333`) accetta solo risposte IPv4 dal DNS, e `portal_route_up` scrive la
tabella di servizio 97 con `ip route` senza gemella v6. Un portale raggiunto in IPv6 non verrebbe né
rilevato né aggirato.

**Si lascia così, e va scritto nella documentazione.** I captive portal sono un meccanismo IPv4 quasi
per definizione: intercettano il traffico con un DNS bugiardo e un redirect HTTP, e le reti che li
usano — alberghi, aeroporti, treni — distribuiscono IPv4. Costruire il gemello v6 alla cieca
significherebbe scrivere e mantenere un sotto-sistema intero senza un caso reale su cui provarlo, che
è il modo in cui si aggiunge codice che sembra funzionare. Se un giorno comparirà un portale v6, il
sintomo sarà chiaro — il portale non viene rilevato — e a quel punto ci sarà qualcosa su cui
verificare la cura.

### Quello che è IPv4-only di proposito, e resta

Verificato che sia ancora coerente: `findConflicts`, `suggestAddress`, `prefix24`, `lastOctet`,
`LAN_NETMASK`, `CANDIDATES` (decisione 2 del piano); il `filter(u => u.ipv4)` di `Lan.tsx`; i
tracking IP di mwan3 (Fase 9); il default `AllowedIPs = 0.0.0.0/0` di WireGuard (Fase 8).

### Una incoerenza minore, corretta

Su un uplink v6-only le schede WiFi e Dashboard scrivevano «Indirizzo: nessuno» sopra le righe che
mostravano un IPv6 funzionante. La riga ora si qualifica — «Indirizzo IPv4» — e mostra un trattino:
è la stessa correzione già fatta in `Connect.tsx` nella Fase 3, in due punti che erano sfuggiti.

---

## Fase 10 — Documentazione ✅ *(fatta il 2026-09-10)*

`docs/architettura.md` va riallineato: `:528-539` (multi-WAN IPv4, "non esiste una gestione completa
IPv6"), `:597-603` (LAN IPv4 /24), `:1247-1249` ("IPv6 gestito dall'app" fra le cose mancanti), più
`README.md:85`. Aggiungere una sezione IPv6 che scrive **la tabella delle modalità RA** e **la
distinzione fra `dhcp_option 6` e `dhcp.lan.dns`**: sono le due cose che si sbagliano rileggendo il
codice fra sei mesi. Se una fase introduce un'operazione di apply nuova, aggiornare la tabella dei
timeout a `:159-167`.

### Esito

**Nuova sezione `## IPv6` in `docs/architettura.md`** (~190 righe), con dentro le due cose che il
piano chiedeva per esteso — la tabella delle tre modalità RA, e la tabella che mette a confronto
`dhcp_option 6` e `dhcp.lan.dns` — più le WAN, il firewall, la VPN, WireGuard, mwan3 e un elenco
finale di *quello che resta IPv4-only di proposito*.

Riallineati: la sezione WAN/multi-WAN (non dice più «non esiste una gestione completa IPv6», e
spiega che le interfacce v6 restano fuori dall'**elenco** ma non dalla lettura); la sezione LAN (DNS
per famiglia, indirizzi v6 mostrati e non configurati); `travel.clients` (vicini v6, una riga per
dispositivo, e il motivo per cui il lease file di odhcpd non si analizza); la tabella del firewall
VPN (`masq6`, `travel_vpn_wg6`, kill switch dual-family); l'inoltro e le rotte del tunnel.

**Tabella dei timeout:** nessuna operazione di apply nuova, ma la riga `LAN` ha ora una verifica in
più — la modalità di annuncio IPv6 deve aver preso, non solo l'indirizzo.

**Debiti tecnici:** la voce «IPv6 gestito dall'app» è sparita dalle cose mancanti e ha lasciato il
posto a due voci oneste — il captive portal solo IPv4, e ICMP che il kill switch non ferma.

**`README.md`:** la riga che diceva «l'integrazione completa di IPv6 resta da realizzare» ora dice
cosa c'è e cosa no, e la riga della scheda *Rete locale* nomina la scelta degli annunci IPv6.

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
- ~~**`::/0` in tabella 53 senza `suppress_prefixlength`**~~: **chiuso in Fase 8.** La regola v6 si
  scrive solo dopo che `ip -6 rule add ... suppress_prefixlength 0` è riuscita, e se non riesce la
  tabella v6 viene svuotata invece di lasciarla a metà. La prova di sicurezza ha il suo gemello
  `lan_probe_addr6`, e il commento dice perché lì conta di più: SSH su v4 continua a funzionare,
  quindi il router sembra a posto mentre ogni browser si pianta.
- **Router a metà aggiornamento** (UI nuova, pacchetto vecchio): ogni campo nuovo è riempito al
  confine, e nessun componente legge `lan.addresses6[0]` senza guardia.
- ~~**GUA annunciata a Tailscale**~~: **chiuso in Fase 7.** `lan_cidr6` filtra su `fc00::/7` e la
  GUA non esce mai; verificato con sei payload sintetici, compreso quello in cui la GUA compare
  prima dell'ULA nell'elenco.
- ~~**Le parentesi in `endpoint_host` sembrano un bug**~~: **chiuso in Fase 8.** Il commento sopra
  `wg_split_endpoint` dice che e' netifd a fare la giunzione ingenua, usa `443` come esempio - la
  porta di quattro cifre, quella che passa inosservata - e un test verifica che le parentesi restino
  dentro l'host in tutte e tre le forme v6.
