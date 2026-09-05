// travelD - processo residente dell'interfaccia di gestione.
//
// Esiste per le cose che una chiamata richiesta-risposta non puo' fare: stato
// che sopravvive fra una richiesta e l'altra, timer, decisioni automatiche.
// Tutto il resto continua a passare dal plugin rpcd (decisione D2).
//
// Compiti attuali: riconnessione automatica (requisito E.3), che sceglie fra le
// reti salvate quella con la priorita' piu' alta fra quelle visibili e sopra la
// soglia di segnale, con backoff crescente sui fallimenti e blacklist
// temporanea; e il rilevamento dei captive portal (requisito E.4), che decide
// quando verificare l'uscita di ogni WAN e ne tiene il verdetto in RAM.
//
// Riusa i metodi gia' collaudati del plugin rpcd invece di reimplementarli:
// `travel.scan` sa gia' scansionare anche una radio libera, `travel.uplinks`
// sa gia' distinguere gli stati della connessione. Il daemon orchestra, non
// duplica.
//
// Scritto in modo conservativo: niente template literal, niente operatori
// recenti, niente funzioni freccia. Se qualcosa non e' supportato da questo
// ucode deve fallire in un punto solo e con un messaggio leggibile.

'use strict';

const VERSION = '0.6.0';

// Ogni quanto il motore guarda la situazione.
const TICK_MS = 10000;

// Quanto si aspetta prima di considerare fallita una connessione appena fatta:
// associazione e DHCP richiedono qualche secondo.
const SETTLE_SECONDS = 25;

// Dopo una propria azione il motore lascia stare quella radio, per non
// accanirsi mentre netifd sta ancora riconfigurando.
const COOLDOWN_SECONDS = 30;

const MAX_EVENTS = 60;

function tryRequire(name) {
	try {
		return require(name);
	}
	catch (e) {
		return null;
	}
}

function die(message) {
	warn("traveld: " + message + "\n");
	exit(1);
}

const uloop = tryRequire('uloop');
const ubus = tryRequire('ubus');
const uci = tryRequire('uci');
const fs = tryRequire('fs');

if (!uloop) die("manca il modulo uloop");
if (!ubus) die("manca il modulo ubus");
if (!uci) die("manca il modulo uci");
if (!fs) die("manca il modulo fs");

const started = time();
let ticks = 0;
let lastError = "";

// Stato del motore, tutto in RAM: un riavvio del daemon e' anche il modo
// piu' semplice di azzerare backoff e blacklist.
let fails = {};       // sezione -> fallimenti consecutivi
let nextTry = {};     // sezione -> epoch prima del quale non si riprova
let blacklist = {};   // sezione -> epoch di scadenza
let radioBusyUntil = {};
let lastAction = {};
let lastRoamCheck = {};
let events = [];

function note(kind, message) {
	unshift(events, { at: time(), kind: kind, message: message });
	while (length(events) > MAX_EVENTS)
		pop(events);
	warn("traveld: " + kind + ": " + message + "\n");
}

// --- Configurazione ----------------------------------------------------------

function num(value, fallback) {
	let n = +value;
	return (value == null || value === "" || n != n) ? fallback : n;
}

function globals() {
	let g = {
		autoreconnect: false,
		rssi_min: -78,
		roam_mode: 'stay',
		roam_hysteresis: 8,
		blacklist_after: 3,
		blacklist_ttl: 600,
		scan_interval: 60,
		portal_check: true
	};

	try {
		let ctx = uci.cursor();
		ctx.load('travel');
		let s = ctx.get_all('travel', 'globals');
		if (s) {
			g.autoreconnect = (s.autoreconnect == '1');
			g.rssi_min = num(s.rssi_min, g.rssi_min);
			g.roam_mode = s.roam_mode ? s.roam_mode : g.roam_mode;
			g.roam_hysteresis = num(s.roam_hysteresis, g.roam_hysteresis);
			g.blacklist_after = num(s.blacklist_after, g.blacklist_after);
			g.blacklist_ttl = num(s.blacklist_ttl, g.blacklist_ttl);
			g.scan_interval = num(s.scan_interval, g.scan_interval);
			// Acceso se non detto altrimenti: senza, la dashboard tornerebbe a
			// dire "collegato" su una WAN dietro un portale, che e' proprio
			// cio' che questa fase e' venuta a togliere.
			if (s.portal_check != null && s.portal_check !== "")
				g.portal_check = (s.portal_check == '1');
		}
	}
	catch (e) {
		lastError = "lettura di /etc/config/travel fallita: " + e;
	}

	return g;
}

