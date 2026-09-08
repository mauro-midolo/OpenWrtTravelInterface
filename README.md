# Travel Router UI

[![Versione progetto: 1.9.1-fase8](https://img.shields.io/badge/versione-1.9.1--fase8-blue)](package/travel/files/usr/share/travel/version)
[![OpenWrt di riferimento: 25.12](https://img.shields.io/badge/OpenWrt-25.12-00B5E2)](docs/architettura.md)
[![Dispositivo: GL-MT3600BE](https://img.shields.io/badge/dispositivo-GL--MT3600BE-green)](#dispositivo-e-firmware-di-riferimento)

**La gestione di un router da viaggio, pensata per lo schermo del telefono.**

Travel Router UI è un'interfaccia web per **GL.iNet Beryl 7 (GL-MT3600BE)**
con **OpenWrt vanilla 25.12**. Riunisce connessioni WiFi, accesso a Internet,
rete locale e VPN in un pannello utilizzabile dal browser, anche quando la
connessione Internet non funziona.

## Perché esiste

In viaggio cambia la rete a cui ci si collega: il WiFi dell'hotel richiede un
accesso dal browser, una connessione cade, il telefono diventa una WAN di
emergenza. Gestire questi passaggi dallo smartphone può richiedere di
attraversare molte pagine di configurazione e capire quali impostazioni
dipendono dalle altre.

Il progetto vuole rendere semplici le operazioni più frequenti: collegare il
router alla rete disponibile, mantenere una rete personale per i propri
dispositivi, capire perché Internet non è raggiungibile e scegliere come
instradare il traffico. L'interfaccia è progettata per l'uso con una mano,
con le informazioni e le azioni raccolte per attività.

Tutti i file dell'applicazione sono serviti dal router: la configurazione
locale resta accessibile senza Internet, purché il telefono riesca a
raggiungerlo. LuCI rimane disponibile per la configurazione avanzata.

## Dispositivo e firmware di riferimento

| Voce | Specifica |
|---|---|
| Dispositivo | GL.iNet Beryl 7, modello **GL-MT3600BE** |
| Processore | MediaTek a quattro core, 2,0 GHz |
| Memoria | 512 MB DDR4 |
| Archiviazione | 512 MB NAND flash |
| WiFi | WiFi 7 dual band, 2,4 e 5 GHz |
| Ethernet | Due porte da 2,5 Gb/s, WAN e LAN |
| USB | Una porta USB 3.0 per periferiche e tethering compatibile |
| Alimentazione | USB-C |
| Firmware di riferimento del progetto | **OpenWrt vanilla 25.12** |
| Versione dell'interfaccia/plugin | **1.9.1-fase8** |

Le specifiche hardware provengono dalla
[scheda ufficiale GL.iNet](https://www.gl-inet.com/products/gl-mt3600be/).
Le funzionalità radio effettivamente disponibili dipendono dal firmware e dai
driver installati.

La base software indicata è l'ambiente di riferimento documentato nel
repository. Il progetto si installa su OpenWrt già presente sul dispositivo;
non distribuisce un'immagine firmware. La compatibilità con il firmware
originale GL.iNet, altri router o altre versioni di OpenWrt è da verificare.
Gli script di installazione usano `apk`.

Il badge della versione segue il
[file di versione distribuito sul router](package/travel/files/usr/share/travel/version).
Il repository indica la serie OpenWrt **25.12**, senza fissare una specifica
patch release o build del firmware.

## Cosa permette di fare

| Area | Funzioni disponibili |
|---|---|
| **WiFi** | Cercare e collegare reti, aggiungere a mano una rete nascosta, attivare la riconnessione automatica, gestire gli access point e scegliere MAC e hostname DHCP. Le reti salvate, con credenziali e priorità, hanno una pagina dedicata con la ricerca per nome. |
| **Accesso a Internet** | Vedere stato e traffico delle connessioni, usare WiFi, Ethernet e tethering USB, configurare failover, bilanciamento e regole multi-WAN. |
| **Portali di accesso** | Rilevare i captive portal di hotel e reti pubbliche e aprire il percorso di autenticazione dal browser. |
| **Rete locale** | Configurare IPv4, DHCP e DNS, cambiare il ruolo e l'indirizzo MAC delle porte Ethernet e vedere i dispositivi collegati con la porta o l'access point di provenienza. |
| **VPN** | Gestire Tailscale, scegliere un exit node, salvare più configurazioni WireGuard con un nome e attivarne una alla volta, e abilitare il kill switch con sospensione temporanea per accedere ai portali. |
| **Sistema** | Salvare profili delle modalità di connessione, esportare e ripristinare backup di configurazione, gestire USB, orologio e riavvio pianificato. |

Per esempio, in hotel puoi collegare il router al WiFi della struttura,
completare l'accesso al portale e continuare a usare la tua rete personale.
Se hai configurato una seconda connessione, il failover permette di usarla
quando quella principale non è più disponibile.

## Stato del progetto e limiti attuali

Le funzioni elencate sono implementate; il progetto è in sviluppo e richiede
verifiche sul dispositivo per i diversi scenari di rete.

- La gestione di LAN, multi-WAN e routing VPN è centrata su **IPv4**;
  l'integrazione completa di IPv6 resta da realizzare.
- Bilanciamento multi-WAN, uso di un exit node Tailscale remoto e WireGuard
  attivo sono modalità alternative fra loro. La UI applica questi vincoli.
- WireGuard salva più configurazioni, ognuna con un peer, e ne tiene attiva
  una alla volta; non offre split tunneling né più tunnel attivi insieme.
- Il kill switch blocca l'inoltro dalla LAN alla WAN; il suo ambito e i suoi
  limiti sono descritti nell'architettura.
- La UI non configura reti WiFi Enterprise né reti ospiti isolate. Gli SSID
  nascosti si aggiungono a mano dalla scheda WiFi, indicando nome, banda e tipo
  di sicurezza.
- Il simulatore aiuta a provare i flussi, ma non sostituisce le verifiche su
  OpenWrt. Il repository non include ancora una suite automatica o una pipeline CI.

Dettagli tecnici, comportamenti di rollback e sviluppi mancanti sono descritti
in [Architettura e stato dell'implementazione](docs/architettura.md).

## Provare l'interfaccia senza router

Con Node.js e npm disponibili sul PC, dalla cartella del progetto:

```powershell
cd frontend
npm install
npm run dev
```

Apri **http://localhost:5173/travel/**. In assenza della variabile
`VITE_ROUTER`, il server di sviluppo attiva il simulatore e il login accetta
qualsiasi password. Puoi esplorare le schermate e provare reti WiFi,
interruzioni di connessione, portali e VPN senza un dispositivo collegato.

I dati e gli scenari simulati sono in
[`frontend/src/lib/mock.ts`](frontend/src/lib/mock.ts).

Per sviluppare contro un router reale, dalla cartella `frontend`:

```powershell
$env:VITE_ROUTER = "https://192.168.10.1"
npm run dev
```

In questa modalità le operazioni dell'interfaccia modificano il router indicato.

## Installare sul router

Servono un PC con **PowerShell, Node.js, npm, SSH e tar**, il router con
OpenWrt già installato e accesso amministrativo via SSH. Sul router sono
attesi i servizi OpenWrt di base, tra cui uhttpd con accesso ubus, rpcd/UCI e
ucode con i relativi moduli; l'elenco completo è
nell'[architettura](docs/architettura.md#build-installazione-e-dipendenze).
L'installazione delle dipendenze mancanti richiede accesso a Internet dal router.

Dalla cartella principale del repository:

```powershell
.\tools\deploy.ps1 -Router 192.168.10.1
```

Sostituisci l'indirizzo con quello del tuo router. Lo script compila il
frontend sul PC, trasferisce i file via SSH e avvia il setup. Sul router
vengono serviti file statici; Node.js serve solo sul PC.

Per installare anche il terminale web opzionale:

```powershell
.\tools\deploy.ps1 -Router 192.168.10.1 -WithTtyd
```

Apri quindi **https://192.168.10.1/travel/**, se HTTPS è configurato sul
router, e accedi con la password di root. Un certificato autofirmato genera
un avviso nel browser. Gli indirizzi di esempio vanno adattati alla propria LAN.

| Opzione | Scopo |
|---|---|
| `-Router <ip>` | Indirizzo del router; predefinito `192.168.10.1` |
| `-User <utente>` | Utente SSH; predefinito `root` |
| `-SkipBuild` | Usa la build già presente in `frontend/dist/` |
| `-WithTtyd` | Richiede anche l'installazione di `luci-app-ttyd` |

Il setup installa servizi e dipendenze, inizializza configurazioni di rete e
firewall e imposta la pagina iniziale del router perché apra `/travel/`.
**LuCI resta raggiungibile in `/cgi-bin/luci/`.** Eventuali avvisi sulle
dipendenze vanno risolti per utilizzare le funzioni interessate.

La creazione iniziale degli access point è separata dal deploy: lo script
[`tools/setup-ap.ps1`](tools/setup-ap.ps1) configura SSID e password sulle
due radio, disabilita le altre interfacce WiFi e ricarica il wireless.

## Struttura e sviluppo

```text
frontend/              Interfaccia Preact, TypeScript e Vite
  src/lib/             Client ubus, logica applicativa e simulatore
  src/screens/         Schermate dell'applicazione
package/travel/files/  Backend rpcd, daemon ucode, servizi e script di setup
tools/                 Deploy e strumenti per il dispositivo
docs/                  Architettura e documentazione operativa
```

Il browser comunica con il router tramite `/ubus`. Il plugin `travel`
espone le operazioni di gestione; il daemon `traveld` cura riconnessione,
campionamento del traffico e automazioni. OpenWrt conserva la gestione
effettiva delle connessioni e delle configurazioni.

Per controllare i tipi e compilare, dalla cartella `frontend`:

```powershell
npm run typecheck
npm run build
```

## Contribuire

Segnalazioni, prove sul dispositivo e proposte di miglioramento sono benvenute.
Per un problema, indica modello del router, versione e build di OpenWrt,
versione del progetto, passaggi per riprodurlo e comportamento atteso.
Rimuovi password, chiavi e altri dati riservati dagli eventuali log allegati.

Per orientarsi nel codice e individuare le aree da completare, parti da
[`docs/architettura.md`](docs/architettura.md).
