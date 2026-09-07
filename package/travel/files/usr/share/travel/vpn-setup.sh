#!/bin/sh
# VPN (requisito F, Fase 6a): installa Tailscale e prepara il firewall.
#
# Idempotente, come mwan3-setup.sh: crea solo cio' che manca e non sovrascrive
# mai una scelta dell'utente. Chiamato da setup.sh, si puo' rilanciare a mano.
#
# Il firewall si prepara SEMPRE, anche se Tailscale non si installa: la zona e
# la regola del kill switch non fanno niente finche' non c'e' un tunnel, e
# averle gia' pronte evita di dover rifare il giro quando il pacchetto arriva.
#
# Con l'argomento `forwarding` riapplica il solo inoltro IP e basta: lo chiama
# l'init di travelD a ogni avvio.

say() { printf '  %s\n' "$*"; }

FORWARD_CONF=/etc/sysctl.d/30-travel-forwarding.conf

# Accende l'inoltro IPv4 e lo rende permanente.
#
# Si scrive **direttamente in /proc** invece di affidarsi a `sysctl -p`: e' il
# posto in cui il valore conta davvero, non dipende da quali opzioni conosce il
# sysctl di busybox, e soprattutto si puo' rileggere subito per sapere se ha
# fatto effetto. Il file in sysctl.d serve al riavvio, non ad adesso - e i due
# scopi vanno tenuti distinti, perche' e' esattamente confondendoli che la prima
# versione di questo codice ha lasciato il valore a zero credendo di averlo
# acceso.
enable_forwarding() {
	local before after

	before=$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)

	# Il file si riscrive solo se manca o e' diverso: questa funzione gira a
	# ogni avvio e a ogni cambio di impostazioni, e una scrittura in flash per
	# rimettere lo stesso contenuto e' una scrittura buttata.
	mkdir -p /etc/sysctl.d 2>/dev/null
	grep -q '^net.ipv4.ip_forward=1$' "$FORWARD_CONF" 2>/dev/null || cat > "$FORWARD_CONF" <<'EOF'
# Inoltro IPv4, richiesto da exit node e subnet router della VPN.
#
# Su questo dispositivo era spento: netifd abilita l'inoltro interfaccia per
# interfaccia, e le interfacce che nascono fuori da lui - tailscale0, e in
# seguito wireguard - restano fuori. A decidere cosa passa resta il firewall.
net.ipv4.ip_forward=1
EOF

	# I due nomi sono la stessa manopola, ma scriverli entrambi non costa
	# niente e su alcuni kernel la scrittura su `conf/all/forwarding` e' quella
	# che si propaga alle interfacce gia' esistenti - cioe' a `tailscale0`.
	printf '1\n' > /proc/sys/net/ipv4/ip_forward 2>/dev/null
	printf '1\n' > /proc/sys/net/ipv4/conf/all/forwarding 2>/dev/null

	after=$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)

	if [ "$after" = "1" ]; then
		if [ "$before" = "1" ]; then
			say "inoltro IP gia' attivo"
		else
			say "inoltro IP attivato (era $before)"
		fi
		return 0
	fi

	say "ATTENZIONE: l'inoltro IP resta spento dopo averlo scritto (vale '$after')."
	say "Senza, exit node e subnet router non fanno passare niente. Qualcosa lo"
	say "rimette a zero: da guardare con 'sysctl -a | grep forwarding' e nel log."
	return 1
}