function savedNetworks() {
	let list = [];

	try {
		let ctx = uci.cursor();
		ctx.load('travel');
		ctx.foreach('travel', 'network', function(s) {
			if (s.disabled == '1')
				return;
			push(list, {
				section: s['.name'],
				ssid: s.ssid ? s.ssid : '',
				key: s.key ? s.key : '',
				encryption: s.encryption ? s.encryption : 'psk2',
				band: s.band ? s.band : '',
				mac_mode: s.mac_mode ? s.mac_mode : 'device',
				mac_value: s.mac_value ? s.mac_value : '',
				// Chi non ha il campo e' nato prima che l'impostazione
				// esistesse: vale come "non inviarlo", il default del progetto.
				hostname_mode: s.hostname_mode ? s.hostname_mode : 'none',
				hostname_value: s.hostname_value ? s.hostname_value : '',
				priority: num(s.priority, 0)
			});
		});
	}
	catch (e) {
		lastError = "lettura delle reti salvate fallita: " + e;
	}

	// Priorita' decrescente: la prima e' quella preferita.
	return sort(list, function(a, b) {
		return b.priority - a.priority;
	});
}

// --- Accesso al resto del sistema -------------------------------------------

let conn = null;

function callUbus(object, method, args) {
	try {
		let result = conn.call(object, method, args);
		return result;
	}
	catch (e) {
		lastError = "chiamata " + object + "." + method + " fallita: " + e;
		return null;
	}
}

function radios() {
	let result = callUbus('travel', 'radios', {});
	return (result && result.radios) ? result.radios : [];
}

function uplinks() {
	let result = callUbus('travel', 'uplinks', {});
	return (result && result.uplinks) ? result.uplinks : [];
}

function uplinkFor(list, radioName) {
	for (let u in list)
		if (u.radio == radioName)
			return u;
	return null;
}

// Stato di un uplink, con gli stessi nomi usati dall'interfaccia.
//
// Le due specie hanno modi diversi di essere giu': una radio non si aggancia,
// un cavo non c'e'. Chiamarli con lo stesso nome manda a cercare il guasto
// nel posto sbagliato.
function uplinkState(u) {
	if (!u) return 'absent';
	if (u.enabled === false) return 'disabled';

	if (u.kind == 'wifi') {
		// Interfaccia logica senza nessuna rete configurata: la radio e'
		// semplicemente libera, non e' un guasto.
		if (!u.section || u.section === "") return 'absent';
		if (!u.ssid || u.ssid === "") return 'unassociated';
	}
	else if (u.kind == 'ethernet' && u.carrier != 1) {
		// Zero significa cavo assente; -1 che non si e' potuto leggere, e in
		// entrambi i casi non sta passando niente. La differenza fra i due la
		// racconta l'interfaccia, che non deve affermare cose che non sa.
		return 'no-carrier';
	}

	if (!u.up || !u.ipv4 || u.ipv4 === "") return 'no-address';
	return 'addressed';
}

// --- Scrittura della configurazione -----------------------------------------
//
// Si tocca SOLO la sezione della STA di quella radio. Gli access point non
// vengono mai modificati dal motore: spegnerne uno senza che nessuno lo abbia
// chiesto significherebbe poter togliere l'unico modo di rientrare nel router.

function applyConnection(radioName, net) {
	let section = 'sta_' + radioName;

	try {
		let ctx = uci.cursor();
		ctx.load('wireless');

		ctx.delete('wireless', section);
		ctx.set('wireless', section, 'wifi-iface');
		ctx.set('wireless', section, 'device', radioName);
		ctx.set('wireless', section, 'mode', 'sta');
		ctx.set('wireless', section, 'network', 'wwan_' + radioName);
		ctx.set('wireless', section, 'ssid', net.ssid);
		ctx.set('wireless', section, 'encryption', net.encryption);
		ctx.set('wireless', section, 'disabled', '0');

		if (net.key != "")
			ctx.set('wireless', section, 'key', net.key);

		// `clone` e' il MAC di un dispositivo della LAN, scelto per farsi
		// riconoscere da un portale che autentica gli indirizzi. Per la
		// riconnessione automatica non e' diverso dagli altri: e' un valore da
		// riscrivere. L'elenco dice cosa e' ammesso e non cosa scartare -
		// un modo nuovo che nessuno avesse pensato di escludere entrerebbe
		// altrimenti da solo.
		if ((net.mac_mode == 'random' || net.mac_mode == 'manual' || net.mac_mode == 'clone') && net.mac_value != "")
			ctx.set('wireless', section, 'macaddr', net.mac_value);

		ctx.commit('wireless');
	}
	catch (e) {
		lastError = "scrittura di /etc/config/wireless fallita: " + e;
		note('errore', "non sono riuscito a scrivere la configurazione: " + e);
		return false;
	}

	// Il nome DHCP appartiene alla rete salvata ma vive sull'interfaccia
	// logica: va riscritto a ogni cambio di rete, altrimenti resterebbe quello
	// della rete usata prima su questa radio.
	applyHostname('wwan_' + radioName, net);

	// Solo la radio interessata, non tutto il wireless: l'access point
	// sull'altra radio non deve accorgersi di niente.
	//
	// Si prova prima la forma con l'elenco di argomenti, che non passa da una
	// shell e quindi non ha nessun problema di quoting; se questa versione di
	// ucode non la accetta si ripiega sulla stringa. Il nome della radio arriva
	// da uci, non dalla rete, ma il primo modo resta preferibile.
	try {
		system(["wifi", "up", radioName]);
	}
	catch (e) {
		system("wifi up " + radioName);
	}

	radioBusyUntil[radioName] = time() + COOLDOWN_SECONDS + SETTLE_SECONDS;
	lastAction[radioName] = { at: time(), section: net.section, ssid: net.ssid };

	return true;
}

