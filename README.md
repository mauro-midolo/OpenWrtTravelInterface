# Travel Router UI

Interfaccia di gestione mobile-first per un **GL.iNet Beryl 7 (GL-MT3600BE)** su
OpenWrt vanilla 25.12, pensata per essere usata dal telefono, con una mano, in
hotel e aeroporti, spesso senza Internet funzionante.

- [Architettura e decisioni](docs/architettura.md)
- [**Se qualcosa va storto**](docs/recovery.md) — da salvare offline sul telefono

**Fase attuale: 8** — WiFi con reti salvate e riconnessione automatica,
dashboard, multi-WAN con tethering USB, LAN e porte ethernet commutabili,
rilevamento dei captive portal, VPN Tailscale e WireGuard con kill switch,
l'elenco dei dispositivi collegati con la porta o l'access point da cui entrano,
e infine profili, backup, orologio e riavvio pianificato.
Le fasi e cosa contengono stanno nell'[architettura](docs/architettura.md#fasi).

## Struttura

```
frontend/          SPA Preact + Vite; si compila sul PC, il router serve solo file statici
  src/lib/ubus.ts  client per il canale /ubus: unico modo di parlare con il router
  src/lib/mock.ts  simulatore del bus, per lavorare senza dispositivo
package/travel/    file che finiscono sul router
tools/deploy.ps1   compila e installa via ssh
docs/              architettura e procedura di recupero
```

## Sviluppare senza router

E' il modo normale di lavorare: il router serve solo quando si installa.

```powershell
cd frontend
npm install
npm run dev
```

Si apre su `http://localhost:5173/travel/` con il **simulatore attivo**: nessun
router collegato, qualsiasi password va bene. Le risposte finte stanno in
`src/lib/mock.ts` — e' anche il posto dove simulare gli scenari scomodi (WAN che
cade, captive portal, rete che sparisce) che sul dispositivo vero sono difficili
da riprodurre a comando.

Due scorciatoie utili nel simulatore: la password `sbagliata` fa fallire
l'associazione, e collegarsi a **Hotel-Guest** o **Hotel-WiFi-Free** finisce
dietro un captive portal — che sparisce clonando il MAC di `pixel-di-mauro`,
l'unico che il portale finto considera gia' autenticato.

Anche i vincoli fra multi-WAN, Tailscale e WireGuard si provano li': accendi il
bilanciamento e guarda sparire l'exit node e l'accensione di WireGuard, accendi
WireGuard e guarda sparire il bilanciamento. Sono sei combinazioni, e senza
simulatore servirebbero sei configurazioni vere.

Per sviluppare contro il router vero:

```powershell
$env:VITE_ROUTER = "https://192.168.10.1"
npm run dev
```

## Installare sul router

Serve solo `ssh`, che Windows 11 ha gia' integrato.

```powershell
.\tools\deploy.ps1
```

Prima installazione, con il terminale web (la rete di sicurezza per quando sei in
viaggio senza SSH — richiede che il router abbia Internet):

```powershell
.\tools\deploy.ps1 -WithTtyd
```

Poi apri **`https://192.168.10.1/travel/`** dal telefono e accedi con la password
di root del router. Il certificato e' self-signed: il browser avvisa, e' normale.

Opzioni: `-Router <ip>`, `-User <utente>`, `-SkipBuild`.

### Se ssh chiede la password ogni volta

Una tantum, dal PC:

```powershell
if (-not (Test-Path ~\.ssh\id_ed25519)) { ssh-keygen -t ed25519 -N '""' -f ~\.ssh\id_ed25519 }
Get-Content ~\.ssh\id_ed25519.pub | ssh root@192.168.10.1 "mkdir -p /etc/dropbear; cat >> /etc/dropbear/authorized_keys; chmod 600 /etc/dropbear/authorized_keys"
```

## Cosa tocca sul router

Il deploy e' volutamente poco invasivo. LuCI resta installata e intatta: e' la
via di fuga.

| Percorso | |
|---|---|
| `/www/travel/` | l'interfaccia (svuotata e riscritta a ogni deploy) |
| `/usr/libexec/rpcd/travel` | oggetto ubus `travel` |
| `/usr/share/travel/` | versione e script di setup |
| `/usr/share/rpcd/acl.d/travel.json` | permessi |
| `/etc/config/travel` | configurazione e reti salvate, **creata solo se assente** |
| `/etc/init.d/travel` | servizio travelD |
| `uhttpd.main.ubus_prefix` | impostato a `/ubus` solo se mancante |
| `firewall.travel_vpn`, `travel_vpn_fwd` | zona del tunnel VPN e inoltro dalla LAN |
| `firewall.travel_vpn_out`, `travel_vpn_lan` | inoltri per exit node e subnet router, creati **spenti** |
| `firewall.travel_killswitch` | la regola del kill switch, creata **spenta** |
| `/etc/sysctl.d/30-travel-forwarding.conf` | inoltro IPv4, che serve a exit node e subnet router |
| `network.travel_wg` | il tunnel WireGuard, creato solo importando una configurazione |

Per disinstallare tutto:

```sh
/etc/init.d/travel stop; /etc/init.d/travel disable
rm -rf /www/travel /usr/share/travel /usr/libexec/rpcd/travel \
       /usr/share/rpcd/acl.d/travel.json /etc/init.d/travel \
       /etc/sysctl.d/30-travel-forwarding.conf
for s in travel_killswitch travel_vpn_lan travel_vpn_out travel_vpn_fwd travel_vpn; do
  uci -q delete "firewall.$s"
done
uci commit firewall; /etc/init.d/firewall reload
for p in 899 900 901; do ip rule del pref "$p" 2>/dev/null; done   # le regole dei tunnel vivono in RAM
/etc/init.d/rpcd restart
```