# --- Le risposte devono tornare nel tunnel: la regola contro mwan3 -----------
#
# Verificato sul dispositivo, con il router annunciato e autorizzato come exit
# node, inoltro e firewall a posto: dal telefono non passava niente. Il pezzo
# mancante era mwan3.
#
# mwan3 marca ogni connessione e la instrada con `ip rule fwmark -> lookup
# <tabella della WAN>` a priorita' intorno a 1000. Tailscale mette le proprie
# rotte nella tabella 52 e ci arriva con una regola a priorita' 5270. Una
# risposta da Internet diretta a un telefono nel tailnet (dest 100.x.y.z)
# ritrova il connmark, scatta la regola di mwan3, e la tabella della WAN ha
# una rotta di default: la risposta ESCE DI NUOVO DALLA WAN invece di entrare
# nel tunnel. La LAN funziona solo perche' mwan3 copia le rotte "connesse"
# nelle sue tabelle, e 100.64.0.0/10 nella tabella main non c'e'.
#
# Stesso guasto per il subnet router, e - peggio - per il router che USA un
# exit node altrui: mwan3 manderebbe i client sulla WAN scavalcando il tunnel,
# e con il kill switch acceso resterebbero senza niente.
#
# La cura e' una regola sola, sopra quelle di mwan3: tutto cio' che non e' un
# pacchetto di Tailscale stesso consulta prima la tabella 52. Se li' non c'e'
# una rotta - cioe' sempre, tranne per destinazioni del tailnet o con un exit
# node attivo - si passa oltre e mwan3 decide come prima. I pacchetti di
# Tailscale (WireGuard verso i peer, marcati 0x80000) la saltano e restano a
# mwan3, cosi' il tunnel stesso segue il failover.
#
# Stessa forma della regola del probe dei portali: si sta sopra mwan3 nel
# momento in cui serve, e non si tocca la sua configurazione.
TS_RULE_PREF=900
TS_TABLE=52

# WireGuard (Fase 6b): stesso meccanismo, un gradino sotto.
#
# La 900 manda nel tunnel Tailscale cio' che e' diretto al tailnet; la 901
# manda in WireGuard tutto il resto. L'ordine conta ed e' quello giusto: con
# tutti e due configurati - il che si puo', purche' non sia l'exit node di
# Tailscale ad essere acceso - i propri dispositivi restano raggiungibili nel
# tailnet e il traffico generico esce dal tunnel WireGuard.
#
# `not fwmark`: i pacchetti che WireGuard manda al peer portano il proprio
# marchio e saltano la regola, quindi restano a mwan3 e seguono il failover.
# Senza, il tunnel proverebbe a entrare in se stesso.
WG_RULE_PREF=901
# La salvaguardia sta SOPRA la regola del tunnel: le rotte specifiche della
# tabella principale - la LAN, le reti connesse - vengono consultate per prime,
# e solo cio' che sarebbe finito nella rotta predefinita prosegue nel tunnel.
WG_LOCAL_PREF=899
WG_TABLE=53
# Il prefisso, non un nome: le configurazioni WireGuard salvate sono tante
# (`travel_wg`, `travel_wg1`, `travel_wg2`...) e vivono tutte in
# `/etc/config/network`. Una sola pero' puo' essere accesa, quindi c'e' un solo
# device da instradare e questa e' la funzione che dice quale.
WG_PREFIX=travel_wg
WG_BYPASS_MARK='0x1000000/0x1000000'
TS_BYPASS_MARK='0x80000/0xff0000'

ensure_ts_rule() {
	local n=0

	command -v ip >/dev/null 2>&1 || return 0

	# Si riscrive ogni volta: idempotente, e un doppione non fa danni ma
	# confonde chi legge `ip rule`. Il giro e' limitato per lo stesso motivo
	# del probe: `ip rule del` fallisce quando non c'e' piu' niente, e non ci si
	# affida a quello soltanto.
	while [ "$n" -lt 4 ]; do
		ip rule del pref "$TS_RULE_PREF" 2>/dev/null || break
		n=$((n + 1))
	done

	if ip rule add pref "$TS_RULE_PREF" not fwmark "$TS_BYPASS_MARK" lookup "$TS_TABLE" 2>/dev/null; then
		say "regola di instradamento verso il tunnel (pref $TS_RULE_PREF) a posto"
	else
		say "ATTENZIONE: non sono riuscito a scrivere la regola di instradamento verso il tunnel"
		say "Serve 'ip' completo (pacchetto ip-full): senza, le risposte ai nodi del tailnet"
		say "escono dalla WAN e l'exit node non funziona."
	fi
}

# L'inoltro sull'interfaccia del tunnel, scritto esplicitamente se esiste.
# Dovrebbe ereditare dal valore globale, ma `tailscale0` la crea tailscaled e
# puo' comparire dopo: scriverlo qui toglie un "dovrebbe".
iface_forwarding() {
	[ -e /proc/sys/net/ipv4/conf/tailscale0/forwarding ] || return 0
	printf '1\n' > /proc/sys/net/ipv4/conf/tailscale0/forwarding 2>/dev/null
}