// Nome da mandare nella richiesta DHCP su questa interfaccia.
//
// L'opzione cancellata non e' l'opzione vuota: senza `hostname` netifd manda il
// nome del router, che e' il default di OpenWrt ma non il nostro. Il default
// del progetto e' `*`, cioe' non mandare niente.
//
// Si scrive solo se cambia: ogni scrittura costa un reload di netifd, e farlo
// a ogni riconnessione butterebbe giu' le altre WAN per niente.
function applyHostname(network, net) {
	let want = '*';
	if (net.hostname_mode == 'device')
		want = null;
	else if (net.hostname_mode == 'custom' && net.hostname_value != "")
		want = net.hostname_value;

	try {
		let ctx = uci.cursor();
		ctx.load('network');

		let now = ctx.get('network', network, 'hostname');
		if (!now) now = null;
		if (now == want)
			return;

		if (want == null)
			ctx.delete('network', network, 'hostname');
		else
			ctx.set('network', network, 'hostname', want);

		ctx.commit('network');
	}
	catch (e) {
		lastError = "scrittura del nome DHCP fallita: " + e;
		return;
	}

	// netifd tiene la configurazione in memoria: senza reload il nome nuovo
	// non arriverebbe nella richiesta DHCP che sta per partire.
	try {
		system(["ubus", "call", "network", "reload"]);
	}
	catch (e) {
		system("ubus call network reload");
	}
}

// --- Scelta della rete -------------------------------------------------------

function isBlocked(section, now) {
	if (blacklist[section] && blacklist[section] > now)
		return 'blacklist';
	if (nextTry[section] && nextTry[section] > now)
		return 'backoff';
	return null;
}

function recordFailure(section, g) {
	let count = (fails[section] ? fails[section] : 0) + 1;
	fails[section] = count;

	// Backoff crescente: 30s, 60s, 120s... fino a un quarto d'ora.
	let wait = 30 * (1 << (count - 1 < 5 ? count - 1 : 5));
	if (wait > 900) wait = 900;
	nextTry[section] = time() + wait;

	if (count >= g.blacklist_after) {
		blacklist[section] = time() + g.blacklist_ttl;
		note('blacklist', section + " messa da parte per " + g.blacklist_ttl + "s dopo " + count + " tentativi falliti");
	}
	else {
		note('fallita', section + ": nuovo tentativo fra " + wait + "s");
	}
}

function recordSuccess(section) {
	if (fails[section])
		note('connessa', section + " ha funzionato, contatori azzerati");
	// Si azzera assegnando null invece di cancellare la chiave: non tutte le
	// versioni di ucode hanno l'operatore `delete`, e non vale la pena
	// dipenderne per una cosa che si fa altrettanto bene cosi'.
	fails[section] = null;
	nextTry[section] = null;
	blacklist[section] = null;
}

// Se questa rete salvata riguarda questa radio.
//
// La regola sta in un posto solo perche' serve in due: scegliere chi agganciare
// e capire quanto vale quella a cui si e' gia' agganciati. Tenerla scritta due
// volte e' gia' costato un confronto sbagliato fra bande diverse.
//
// Una voce senza banda vale per entrambe le radio: e' cosi' che si comportavano
// le reti salvate prima che la banda entrasse nell'identita', e restano valide.
function bandMatches(net, radio) {
	if (net.band == "" || radio.band == "")
		return true;
	return net.band == radio.band;
}

