# Travel Router UI

[English](README.md) · **Italiano**

[![Versione progetto: 1.11.0](https://img.shields.io/badge/versione-1.11.0-blue)](package/travel/files/usr/share/travel/version)
[![OpenWrt di riferimento: 25.12](https://img.shields.io/badge/OpenWrt-25.12-00B5E2)](docs/architettura.md)
[![Dispositivo: GL-MT3600BE](https://img.shields.io/badge/dispositivo-GL--MT3600BE-green)](#dispositivo-e-firmware-di-riferimento)
[![Interfaccia: English · Italiano](https://img.shields.io/badge/interfaccia-English%20%C2%B7%20Italiano-lightgrey)](#lingue)

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
| Versione dell'interfaccia/plugin | **1.11.0** |

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
| **WiFi** | Cercare e collegare reti — una già salvata si riapre dalla scansione con la sua configurazione e senza ridigitare la password —, aggiungere a mano una rete nascosta, attivare la riconnessione automatica, gestire gli access point e scegliere MAC e hostname DHCP. Le reti salvate hanno una pagina dedicata, con una lista sola in cui ogni rete dice su quali bande vale — 2,4 GHz, 5 GHz o entrambe — più ricerca, priorità e condivisione tramite QR e password visibile su richiesta, anche quando non sono connesse. |
| **Accesso a Internet** | Vedere stato e traffico delle connessioni, usare WiFi, Ethernet e tethering USB, configurare failover, bilanciamento e regole multi-WAN. |
| **Portali di accesso** | Rilevare i captive portal di hotel e reti pubbliche e aprire il percorso di autenticazione dal browser. |
| **Rete locale** | Configurare indirizzo IPv4, DHCP e DNS, scegliere come annunciare IPv6 ai dispositivi, cambiare il ruolo e l'indirizzo MAC delle porte Ethernet e vedere i dispositivi collegati con la porta o l'access point di provenienza. |
| **VPN** | Gestire Tailscale, scegliere un exit node, salvare più configurazioni WireGuard con un nome e attivarne una alla volta, e abilitare il kill switch con sospensione temporanea per accedere ai portali. |
| **Sistema** | Salvare profili delle modalità di connessione, esportare e ripristinare backup di configurazione, accendere e spegnere il LED di stato, scegliere cosa fa la levetta fisica, gestire USB, orologio e riavvio pianificato. |
| **Lingua** | Usare l'interfaccia in italiano o in inglese. Al primo accesso la lingua segue quella del browser (inglese se non è né italiano né inglese); si cambia dal menu nella pagina di accesso o dalle Impostazioni, e la scelta resta salvata nel browser. |

Per esempio, in hotel puoi collegare il router al WiFi della struttura,
completare l'accesso al portale e continuare a usare la tua rete personale.
Se hai configurato una seconda connessione, il failover permette di usarla
quando quella principale non è più disponibile.

Dettagli tecnici, comportamenti di rollback e sviluppi mancanti sono descritti
in [Architettura e stato dell'implementazione](docs/architettura.md). Per quando
qualcosa va storto in viaggio c'è la [guida al ripristino](docs/recovery.md).

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
  src/i18n/            Testi dell'interfaccia in italiano e inglese
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
npm test
npm run build
```

Su Windows, i test degli helper shell richiedono Git Bash nel percorso standard
`C:/Program Files/Git/bin/bash.exe`.

### Lingue

I testi dell'interfaccia stanno in `frontend/src/i18n/`, un file per area, con
italiano e inglese uno accanto all'altro (`defineText`). Il tipo dell'inglese è
quello dell'italiano: una chiave mancante è un errore di `npm run typecheck`, e
`tests/i18n.test.ts` controlla che le due lingue abbiano le stesse chiavi.

Il router scrive i suoi messaggi in inglese, accanto a un codice stabile
(`error_code`, `error_params`): l'interfaccia li ricompone nella lingua scelta
da `frontend/src/i18n/backend.ts`, e se il codice non lo conosce mostra la frase
inglese del router. Un nuovo errore nel backend si scrive con
`fail_code codice "frase" chiave valore`; `tests/backend-codes.test.ts` fallisce
finché il codice non ha la sua traduzione.

## Contribuire

Segnalazioni, prove sul dispositivo e proposte di miglioramento sono benvenute.
Per un problema, indica modello del router, versione e build di OpenWrt,
versione del progetto, passaggi per riprodurlo e comportamento atteso.
Rimuovi password, chiavi e altri dati riservati dagli eventuali log allegati.

Per orientarsi nel codice e individuare le aree da completare, parti da
[`docs/architettura.md`](docs/architettura.md).

Questo README esiste anche in [inglese](README.md), che è la versione
predefinita; i due file vengono aggiornati insieme.