# La rotta verso il tailnet, nella tabella di Tailscale.
#
# Verificato sul dispositivo: con il tunnel su, cinque peer e il WireGuard
# attivo, tailscaled NON aveva installato nessuna rotta verso `tailscale0` - ne'
# in tabella 52 ne' in main. Senza, il router non raggiunge nessun peer e le
# risposte ai nodi che lo usano come uscita non hanno da dove rientrare nel
# tunnel: la regola qui sopra puntava a una tabella vuota e cadeva a vuoto.
#
# Il perche' non e' ancora chiaro (vedi architettura). Questa rotta pero' e'
# corretta per costruzione ogni volta che il tunnel esiste - l'intero
# 100.64.0.0/10 e' il tailnet e va nel tunnel - quindi si scrive comunque:
# se tailscaled la mette anche lui e' un duplicato innocuo, se non la mette
# e' quella che fa funzionare tutto.
ensure_ts_route() {
	[ -e /sys/class/net/tailscale0 ] || return 0
	command -v ip >/dev/null 2>&1 || return 0

	if ip route replace 100.64.0.0/10 dev tailscale0 table "$TS_TABLE" 2>/dev/null; then
		say "rotta verso il tailnet (100.64.0.0/10) in tabella $TS_TABLE a posto"
	else
		say "ATTENZIONE: non sono riuscito a scrivere la rotta verso il tailnet in tabella $TS_TABLE"
	fi
}

# Riapplicare solo cio' che vive in RAM e non sopravvive a un riavvio - inoltro
# e regola di instradamento - senza rifare il resto. Lo chiamano l'init di
# travelD al boot e il plugin rpcd dopo ogni accesso o cambio di impostazioni:
# l'ordine fra sysctl.d, mwan3 e tailscaled non e' garantito, e l'operazione e'
# idempotente. Stesso motivo per cui l'init riapplica la modalita' della porta
# USB.
# Instradamento di WireGuard: la rotta predefinita dentro il tunnel, in una
# tabella nostra, e la regola che ci manda tutto tranne i pacchetti del tunnel.
#
# Si scrive solo quando il tunnel e' su. Quando e' giu' si toglie la regola: una
# regola che punta a una tabella vuota non fa danni, ma lasciarla confonde chi
# legge `ip rule` cercando di capire perche' il traffico va dove va - e in
# questo progetto quella lettura e' gia' costata due giri.
# Un indirizzo della LAN diverso da quello del router, per la prova qui sotto.
# Non deve esistere davvero: `ip route get` risponde comunque, ed e' la
# risposta - da quale device uscirebbe - che interessa.
lan_probe_addr() {
	local addr
	addr=$(uci -q get network.lan.ipaddr | cut -d' ' -f1)
	addr="${addr%%/*}"
	[ -n "$addr" ] || return 1
	printf '%s.2' "${addr%.*}"
}

wg_routing_down() {
	local n=0

	while [ "$n" -lt 4 ]; do
		ip rule del pref "$WG_RULE_PREF" 2>/dev/null || break
		n=$((n + 1))
	done
	n=0
	while [ "$n" -lt 4 ]; do
		ip rule del pref "$WG_LOCAL_PREF" 2>/dev/null || break
		n=$((n + 1))
	done
}

# La configurazione WireGuard accesa, o niente.
#
# Stessa lettura che fa il plugin rpcd, e per forza: se i due dessero risposte
# diverse, l'interfaccia direbbe che il traffico passa da un tunnel e il kernel
# lo manderebbe in un altro. Il vincolo del tunnel unico e' proprio cio' che
# rende la domanda sensata - "quale" ha una risposta sola.
wg_active_iface() {
	local section

	for section in $(uci -q show network 2>/dev/null |
		sed -n "s/^network\.\(${WG_PREFIX}[0-9]*\)=interface\$/\1/p"); do
		[ "$(uci -q get "network.$section.disabled")" = "1" ] && continue
		printf '%s' "$section"
		return 0
	done

	return 1
}