// Cerca fra le reti salvate la migliore visibile su questa radio.
function bestCandidate(radio, saved, g, now) {
	let result = callUbus('travel', 'scan', { radio: radio.name });
	if (!result || !result.results) {
		lastError = "scansione di " + radio.name + " senza risultati";
		return null;
	}

	// Segnale piu' forte per ogni SSID visto.
	let strongest = {};
	for (let entry in result.results) {
		let ssid = entry.ssid ? entry.ssid : "";
		if (ssid === "")
			continue;
		if (strongest[ssid] == null || entry.signal > strongest[ssid])
			strongest[ssid] = entry.signal;
	}

	for (let net in saved) {
		if (!bandMatches(net, radio))
			continue;

		let signal = strongest[net.ssid];
		if (signal == null)
			continue;
		if (signal < g.rssi_min)
			continue;

		let blocked = isBlocked(net.section, now);
		if (blocked)
			continue;

		return { net: net, signal: signal };
	}

	return null;
}

// Passaggio a una rete a priorita' piu' alta, se e' stato chiesto.
//
// Scansionare mentre si e' connessi congela il traffico di quella radio per
// qualche secondo (misurato: fino a 4s): si fa al massimo ogni `scan_interval`,
// e solo se c'e' davvero qualcosa di meglio. La soglia con isteresi evita di
// rincorrere una rete a priorita' alta ma con segnale marginale, che
// porterebbe a saltare avanti e indietro.
function considerRoam(radio, current, saved, g, now) {
	if (lastRoamCheck[radio.name] && (now - lastRoamCheck[radio.name]) < g.scan_interval)
		return;

	lastRoamCheck[radio.name] = now;

	// Solo le voci di questa banda. La stessa rete salvata su tutte e due ha
	// due priorita' distinte, e prendere quella dell'altra banda falserebbe il
	// confronto: una candidata legittima verrebbe scartata perche' battuta da
	// un numero che riguarda una radio diversa.
	let currentPriority = -1;
	for (let net in saved)
		if (net.ssid == current.ssid && bandMatches(net, radio) && net.priority > currentPriority)
			currentPriority = net.priority;

	// Rete non salvata: e' una scelta manuale, non la si scavalca.
	if (currentPriority < 0)
		return;

	let choice = bestCandidate(radio, saved, g, now);
	if (!choice)
		return;

	if (choice.net.ssid == current.ssid)
		return;
	if (choice.net.priority <= currentPriority)
		return;
	if (choice.signal < (g.rssi_min + g.roam_hysteresis))
		return;

	note('roaming', radio.name + ": passo da " + current.ssid + " a " + choice.net.ssid +
		" (priorita' " + choice.net.priority + " contro " + currentPriority + ", " +
		choice.signal + " dBm)");
	applyConnection(radio.name, choice.net);
}

// --- Il giro di controllo ----------------------------------------------------

function evaluate() {
	let g = globals();
	if (!g.autoreconnect)
		return;

	let now = time();
	let saved = savedNetworks();
	if (length(saved) == 0)
		return;

	let list = uplinks();

	for (let radio in radios()) {
		if (radioBusyUntil[radio.name] && radioBusyUntil[radio.name] > now)
			continue;

		let u = uplinkFor(list, radio.name);
		let state = uplinkState(u);

		if (state == 'disabled')
			continue;

		// Connessione sana: si registra il successo, e si valuta il passaggio a
		// una rete migliore solo se e' stato chiesto esplicitamente.
		if (state == 'addressed') {
			let last = lastAction[radio.name];
			if (last && last.section)
				recordSuccess(last.section);

			if (g.roam_mode == 'best')
				considerRoam(radio, u, saved, g, now);

			continue;
		}

		// Agganciata ma senza indirizzo: si da' tempo al DHCP prima di
		// considerarla fallita, perche' e' un caso normale nei primi secondi.
		if (state == 'no-address') {
			let last = lastAction[radio.name];
			if (last && (now - last.at) < SETTLE_SECONDS)
				continue;
		}

		let last = lastAction[radio.name];
		if (last && last.section && (now - last.at) >= SETTLE_SECONDS)
			recordFailure(last.section, g);

		let choice = bestCandidate(radio, saved, g, now);
		if (!choice) {
			continue;
		}

		note('connessione', radio.name + " -> " + choice.net.ssid + " (" + choice.signal + " dBm)");
		applyConnection(radio.name, choice.net);
	}
}

// --- Campionamento per la dashboard -----------------------------------------
//
// Il traffico si legge da /proc/net/dev, che non costa quasi niente e gira
// sempre. Lo stato delle WAN costa una manciata di processi, quindi si rinfresca
// solo quando la dashboard lo chiede e non piu' spesso di SLOW_MAX_AGE: a
// schermata chiusa il router non fa nulla.

const SAMPLE_MS = 2000;
const SLOW_MAX_AGE = 5;      // eta' massima della cache delle WAN

let counters = {};      // device -> { rx, tx, at, base_rx, base_tx }
let rates = {};         // device -> { rx_rate, tx_rate, rx_session, tx_session }
let uplinkCache = { at: 0, list: [] };

function readFileText(path) {
	try {
		return fs.readfile(path);
	}
	catch (e) {
		return null;
	}
}

// Byte ricevuti e trasmessi per ogni interfaccia di sistema.
function procNetDev() {
	let out = {};
	let text = readFileText('/proc/net/dev');
	if (!text)
		return out;

	for (let line in split(text, "\n")) {
		let colon = index(line, ":");
		if (colon < 0)
			continue;

		let name = trim(substr(line, 0, colon));
		let fields = split(trim(substr(line, colon + 1)), /[ \t]+/);
		if (length(fields) < 9)
			continue;

		out[name] = { rx: +fields[0], tx: +fields[8] };
	}

	return out;
}

function sampleTraffic() {
	let now = time();
	let seen = procNetDev();

	for (let device in keys(seen)) {
		let cur = seen[device];
		let prev = counters[device];

		if (!prev) {
			counters[device] = { rx: cur.rx, tx: cur.tx, at: now, base_rx: cur.rx, base_tx: cur.tx };
			continue;
		}

		let span = now - prev.at;
		if (span <= 0)
			continue;

		// I contatori del kernel si azzerano quando l'interfaccia sparisce e
		// torna: un delta negativo non e' traffico, e' una rinascita.
		let drx = cur.rx - prev.rx;
		let dtx = cur.tx - prev.tx;
		if (drx < 0 || dtx < 0) {
			counters[device] = { rx: cur.rx, tx: cur.tx, at: now, base_rx: cur.rx, base_tx: cur.tx };
			continue;
		}

		rates[device] = {
			rx_rate: drx / span,
			tx_rate: dtx / span,
			rx_session: cur.rx - prev.base_rx,
			tx_session: cur.tx - prev.base_tx
		};

		counters[device] = { rx: cur.rx, tx: cur.tx, at: now, base_rx: prev.base_rx, base_tx: prev.base_tx };
	}
}

// Stato delle WAN, con cache: ogni chiamata costa una manciata di processi,
// quindi non si rifa' piu' spesso del necessario.
function freshUplinks(maxAge) {
	let now = time();
	if ((now - uplinkCache.at) < maxAge)
		return uplinkCache.list;

	let list = uplinks();
	uplinkCache = { at: now, list: list };
	return list;
}

function systemInfo() {
	let info = { hostname: "", uptime: 0, load: [0, 0, 0], temp_mc: null, mem_total_kb: 0, mem_available_kb: 0 };

	// Il nome del router: si vede nella scheda Dispositivo, ed e' anche cio'
	// che finisce nella richiesta DHCP delle WAN impostate su "nome del
	// router". Quello vero e' in /proc, non in uci: fino al reload i due
	// possono divergere.
	let host = readFileText('/proc/sys/kernel/hostname');
	if (host)
		info.hostname = trim(host);

	let up = readFileText('/proc/uptime');
	if (up)
		info.uptime = +split(trim(up), /[ \t]+/)[0];

	let load = readFileText('/proc/loadavg');
	if (load) {
		let f = split(trim(load), /[ \t]+/);
		info.load = [ +f[0], +f[1], +f[2] ];
	}

	let mem = readFileText('/proc/meminfo');
	if (mem) {
		for (let line in split(mem, "\n")) {
			let f = split(trim(line), /[ \t:]+/);
			if (f[0] == "MemTotal") info.mem_total_kb = +f[1];
			if (f[0] == "MemAvailable") info.mem_available_kb = +f[1];
		}
	}

	for (let zone in [ 0, 1, 2 ]) {
		let t = readFileText('/sys/class/thermal/thermal_zone' + zone + '/temp');
		if (t) {
			info.temp_mc = +trim(t);
			break;
		}
	}

	return info;
}