ensure_wg_routing() {
	local probe out iface

	command -v ip >/dev/null 2>&1 || return 0

	wg_routing_down

	iface=$(wg_active_iface) || iface=""

	if [ -z "$iface" ] || [ ! -e "/sys/class/net/$iface" ]; then
		ip route flush table "$WG_TABLE" 2>/dev/null
		return 0
	fi

	ip route replace default dev "$iface" table "$WG_TABLE" 2>/dev/null

	# **Prima la salvaguardia, poi il dirottamento.** L'ordine non e' un
	# dettaglio: fra le due righe non deve esistere un istante in cui il
	# tunnel si prende anche il traffico locale.
	#
	# `suppress_prefixlength 0` significa: consulta la tabella principale, ma
	# ignora le rotte predefinite. Cosi' ogni rotta SPECIFICA - la LAN, le reti
	# connesse, le rotte host - continua a valere, e solo cio' che sarebbe
	# finito nella rotta predefinita prosegue fino al tunnel.
	#
	# Senza questa riga la tabella del tunnel, che contiene solo un `default`,
	# si prendeva tutto: comprese le risposte del router ai client della LAN.
	# Il risultato e' stato un router irraggiungibile in SSH e in HTTP dal
	# momento esatto in cui il tunnel veniva instradato - cioe' chiudere fuori
	# chi stava configurando, che e' il guasto che questo progetto esiste per
	# evitare. La tabella di Tailscale non aveva il problema solo perche'
	# contiene una rotta specifica e non un `default`.
	ip rule add pref "$WG_LOCAL_PREF" lookup main suppress_prefixlength 0 2>/dev/null || {
		say "ATTENZIONE: ip non supporta suppress_prefixlength, non instrado WireGuard"
		say "Senza quella regola il tunnel si prenderebbe anche il traffico della LAN."
		wg_routing_down
		return 0
	}

	if ! ip rule add pref "$WG_RULE_PREF" not fwmark "$WG_BYPASS_MARK" lookup "$WG_TABLE" 2>/dev/null; then
		say "ATTENZIONE: non sono riuscito a scrivere la regola di instradamento di WireGuard"
		wg_routing_down
		return 0
	fi

	# **La prova che non ci siamo chiusi fuori.**
	#
	# Si chiede al kernel da dove uscirebbe un pacchetto verso la LAN: se
	# risponde il tunnel, l'instradamento appena scritto sta mangiando il
	# traffico locale e va tolto subito. Costa una chiamata e vale un router
	# raggiungibile - e' la stessa idea dell'applica-e-conferma, applicata a
	# una modifica che vive in RAM e quindi non ha un ritorno indietro suo.
	probe=$(lan_probe_addr) && {
		out=$(ip route get "$probe" 2>/dev/null)
		case "$out" in
			*"$iface"*)
				say "ATTENZIONE: l'instradamento del tunnel cattura anche la LAN: lo tolgo"
				wg_routing_down
				return 0
				;;
		esac
	}

	say "instradamento WireGuard (pref $WG_RULE_PREF, tabella $WG_TABLE) a posto"
}

if [ "$1" = "runtime" ] || [ "$1" = "forwarding" ]; then
	enable_forwarding
	iface_forwarding
	ensure_ts_rule
	ensure_ts_route
	ensure_wg_routing
	exit 0
fi

# --- 1. Il pacchetto ----------------------------------------------------------

have_tailscale() { [ -x /usr/sbin/tailscale ] || [ -x /usr/bin/tailscale ]; }

. /usr/share/travel/online.sh

# Si installa solo se si esce davvero, e si aspetta un poco se non si esce.
#
# Su un router pulito mwan3 e' appena stato configurato e riavviato: per una
# quindicina di secondi le sue regole mandano il traffico in `unreachable`, e
# un `apk` lanciato in quella finestra restava appeso senza limite di tempo.
# `mwan3-setup.sh` adesso aspetta per conto suo, ma questo script deve reggere
# anche quando viene lanciato a mano, da solo, su una rete che non va.
if have_tailscale; then
	say "tailscale gia' installato"