// --- Captive portal (requisito E.4) -----------------------------------------
//
// Una WAN con indirizzo puo' essere dietro un portale: DHCP e ping passano,
// mwan3 la dichiara online e il traffico ci finisce sopra senza uscire. A
// rivelarlo e' solo una richiesta HTTP vera, e a farla e' `travel.portal_probe`.
// Qui si decide QUANDO farla, che e' la parte che ha bisogno di memoria e di
// timer: il daemon orchestra e non duplica, come gia' per la scansione.

const PORTAL_TICK_MS = 15000;

// Una WAN che funziona si ricontrolla di rado: non c'e' niente da scoprire, e
// il probe esce da una connessione che puo' essere a consumo.
const PORTAL_INTERVAL_OK = 300;

// Una dietro un portale, o senza uscita, si ricontrolla spesso: e' li' che si
// aspetta un cambiamento - di solito perche' qualcuno ha appena fatto l'accesso
// e sta guardando lo schermo.
const PORTAL_INTERVAL_BAD = 60;

// "Non e' mai stata verificata": piu' vecchio di qualunque intervallo.
const PORTAL_NEVER = 999999999;

// Quanto puo' essere vecchio lo stato delle WAN usato da questo giro.
//
// Piu' lungo dei cinque secondi della dashboard, di proposito: leggere le WAN
// costa una manciata di processi, e a schermata chiusa questo timer sarebbe
// l'unica cosa a farlo girare. Il prezzo e' che una WAN appena arrivata puo'
// essere vista con un minuto di ritardo - ma il caso che conta davvero, la
// connessione appena fatta a mano, e' gia' coperto: il pannello di connessione
// fa il probe da se' appena ha l'indirizzo.
const PORTAL_UPLINK_MAX_AGE = 60;

let portals = {};      // network -> ultimo esito del probe
let portalSeen = {};   // network -> ultimo stato dell'uplink, per il probe su evento

function portalWords(result) {
	if (result.state == 'online') return "Internet raggiungibile";
	if (result.state == 'portal') return "portale di accesso rilevato";
	if (result.state == 'blocked') return "indirizzo si', ma niente esce";
	return "non verificabile" + (result.reason ? " (" + result.reason + ")" : "");
}

function probePortal(network) {
	let result = callUbus('travel', 'portal_probe', { network: network });
	if (!result || !result.state)
		return null;

	let before = portals[network];
	portals[network] = result;

	// Solo i cambi di stato finiscono negli eventi: un probe ogni minuto che
	// conferma quello di prima riempirebbe l'elenco e nasconderebbe il resto.
	if (!before || before.state != result.state)
		note('portale', network + ": " + portalWords(result));

	return result;
}

// Un giro di valutazione: chi va verificato, e quale per primo.
//
// Una WAN per giro. Un probe puo' durare qualche secondo e il daemon nel
// frattempo sta fermo: tre di fila lo terrebbero occupato mezzo minuto, e con
// quindici secondi di intervallo ogni WAN torna comunque nel suo turno.
function portalRound() {
	let g = globals();
	let now = time();
	let list = freshUplinks(PORTAL_UPLINK_MAX_AGE);
	let live = {};
	let pick = null;
	let pickAge = -1;

	for (let u in list) {
		live[u.network] = true;
		let state = uplinkState(u);

		if (state != 'addressed') {
			// Senza indirizzo il verdetto di prima non vale piu'. Tenerlo
			// significherebbe mostrare "c'e' un portale" su una WAN che in
			// questo momento non e' nemmeno collegata.
			portals[u.network] = null;
			portalSeen[u.network] = state;
			continue;
		}

		// Appena arrivata: si verifica subito, senza aspettare il turno. E' il
		// momento in cui serve davvero saperlo - ci si e' appena collegati a
		// una rete nuova e si sta guardando lo schermo.
		let arrived = (portalSeen[u.network] != 'addressed');
		portalSeen[u.network] = state;

		if (!g.portal_check)
			continue;

		let last = portals[u.network];
		let age = (last && !arrived) ? (now - last.at) : PORTAL_NEVER;
		let wait = (last && last.state == 'online') ? PORTAL_INTERVAL_OK : PORTAL_INTERVAL_BAD;

		if (age < wait)
			continue;

		if (age > pickAge) {
			pickAge = age;
			pick = u.network;
		}
	}

	// Una WAN sparita non deve lasciarsi dietro un verdetto: sarebbe una
	// affermazione su qualcosa che non esiste piu'.
	for (let network in keys(portals))
		if (!live[network])
			portals[network] = null;

	if (pick)
		probePortal(pick);
}

function portalResults() {
	let out = {};

	for (let network in keys(portals))
		if (portals[network])
			out[network] = portals[network];

	return out;
}

// --- Kill switch: il riarmo dopo una sospensione ----------------------------
//
// Il kill switch si accende e si spegne dal browser, con applica-e-conferma
// come ogni altra modifica del firewall. Qui c'e' solo il pezzo che una
// richiesta HTTP non puo' fare: rimetterlo su da solo quando scade una
// sospensione.
//
// La sospensione serve per il login a un captive portal, che attraverso un kill
// switch non si puo' fare: si apre un varco per qualche minuto, di proposito e
// con una scadenza dichiarata. Ad aprirlo e' una persona; a richiuderlo e'
// questo timer, perche' chi apre un varco per fare un login se ne dimentica -
// ed e' esattamente il momento in cui il kill switch sarebbe servito.
//
// **Il daemon puo' soltanto richiudere.** Non accende mai un kill switch che
// nessuno ha chiesto, e non ne spegne mai uno: rimette al suo posto una cosa
// che qualcuno ha aperto dicendo quando andava richiusa. E' la stessa regola
// per cui non tocca mai un access point - se sbaglia, sbaglia dalla parte in
// cui il danno e' recuperabile.

const KILLSWITCH_TICK_MS = 20000;

// Cosa vuole l'utente e fino a quando e' sospeso, da /etc/config/travel.
function killswitchState() {
	let state = { on: false, resume_at: 0 };

	try {
		let ctx = uci.cursor();
		ctx.load('travel');
		state.on = (ctx.get('travel', 'vpn', 'killswitch') == '1');
		state.resume_at = num(ctx.get('travel', 'vpn', 'resume_at'), 0);
	}
	catch (e) {
		lastError = "lettura delle impostazioni VPN fallita: " + e;
	}

	return state;
}

function killswitchRound() {
	let state = killswitchState();

	if (!state.on || state.resume_at <= 0)
		return;
	if (time() < state.resume_at)
		return;

	try {
		let fw = uci.cursor();
		fw.load('firewall');
		fw.set('firewall', 'travel_killswitch', 'enabled', '1');
		fw.commit('firewall');

		let ctx = uci.cursor();
		ctx.load('travel');
		ctx.set('travel', 'vpn', 'resume_at', '0');
		ctx.commit('travel');
	}
	catch (e) {
		lastError = "riarmo del kill switch fallito: " + e;
		note('errore', lastError);
		return;
	}

	// fw4 rilegge solo al reload: senza, la regola resterebbe scritta e non
	// applicata, cioe' il caso peggiore - la configurazione dice che sei
	// protetto e il traffico continua a uscire.
	try {
		system(["/etc/init.d/firewall", "reload"]);
	}
	catch (e) {
		system("/etc/init.d/firewall reload");
	}

	note('killswitch', "sospensione scaduta: kill switch riarmato");
}

// --- Interfaccia ubus --------------------------------------------------------

function engineState() {
	let net = {};

	for (let section in keys(fails)) {
		// Le voci azzerate restano come chiavi a null: vanno saltate.
		if (!fails[section] && !nextTry[section] && !blacklist[section])
			continue;

		net[section] = {
			fails: fails[section] ? fails[section] : 0,
			next_try: nextTry[section] ? nextTry[section] : 0,
			blacklisted_until: blacklist[section] ? blacklist[section] : 0
		};
	}

	return net;
}

uloop.init();

conn = ubus.connect();
if (!conn) die("connessione a ubus fallita");