elif ! travel_wait_online 45; then
	say "ATTENZIONE: nessuna connessione, non installo tailscale."
	say "Il resto continua a funzionare; la VPN arrivera' al prossimo setup"
	say "con una connessione attiva."
else
	say "installo tailscale (serve Internet)"
	if travel_apk_add tailscale && have_tailscale; then
		say "tailscale installato"
	else
		say "ATTENZIONE: tailscale non installato (Internet assente?). Il resto"
		say "continua a funzionare; la VPN arrivera' al prossimo setup con una"
		say "connessione attiva."
	fi
fi

# WireGuard (Fase 6b). Il proto handler di netifd arriva con `wireguard-tools`,
# che si tira dietro il modulo del kernel; `luci-proto-wireguard` e' opzionale e
# serve solo a LuCI - ma LuCI e' la via di fuga, e poterla usare per riparare un
# tunnel vale i suoi pochi kB.
have_wireguard() { [ -x /usr/bin/wg ] && [ -f /lib/netifd/proto/wireguard.sh ]; }

if have_wireguard; then
	say "wireguard gia' installato"
elif ! travel_online; then
	# Qui non si aspetta di nuovo: se non si e' usciti per tailscale, non si
	# esce nemmeno adesso, e un secondo minuto di attesa e' solo un minuto.
	say "ATTENZIONE: nessuna connessione, non installo wireguard."
else
	say "installo wireguard (serve Internet)"
	if travel_apk_add wireguard-tools luci-proto-wireguard && have_wireguard; then
		say "wireguard installato"
	else
		say "ATTENZIONE: wireguard non installato. Tailscale e il resto"
		say "continuano a funzionare."
	fi
fi

# Il servizio non si avvia qui.
#
# Un daemon acceso che non ha mai fatto login non serve a niente e consuma
# memoria su un router da mezzo giga. Parte al primo accesso, dall'interfaccia,
# ed e' li' che viene anche abilitato al boot.

# --- 2. Inoltro IP ------------------------------------------------------------
#
# Serve perche' il router possa far uscire il traffico di qualcun altro: exit
# node e subnet router non funzionano senza, e tailscale lo dice soltanto in una
# riga di log che nessuno legge.
#
# **Verificato sul dispositivo: era spento.** Sorprende, perche' il router
# inoltra tutto il giorno il traffico dalla LAN verso Internet. Il motivo e' che
# `net.ipv4.ip_forward` e' l'altro nome di `net.ipv4.conf.all.forwarding`, e
# Linux decide l'inoltro guardando l'interfaccia da cui il pacchetto **entra**:
# quelle che alza netifd risultano abilitate una per una, e il valore globale
# resta a zero senza che se ne accorga nessuno. `tailscale0` pero' non nasce da
# netifd, quindi in quell'elenco non c'e'.
#
# Accenderlo non apre niente: a decidere cosa puo' attraversare il router resta
# il firewall, che per la zona del tunnel e' fermo su REJECT finche' non si
# accende l'inoltro corrispondente qui sotto.
#
# Si scrive in un file di sysctl.d perche' deve sopravvivere al riavvio, e si
# applica subito perche' deve valere anche adesso. Vedi `enable_forwarding` in
# cima al file, insieme alla regola di instradamento verso il tunnel.
enable_forwarding
iface_forwarding
ensure_ts_rule
ensure_ts_route
ensure_wg_routing

# IPv6 non si tocca: e' disattivato per scelta sulle WAN (vedi architettura), e
# accenderne l'inoltro attiverebbe un percorso che nessuno sta sorvegliando.

# --- 3. La zona firewall del tunnel -------------------------------------------
#
# Serve perche' i client della LAN possano uscire dal tunnel: senza una zona e
# senza masquerade, il traffico inoltrato verso `tailscale0` non torna indietro.
#
# Il device puo' non esistere ancora - lo crea tailscaled al primo avvio - e non
# e' un problema: fw4 salta le zone senza device presenti e le raccoglie da sole
# quando compaiono.
NEED_FW=0

if [ -z "$(uci -q get firewall.travel_vpn)" ]; then
	say "creo la zona firewall 'vpn' per il tunnel"
	uci set firewall.travel_vpn=zone
	uci set firewall.travel_vpn.name='vpn'
	uci set firewall.travel_vpn.input='REJECT'
	uci set firewall.travel_vpn.output='ACCEPT'
	uci set firewall.travel_vpn.forward='REJECT'
	uci set firewall.travel_vpn.masq='1'
	# Il tunnel ha un MTU piu' piccolo dell'uplink: senza mtu_fix le connessioni
	# si aprono e poi si piantano sui pacchetti grandi, che e' il sintomo piu'
	# scomodo da riconoscere perche' "un po' funziona".
	uci set firewall.travel_vpn.mtu_fix='1'
	uci add_list firewall.travel_vpn.device='tailscale0'
	NEED_FW=1
else
	say "zona firewall 'vpn' gia' presente"
fi

if [ -z "$(uci -q get firewall.travel_vpn_fwd)" ]; then
	say "consento l'inoltro dalla LAN al tunnel"
	uci set firewall.travel_vpn_fwd=forwarding
	uci set firewall.travel_vpn_fwd.src='lan'
	uci set firewall.travel_vpn_fwd.dest='vpn'
	NEED_FW=1
fi

# I due inoltri che servono quando e' il router a offrire qualcosa al tailnet,
# invece di prenderlo: verso la WAN per fare da exit node, verso la LAN per
# fare da subnet router.
#
# Nascono **spenti** e si accendono con l'impostazione corrispondente. Sono
# sezioni che esistono sempre, come la regola del kill switch: creare e
# cancellare sezioni a ogni cambio di impostazione e' il modo per ritrovarsi
# con un inoltro rimasto aperto e nessuno che sappia dire perche'.
if [ -z "$(uci -q get firewall.travel_vpn_out)" ]; then
	say "preparo l'inoltro dal tunnel alla WAN (exit node, spento)"
	uci set firewall.travel_vpn_out=forwarding
	uci set firewall.travel_vpn_out.src='vpn'
	uci set firewall.travel_vpn_out.dest='wan'
	uci set firewall.travel_vpn_out.enabled='0'
	NEED_FW=1
fi

if [ -z "$(uci -q get firewall.travel_vpn_lan)" ]; then
	say "preparo l'inoltro dal tunnel alla LAN (subnet router, spento)"
	uci set firewall.travel_vpn_lan=forwarding
	uci set firewall.travel_vpn_lan.src='vpn'
	uci set firewall.travel_vpn_lan.dest='lan'
	uci set firewall.travel_vpn_lan.enabled='0'
	NEED_FW=1
fi

# Il terzo inoltro: dal tunnel di Tailscale a quello di WireGuard.
#
# **Verificato sul dispositivo.** Con il router annunciato come uscita, dal
# telefono si usciva; acceso anche WireGuard, dal telefono non passava piu'
# niente. Il motivo e' che i due tunnel stanno nella STESSA zona firewall, e la
# zona ha `forward REJECT`: finche' l'uscita era la WAN il pacchetto andava da
# `vpn` a `wan` e passava dall'inoltro qui sopra, ma appena l'instradamento lo
# manda in WireGuard il percorso diventa `vpn` -> `vpn`, cioe' il caso che la
# zona rifiuta.
#
# La cura NON e' `forward ACCEPT` sulla zona. Quella aprirebbe anche il verso
# opposto - dal tunnel WireGuard verso il tailnet - e da li' entra la rete di un
# fornitore di VPN, che puo' mandarci dentro quello che vuole. Qui si apre un
# verso solo, e per una sorgente sola: il tailnet.
#
# Una `rule` e non un `forwarding` perche' serve `src_ip`: un inoltro di zona
# non sa distinguere da dove viene il pacchetto, e quella distinzione e' tutta
# la differenza fra "i miei dispositivi escono da WireGuard" e "chiunque stia
# dall'altra parte del tunnel entra nel mio tailnet".
if [ -z "$(uci -q get firewall.travel_vpn_wg)" ]; then
	# Nasce gia' con il valore dell'annuncio, e non spenta come le altre.
	#
	# Le altre sezioni sono nate insieme all'impostazione che le governa: quando
	# esisteranno, qualcuno avra' gia' premuto Salva. Questa invece arriva dopo,
	# su router dove l'annuncio e' acceso da mesi: crearla spenta vorrebbe dire
	# un redeploy che non ripara niente e un giro in piu' da fare senza sapere
	# che va fatto.
	TS_ADVERTISE=$([ "$(uci -q get travel.tailscale.advertise_exit)" = "1" ] && echo 1 || echo 0)
	say "preparo l'uscita del tailnet dentro WireGuard ($([ "$TS_ADVERTISE" = "1" ] && echo accesa || echo spenta))"
	uci set firewall.travel_vpn_wg=rule
	uci set firewall.travel_vpn_wg.name='travel-exit-via-wg'
	uci set firewall.travel_vpn_wg.src='vpn'
	uci set firewall.travel_vpn_wg.dest='vpn'
	uci set firewall.travel_vpn_wg.src_ip='100.64.0.0/10'
	uci set firewall.travel_vpn_wg.family='ipv4'
	uci set firewall.travel_vpn_wg.target='ACCEPT'
	uci set firewall.travel_vpn_wg.enabled="$TS_ADVERTISE"
	NEED_FW=1