conn.publish('traveld', {
	status: {
		call: function(request) {
			let g = globals();
			return {
				version: VERSION,
				uptime: time() - started,
				ticks: ticks,
				enabled: g.autoreconnect,
				settings: g,
				networks: engineState(),
				events: events,
				last_error: lastError
			};
		},
		// `ubus_rpc_session` va DICHIARATO, non solo tollerato.
		//
		// uhttpd lo aggiunge a ogni chiamata che arriva dal browser, e ucode
		// valida gli argomenti in modo stretto: un attributo non dichiarato fa
		// rifiutare la richiesta. Il risultato e' un metodo che funziona da riga
		// di comando e fallisce dal browser, cioe' il caso piu' scomodo da
		// diagnosticare. Vale per ogni metodo pubblicato da qui.
		args: { detail: "", ubus_rpc_session: "" }
	},

	// Il verdetto piu' recente per ogni WAN, cosi' com'e' in RAM: leggerlo non
	// fa partire nessuna richiesta e non costa niente.
	portal: {
		call: function(request) {
			return {
				at: time(),
				enabled: globals().portal_check,
				results: portalResults()
			};
		},
		args: { detail: "", ubus_rpc_session: "" }
	},

	// Verifica adesso, senza aspettare il turno.
	//
	// E' l'unico modo in cui l'interfaccia chiede un probe: passando da qui il
	// verdetto finisce nella stessa cache che alimenta la dashboard, e non
	// esistono due versioni della stessa verita' che si contraddicono.
	portal_check: {
		call: function(request) {
			let network = request.args.network;
			if (!network || network === "")
				return { error: "manca il nome della WAN" };

			let result = probePortal(network);
			return result ? result : { error: lastError ? lastError : "probe fallito" };
		},
		args: { network: "", ubus_rpc_session: "" }
	},

	reset: {
		call: function(request) {
			fails = {};
			nextTry = {};
			blacklist = {};
			note('reset', "contatori e blacklist azzerati a mano");
			return { reset: true };
		},
		args: { scope: "", ubus_rpc_session: "" }
	},

	// Tutto lo stato della dashboard in una chiamata sola, servito da strutture
	// gia' pronte in RAM (decisione D4). Il polling del browser costa una
	// richiesta per giro, non una raffica di comandi.
	dashboard: {
		call: function(request) {
			let list = freshUplinks(SLOW_MAX_AGE);
			let wans = [];

			for (let u in list) {
				let rate = rates[u.device] ? rates[u.device] : null;
				push(wans, {
					network: u.network,
					kind: u.kind,
					band: u.band,
					radio: u.radio,
					device: u.device,
					section: u.section,
					active: u.active,
					enabled: u.enabled,
					carrier: u.carrier,
					driver: u.driver,
					state: uplinkState(u),
					// L'esito dell'ultima verifica dell'uscita, o null se non
					// e' mai stata fatta. Sta accanto allo stato del
					// collegamento perche' sono due cose diverse: "ha un
					// indirizzo" e "ci si passa davvero".
					portal: portals[u.network] ? portals[u.network] : null,
					ssid: u.ssid,
					bssid: u.bssid,
					channel: u.channel,
					signal: u.signal,
					bitrate: u.bitrate,
					ipv4: u.ipv4,
					gateway: u.gateway,
					dns: u.dns,
					mac: u.mac,
					metric: u.metric,
					hostname: u.hostname,
					rx_rate: rate ? rate.rx_rate : 0,
					tx_rate: rate ? rate.tx_rate : 0,
					rx_session: rate ? rate.rx_session : 0,
					tx_session: rate ? rate.tx_session : 0
				});
			}

			return {
				version: VERSION,
				at: time(),
				system: systemInfo(),
				wans: wans,
				autoreconnect: globals().autoreconnect,
				portal_check: globals().portal_check,
				// Il kill switch si vede anche da qui e non solo dalla schermata
				// VPN: una sospensione in corso e' esattamente la cosa che si
				// vuole ritrovare sotto gli occhi mentre si guarda altro.
				killswitch: killswitchState(),
				events: events,
				last_error: lastError
			};
		},
		args: { detail: "", ubus_rpc_session: "" }
	}
});

// Il traffico si campiona sempre: costa una lettura di /proc e serve ad avere
// gia' i valori pronti quando la schermata si apre.
uloop.timer(SAMPLE_MS, function() {
	try {
		sampleTraffic();
	}
	catch (e) {
		lastError = "campionamento fallito: " + e;
	}

	this.set(SAMPLE_MS);
});

// La verifica dell'uscita gira anche a riconnessione automatica spenta: sono
// due cose indipendenti, e chi sceglie a mano la rete ha lo stesso bisogno di
// sapere se dietro c'e' un portale.
uloop.timer(PORTAL_TICK_MS, function() {
	try {
		portalRound();
	}
	catch (e) {
		lastError = "verifica dei portali interrotta: " + e;
	}

	this.set(PORTAL_TICK_MS);
});

// Il riarmo del kill switch gira sempre, indipendente da tutto il resto: e'
// una promessa fatta a chi ha sospeso, e non deve dipendere da nessun'altra
// impostazione per essere mantenuta.
uloop.timer(KILLSWITCH_TICK_MS, function() {
	try {
		killswitchRound();
	}
	catch (e) {
		lastError = "controllo del kill switch interrotto: " + e;
	}

	this.set(KILLSWITCH_TICK_MS);
});

uloop.timer(TICK_MS, function() {
	ticks++;

	try {
		evaluate();
	}
	catch (e) {
		lastError = "giro di controllo interrotto: " + e;
		note('errore', lastError);
	}

	this.set(TICK_MS);
});

warn("traveld " + VERSION + ": avviato\n");

uloop.run();
uloop.done();