fi

# --- 4. La regola del kill switch ---------------------------------------------
#
# Una sola sezione, spenta, creata una volta: accendere e spegnere il kill
# switch e' cambiare `enabled` qui dentro. Niente sezioni da creare e
# cancellare a ogni giro, quindi niente stati intermedi possibili.
#
# Perche' una `rule` e non la rimozione dell'inoltro lan->wan: in fw4 le regole
# vengono valutate prima degli inoltri di zona, quindi questa REJECT vince senza
# toccare niente altro - e soprattutto senza dover ricostruire l'inoltro quando
# si spegne, che e' il punto in cui si sbaglia e si resta senza Internet.
#
# REJECT e non DROP: il client scopre subito che non passa, invece di aspettare
# un timeout. Non cambia cosa esce (niente), cambia quanto ci mette a dirlo.
if [ -z "$(uci -q get firewall.travel_killswitch)" ]; then
	say "preparo la regola del kill switch (spenta)"
	uci set firewall.travel_killswitch=rule
	uci set firewall.travel_killswitch.name='travel-killswitch'
	uci set firewall.travel_killswitch.src='lan'
	uci set firewall.travel_killswitch.dest='wan'
	uci set firewall.travel_killswitch.target='REJECT'
	uci set firewall.travel_killswitch.enabled='0'
	NEED_FW=1
else
	say "regola del kill switch gia' presente"
fi

if [ "$NEED_FW" = "1" ]; then
	uci commit firewall
	/etc/init.d/firewall reload >/dev/null 2>&1
fi

# --- 5. Impostazioni in /etc/config/travel ------------------------------------
#
# Valori prudenti, scritti una volta sola e mai sovrascritti: sono scelte
# dell'utente, e un redeploy non deve riportarle indietro.
NEED_TRAVEL=0

if [ -z "$(uci -q get travel.vpn)" ]; then
	uci set travel.vpn=vpn
	# Spento di default. Un kill switch acceso su un router appena installato,
	# senza nessun tunnel configurato, e' solo un modo per non avere Internet
	# senza capire perche'.
	uci set travel.vpn.killswitch='0'
	uci set travel.vpn.resume_at='0'
	NEED_TRAVEL=1
fi

if [ -z "$(uci -q get travel.tailscale)" ]; then
	uci set travel.tailscale=tailscale
	uci set travel.tailscale.exit_node=''
	uci set travel.tailscale.accept_routes='0'
	uci set travel.tailscale.accept_dns='0'
	uci set travel.tailscale.advertise_lan='0'
	uci set travel.tailscale.advertise_exit='0'
	NEED_TRAVEL=1
fi

if [ "$NEED_TRAVEL" = "1" ]; then
	say "aggiungo le impostazioni VPN a /etc/config/travel"
	uci commit travel
fi

say "VPN: $(have_tailscale && echo 'tailscale presente' || echo 'tailscale assente'), firewall pronto, inoltro IP $(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)"
