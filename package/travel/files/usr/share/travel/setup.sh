#!/bin/sh
# Configurazione lato router, eseguita da tools/deploy.ps1 dopo aver copiato i file.
# Idempotente: puo' essere rilanciata quante volte si vuole senza effetti collaterali.
#
# Variabili d'ambiente riconosciute:
#   TRAVEL_INSTALL_TTYD=1   installa anche il terminale web (richiede Internet)

set -e

say() { printf '  %s\n' "$*"; }

# Aspettare che si esca prima di installare, e non lasciare mai `apk` senza un
# limite di tempo. Su un router pulito un'installazione lanciata mentre mwan3 si
# stava ancora avviando e' rimasta appesa per sempre: le sue regole mandano il
# traffico in `unreachable` finche' non dichiara online una WAN.
. /usr/share/travel/online.sh

say "permessi sugli eseguibili"
chmod 0755 /usr/libexec/rpcd/travel
chmod 0755 /usr/share/travel/setup.sh
chmod 0755 /etc/init.d/travel
chmod 0755 /etc/init.d/travel-led
chmod 0755 /usr/share/travel/led.sh
chmod 0755 /etc/init.d/travel-toggle
chmod 0755 /usr/share/travel/toggle.sh
chmod 0755 /usr/share/travel/toggle-button.sh
chmod 0755 /etc/rc.button/BTN_0
chmod 0755 /etc/rc.button/BTN_1
chmod 0755 /etc/hotplug.d/net/30-travel-usb
chmod 0755 /etc/hotplug.d/net/40-travel-vpn
chmod 0755 /etc/hotplug.d/usb/20-travel-usb-mode
chmod 0755 /usr/share/travel/usb-mode.sh
chmod 0755 /usr/share/travel/vpn-setup.sh
chmod 0644 /usr/share/travel/online.sh
chmod 0644 /usr/share/travel/traveld.uc
chmod 0644 /usr/share/travel/probe.uc
chmod 0644 /usr/share/rpcd/acl.d/travel.json

# uhttpd deve esporre il canale /ubus: e' l'unica via di comunicazione della UI
# (decisione D3/D4). Su un'installazione con LuCI c'e' quasi sempre gia'.
if [ -z "$(uci -q get uhttpd.main.ubus_prefix)" ]; then
	say "abilito il canale /ubus in uhttpd"
	uci set uhttpd.main.ubus_prefix='/ubus'
	uci commit uhttpd
	NEED_UHTTPD_RELOAD=1
else
	say "canale /ubus gia' presente"
fi

# La radice del router porta all'interfaccia da viaggio.
#
# `/www/index.html` arriva da luci-base e rimanda a `/cgi-bin/luci`. Qui viene
# sostituito con un rimando a `/travel/`, cosi' digitare l'indirizzo del router
# apre l'interfaccia che si usa tutti i giorni invece di quella di emergenza.
#
# LuCI non viene toccata: resta esattamente dov'era, e la pagina di rimando la
# elenca. Anzi, e' proprio la ragione per cui questa pagina ha due link e non
# un redirect secco - se un giorno la SPA non parte, la radice del router deve
# comunque offrire una via d'uscita che non dipende da lei.
#
# L'originale si conserva una volta sola: un aggiornamento di luci-base
# riscrive il suo index.html, e da li' basta rilanciare questo script.
if ! grep -q 'travel-ui redirect' /www/index.html 2>/dev/null; then
	if [ -f /www/index.html ] && [ ! -f /www/index.html.luci ]; then
		say "conservo l'index.html di LuCI in /www/index.html.luci"
		cp /www/index.html /www/index.html.luci
	fi

	say "la radice del router apre /travel/"
	cat > /www/index.html <<'EOF'
<!DOCTYPE html>
<!-- travel-ui redirect -->
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=/travel/">
<title>Router da viaggio</title>
</head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; line-height: 1.6">
<p><a href="/travel/">Interfaccia di gestione</a></p>
<p><a href="/cgi-bin/luci/">LuCI (configurazione avanzata)</a></p>
</body>
</html>
EOF
else
	say "la radice del router apre gia' /travel/"
fi

if [ ! -f /etc/config/travel ]; then
	say "creo /etc/config/travel"
	cat > /etc/config/travel <<'EOF'
config globals 'globals'
	option installed_phase '0'
EOF
else
	say "/etc/config/travel gia' presente, non lo tocco"
fi

# Un'interfaccia logica PER RADIO, non una sola condivisa.
#
# Due STA agganciate alla stessa interfaccia logica si contendono lo stesso
# indirizzo e una delle due resta senza: sono due uplink distinti, con IP,
# gateway, DNS e metrica di route separati.
#
# Non hanno un device proprio: e' la wifi-iface in modo sta che si aggancia
# tramite `option network <nome>`.
WAN_ZONE=$(uci show firewall 2>/dev/null | sed -n "s/^firewall\.\(@zone\[[0-9]*\]\)\.name='wan'\$/\1/p" | head -n 1)

# Ruolo di fabbrica delle due porte ethernet: eth0 WAN, eth1 dentro il bridge
# LAN. E' la rete di sicurezza del dispositivo - se una modifica sbagliata
# rompe il WiFi o la configurazione a monte, eth1 resta un modo per rientrare
# via cavo che non dipende da nient'altro.
#
# Una volta sola, come le altre impostazioni dell'utente in questo script: la
# schermata "Porte ethernet" permette di commutarle, e un redeploy non deve
# riportarle indietro sopra una scelta fatta li'.
if [ "$(uci -q get travel.globals.eth_roles_init)" != "1" ]; then
	say "porte ethernet: eth0 WAN, eth1 LAN (rete di sicurezza)"

	BRLAN_SECTION=""
	for s in $(uci show network 2>/dev/null | sed -n 's/^network\.\([^.]*\)=device$/\1/p'); do
		if [ "$(uci -q get "network.$s.name")" = "br-lan" ]; then
			BRLAN_SECTION="$s"
			break
		fi
	done

	if [ -z "$BRLAN_SECTION" ]; then
		say "ATTENZIONE: sezione device br-lan non trovata, salto la configurazione delle porte"
	else
		BRIDGE_PORTS=$(uci -q get "network.$BRLAN_SECTION.ports")

		if printf '%s\n' "$BRIDGE_PORTS" | tr ' ' '\n' | grep -qx eth1; then
			say "eth1 gia' nel bridge LAN"
		else
			say "aggiungo eth1 al bridge LAN"
			uci add_list "network.$BRLAN_SECTION.ports=eth1"
			NEED_NETWORK_RELOAD=1
		fi

		if printf '%s\n' "$BRIDGE_PORTS" | tr ' ' '\n' | grep -qx eth0; then
			say "tolgo eth0 dal bridge LAN"
			uci del_list "network.$BRLAN_SECTION.ports=eth0"
			NEED_NETWORK_RELOAD=1
		fi
		uci commit network

		# Riusa l'interfaccia 'wan' se gia' esiste, come su qualunque immagine
		# OpenWrt di fabbrica: altrimenti la crea da zero.
		if [ -n "$(uci -q get network.wan)" ]; then
			say "interfaccia wan gia' presente, la punto su eth0"
		else
			say "creo l'interfaccia wan (eth0, DHCP)"
			uci set network.wan=interface
			uci set network.wan.proto=dhcp
		fi
		uci set network.wan.device=eth0
		# Nessun nome nel DHCP, per coerenza con le altre WAN. IPv6 non si
		# scrive affatto: l'assenza dell'opzione e' il dual-stack predefinito
		# di OpenWrt, ed e' anche lo stato in cui la migrazione piu' sotto
		# porta le WAN gia' esistenti.
		uci set network.wan.hostname='*'
		uci commit network
		NEED_NETWORK_RELOAD=1

		if [ -n "$WAN_ZONE" ]; then
			if uci -q get "firewall.$WAN_ZONE.network" | tr ' ' '\n' | grep -qx wan; then
				say "wan gia' nella zona firewall wan"
			else
				say "aggiungo wan alla zona firewall wan"
				uci add_list "firewall.$WAN_ZONE.network=wan"
				uci commit firewall
				NEED_FIREWALL_RELOAD=1
			fi
		else
			say "ATTENZIONE: zona firewall 'wan' non trovata, wan non e' stata aggiunta"
		fi
	fi

	uci set travel.globals.eth_roles_init=1
	uci commit travel
else
	say "porte ethernet: gia' inizializzate, non le tocco (impostazione dell'utente)"
fi

for radio in $(uci show wireless 2>/dev/null | sed -n 's/^wireless\.\([^.]*\)=wifi-device$/\1/p'); do
	net="wwan_$radio"

	if [ -z "$(uci -q get "network.$net")" ]; then
		say "creo l'interfaccia di rete $net (DHCP)"
		uci set "network.$net=interface"
		uci set "network.$net.proto=dhcp"
		# Nessun nome nella richiesta DHCP: `*` e' il modo in cui netifd dice
		# "non mandarlo". Senza l'opzione manderebbe il nome del router, che
		# resterebbe scritto nella lista dei client di ogni rete a cui ci si
		# aggancia - alberghi compresi.
		uci set "network.$net.hostname=*"
		uci commit network
		NEED_NETWORK_RELOAD=1
	else
		say "interfaccia $net gia' presente"
	fi

	# Senza zona firewall il traffico verso la rete a monte non viene
	# mascherato e i client della LAN non escono.
	if [ -n "$WAN_ZONE" ]; then
		if uci -q get "firewall.$WAN_ZONE.network" | tr ' ' '\n' | grep -qx "$net"; then
			say "$net gia' nella zona firewall wan"
		else
			say "aggiungo $net alla zona firewall wan"
			uci add_list "firewall.$WAN_ZONE.network=$net"
			uci commit firewall
			NEED_FIREWALL_RELOAD=1
		fi
	else
		say "ATTENZIONE: zona firewall 'wan' non trovata, $net non e' stata aggiunta"
	fi
done

# Interfaccia del tethering USB. Esiste sempre, ma nasce disattivata: il device
# lo scrive lo script di hotplug quando attacchi il telefono, e il flag
# `disabled` e' cio' che la tiene fuori dall'elenco delle WAN finche' non c'e'
# niente collegato.
if [ -z "$(uci -q get network.wan_usb)" ]; then
	say "creo l'interfaccia di rete wan_usb (tethering, disattivata)"
	uci set network.wan_usb=interface
	uci set network.wan_usb.proto=dhcp
	uci set network.wan_usb.hostname='*'
	uci set network.wan_usb.disabled=1
	uci commit network
	NEED_NETWORK_RELOAD=1
else
	say "interfaccia wan_usb gia' presente"
fi

if [ -n "$WAN_ZONE" ]; then
	if uci -q get "firewall.$WAN_ZONE.network" | tr ' ' '\n' | grep -qx wan_usb; then
		say "wan_usb gia' nella zona firewall wan"
	else
		say "aggiungo wan_usb alla zona firewall wan"
		uci add_list "firewall.$WAN_ZONE.network=wan_usb"
		uci commit firewall
		NEED_FIREWALL_RELOAD=1
	fi
fi

# Nome inviato nella richiesta DHCP: spento su TUTTE le WAN gia' esistenti,
# comprese quelle via cavo create prima che l'impostazione esistesse.
#
# Una volta sola, e la cosa resta segnata in travel: dopo, la scelta e'
# dell'utente, e rilanciare questo script non deve riportarla indietro. Chi
# vuole mandare un nome lo riaccende dall'interfaccia, per singola WAN.
if [ "$(uci -q get travel.globals.dhcp_hostname_init)" != "1" ]; then
	for net in $(uci -q get "firewall.$WAN_ZONE.network"); do
		[ -n "$(uci -q get "network.$net")" ] || continue
		if [ -z "$(uci -q get "network.$net.hostname")" ]; then
			say "$net: nessun nome nella richiesta DHCP"
			uci set "network.$net.hostname=*"
			NEED_NETWORK_RELOAD=1
		fi
	done
	uci commit network
	uci set travel.globals.dhcp_hostname_init=1
	uci commit travel
fi

# IPv6 sulle WAN: acceso, cancellando il divieto invece di scrivere un permesso.
#
# Le WAN nate prima hanno `option ipv6 '0'`, che le teneva IPv4-only. Qui
# l'opzione si CANCELLA, e la differenza conta: senza opzione vale il default di
# OpenWrt, che e' dual-stack, mentre scrivere `1` imporrebbe un valore nostro su
# una scelta che appartiene alla distribuzione. E' la stessa distinzione del
# `macaddr` in stageEthMac, e vale anche per le WAN create da qui in avanti, che
# infatti l'opzione non la scrivono affatto.
#
# Una volta sola, segnata in travel: dopo, la scelta e' dell'utente. Chi rimette
# `ipv6 '0'` su una WAN se lo tiene anche rilanciando questo script.
if [ "$(uci -q get travel.globals.ipv6_init)" != "1" ]; then
	for net in $(uci -q get "firewall.$WAN_ZONE.network"); do
		[ -n "$(uci -q get "network.$net")" ] || continue
		[ -n "$(uci -q get "network.$net.ipv6")" ] || continue
		say "$net: accendo IPv6 (tolgo ipv6=0)"
		uci delete "network.$net.ipv6"
		NEED_NETWORK_RELOAD=1
	done
	uci commit network
	uci set travel.globals.ipv6_init=1
	uci commit travel
fi

# IPv6 sulle WAN: una interfaccia logica esplicita per ognuna.
#
# Su OpenWrt 25.12 non esiste nessun altro modo, e il blocco qui sopra da solo
# non accende niente. Verificato sul router: /lib/netifd/proto/dhcp.sh non
# nomina mai l'opzione `ipv6`, e nessuno script in /lib/netifd/proto/ crea alias
# `<net>_6` al volo. Senza una `config interface` dedicata IPv6 su una WAN
# semplicemente non si alza - ed e' lo stesso motivo per cui l'immagine di
# fabbrica porta gia' un `wan6` accanto a `wan`.
#
# `device '@<net>'`, non il nome del device: per una STA WiFi il device in uci
# non c'e' affatto - glielo assegna la sezione wireless - e cambia quando la
# radio si riassocia. Il riferimento simbolico segue la sorella v4 dovunque
# vada, ed e' la stessa ragione per cui l'appaiamento in lettura si fa sul
# l3_device e non sui nomi.
#
# Si crea solo se manca. Chi vuole IPv6 spento su una WAN mette `disabled 1`
# sulla sua sezione `<net>6`: quella sopravvive a questo script, mentre
# cancellarla la farebbe soltanto ricreare al prossimo giro.

# Reti salvate: una sola voce per rete, con le bande dentro.
#
# Prima le due bande erano due sezioni gemelle, e la stessa rete di casa
# compariva due volte in due elenchi separati. Adesso l'elenco e' uno e le bande
# sono due caselle: `band` vuoto significa "tutte e due", ed e' un valore che
# uci ha sempre avuto, quindi le voci esistenti sono gia' leggibili cosi' come
# sono e questa migrazione non e' obbligatoria per farle funzionare.
#
# Quello che fa e' unire le coppie che sono chiaramente la stessa rete, per non
# lasciare in eterno due righe dove adesso ne basta una. Il criterio e'
# volutamente severo: si uniscono solo voci che non perderebbero niente
# nell'unione - stesso nome, stessa cifratura, stessa password, stesso stato
# nascosto, stesso nome DHCP, stesso stato di attivazione, e note che non si
# contraddicono. Tutto il resto resta separato: due configurazioni diverse con
# lo stesso nome sono un caso legittimo, e fonderle vorrebbe dire scegliere al
# posto di qualcun altro quale delle due buttare via.
#
# Il MAC non e' un ostacolo all'unione: e' l'unico parametro che resta per
# banda, quindi i due valori sopravvivono entrambi, uno per radio.
#
# Una volta sola, segnata in travel: dopo, l'elenco e' dell'utente e rilanciare
# questo script non deve rimetterci le mani.
if [ "$(uci -q get travel.globals.saved_bands_init)" != "1" ]; then
	# `|| true` non e' pignoleria: con `set -e` una lettura di un'opzione che
	# non c'e' - ed e' il caso normale qui - fermerebbe tutto lo script.
	net_get() { uci -q get "travel.$1.$2" 2>/dev/null || true; }

	# Il MAC effettivo di una banda: quello suo se c'e', altrimenti il
	# condiviso, che e' cio' che hanno le voci nate prima che si separassero.
	# Modo e valore si chiedono separatamente per non doverli riseparare dopo.
	net_mac_mode() {
		if [ -n "$(net_get "$1" "mac_mode_$2")" ]; then
			net_get "$1" "mac_mode_$2"
		else
			net_get "$1" mac_mode
		fi
	}
	net_mac_value() {
		if [ -n "$(net_get "$1" "mac_mode_$2")" ]; then
			net_get "$1" "mac_value_$2"
		else
			net_get "$1" mac_value
		fi
	}

	# Due note si uniscono solo se una e' vuota o sono identiche: unirle
	# davvero significherebbe inventare un testo che nessuno ha scritto.
	notes_ok() {
		[ "$1" = "$2" ] || [ -z "$1" ] || [ -z "$2" ]
	}

	TRAVEL_SECTIONS=$(uci show travel 2>/dev/null | sed -n 's/^travel\.\([^.]*\)=network$/\1/p')
	MERGED=0

	for a in $TRAVEL_SECTIONS; do
		[ "$(net_get "$a" band)" = "2.4" ] || continue
		ssid=$(net_get "$a" ssid)
		[ -n "$ssid" ] || continue

		for b in $TRAVEL_SECTIONS; do
			[ "$b" != "$a" ] || continue
			[ "$(net_get "$b" band)" = "5" ] || continue
			[ "$(net_get "$b" ssid)" = "$ssid" ] || continue
			[ "$(net_get "$b" encryption)" = "$(net_get "$a" encryption)" ] || continue
			[ "$(net_get "$b" key)" = "$(net_get "$a" key)" ] || continue
			[ "$(net_get "$b" hidden)" = "$(net_get "$a" hidden)" ] || continue
			[ "$(net_get "$b" disabled)" = "$(net_get "$a" disabled)" ] || continue
			[ "$(net_get "$b" hostname_mode)" = "$(net_get "$a" hostname_mode)" ] || continue
			[ "$(net_get "$b" hostname_value)" = "$(net_get "$a" hostname_value)" ] || continue
			notes_ok "$(net_get "$a" note)" "$(net_get "$b" note)" || continue

			say "reti salvate: «$ssid» diventa una voce sola su tutte e due le bande"

			# I due MAC restano, uno per radio: e' il solo parametro che le due
			# bande non condividono.
			mode24=$(net_mac_mode "$a" 24)
			value24=$(net_mac_value "$a" 24)
			uci set "travel.$a.mac_mode_24=$mode24"
			uci set "travel.$a.mac_value_24=$value24"
			uci set "travel.$a.mac_mode_5=$(net_mac_mode "$b" 5)"
			uci set "travel.$a.mac_value_5=$(net_mac_value "$b" 5)"
			# Quello condiviso resta allineato alla prima banda attiva: e'
			# quello che legge un pacchetto non ancora aggiornato.
			uci set "travel.$a.mac_mode=$mode24"
			uci set "travel.$a.mac_value=$value24"

			# La priorita' piu' alta delle due: unendole non si retrocede.
			pa=$(net_get "$a" priority)
			pb=$(net_get "$b" priority)
			if [ "${pb:-0}" -gt "${pa:-0}" ] 2>/dev/null; then
				uci set "travel.$a.priority=$pb"
			fi

			# La storia piu' recente delle due, con il suo esito: e' quella che
			# risponde a "come e' andata l'ultima volta".
			ua=$(net_get "$a" last_used)
			ub=$(net_get "$b" last_used)
			if [ "${ub:-0}" -gt "${ua:-0}" ] 2>/dev/null; then
				uci set "travel.$a.last_used=$ub"
				uci set "travel.$a.last_result=$(net_get "$b" last_result)"
			fi

			# La nota che c'e': se ce n'era una sola, sopravvive.
			if [ -z "$(net_get "$a" note)" ]; then
				uci set "travel.$a.note=$(net_get "$b" note)"
			fi

			# Vuoto = tutte e due le bande.
			uci set "travel.$a.band="
			uci delete "travel.$b"
			MERGED=1
			break
		done
	done

	uci set travel.globals.saved_bands_init=1
	uci commit travel
	if [ "$MERGED" != "1" ]; then
		say "reti salvate: nessuna coppia da unire"
	fi
fi

# Migrazione dalla vecchia interfaccia unica: le STA gia' configurate vengono
# spostate su quella della loro radio, altrimenti dopo l'aggiornamento
# resterebbero agganciate a un'interfaccia che non usiamo piu'.
for section in $(uci show wireless 2>/dev/null | sed -n 's/^wireless\.\([^.]*\)=wifi-iface$/\1/p'); do
	[ "$(uci -q get "wireless.$section.mode")" = "sta" ] || continue
	[ "$(uci -q get "wireless.$section.network")" = "wwan" ] || continue
	radio=$(uci -q get "wireless.$section.device")
	[ -n "$radio" ] || continue
	say "sposto $section da wwan a wwan_$radio"
	uci set "wireless.$section.network=wwan_$radio"
	uci commit wireless
	NEED_WIFI_RELOAD=1
done

# La vecchia wwan si rimuove solo quando non la usa piu' nessuno.
if [ -n "$(uci -q get network.wwan)" ]; then
	if uci show wireless 2>/dev/null | grep -q "\.network='wwan'"; then
		say "wwan ancora in uso, la lascio"
	else
		say "rimuovo la vecchia interfaccia wwan"
		uci -q delete network.wwan
		uci commit network
		if [ -n "$WAN_ZONE" ]; then
			uci -q del_list "firewall.$WAN_ZONE.network=wwan"
			uci commit firewall
			NEED_FIREWALL_RELOAD=1
		fi
		NEED_NETWORK_RELOAD=1
	fi
fi

if [ "$NEED_FIREWALL_RELOAD" = "1" ]; then
	/etc/init.d/firewall reload >/dev/null 2>&1
fi
if [ "$NEED_NETWORK_RELOAD" = "1" ]; then
	/etc/init.d/network reload >/dev/null 2>&1
fi
if [ "$NEED_WIFI_RELOAD" = "1" ]; then
	wifi reload >/dev/null 2>&1
fi

if [ "$TRAVEL_INSTALL_TTYD" = "1" ]; then
	if [ -x /usr/bin/ttyd ]; then
		say "terminale web gia' installato"
	else
		say "installo il terminale web (serve Internet)"
		if travel_apk_add luci-app-ttyd; then
			/etc/init.d/ttyd enable  >/dev/null 2>&1 || true
			/etc/init.d/ttyd start   >/dev/null 2>&1 || true
			say "terminale web installato"
		else
			say "ATTENZIONE: installazione fallita (Internet assente?), riprova piu' tardi"
		fi
	fi
fi

# Parametri della riconnessione automatica e della verifica dei portali. Creati
# con valori prudenti se mancano, mai sovrascritti: sono impostazioni dell'utente.
#
# `portal_check` nasce acceso, al contrario di `autoreconnect`: non cambia
# niente sul router - manda una richiesta HTTP e legge cosa torna - e senza di
# lui la dashboard tornerebbe a dire "collegato" su una rete che chiede un
# login. L'indirizzo di verifica non si scrive: il valore incorporato vale
# finche' non c'e' `travel.globals.portal_url` a scavalcarlo.
for pair in "autoreconnect=0" "rssi_min=-78" "roam_hysteresis=8" \
            "blacklist_after=3" "blacklist_ttl=600" "scan_interval=60" \
            "portal_check=1"; do
	opt="${pair%%=*}"
	val="${pair#*=}"
	if [ -z "$(uci -q get "travel.globals.$opt")" ]; then
		uci set "travel.globals.$opt=$val"
		NEED_TRAVEL_COMMIT=1
	fi
done
if [ "$NEED_TRAVEL_COMMIT" = "1" ]; then
	say "aggiungo i parametri di riconnessione a /etc/config/travel"
	uci commit travel
fi

# Porta USB alla massima velocita' che il dispositivo collegato sa negoziare
# La limitazione a USB 2.0 esiste ancora come interruttore nella
# scheda Dispositivo, ma non e' piu' il default: nella sessione in cui era nata,
# lo stack USB del telefono era incantato e a risolvere e' stato un suo riavvio.
# Con il telefono sano la SuperSpeed non e' mai stata riprovata, e non si paga
# un limite permanente su un sospetto mai confermato.
if [ -z "$(uci -q get travel.usb)" ]; then
	say "porta USB: velocita' piena (travel.usb.force_usb2=0)"
	uci set travel.usb=usb
	uci set travel.usb.force_usb2=0
	uci commit travel
fi

# Chi aveva gia' la porta forzata a USB 2.0 dal default di prima torna alla
# velocita' piena, una volta sola: era un default, non una scelta. Da qui in
# poi comanda l'interruttore, e un redeploy non lo tocca piu'.
if [ "$(uci -q get travel.globals.usb_speed_reset)" != "1" ]; then
	if [ "$(uci -q get travel.usb.force_usb2)" = "1" ]; then
		say "porta USB: tolgo il limite a USB 2.0 ereditato dal default precedente"
		uci set travel.usb.force_usb2=0
	fi
	uci set travel.globals.usb_speed_reset=1
	uci commit travel
fi
sh /usr/share/travel/usb-mode.sh apply
say "porta USB: $(sh /usr/share/travel/usb-mode.sh status)"

# Driver per il tethering USB.
#
# Stavano dentro mwan3-setup.sh, che e' il posto sbagliato per due motivi: non
# hanno niente a che vedere con il multi-WAN, e quello script esce prima di
# arrivarci se mwan3 non si installa. Il risultato era un router senza i driver
# e senza niente che lo dicesse - il telefono mostrava il tethering acceso e qui
# non compariva nessuna WAN.
#
# **La prova e' che il modulo si CARICHI, non che il file esista.** La prima
# versione di questo controllo guardava il .ko sul disco, e su un router dove i
# pacchetti erano installati ma `usbnet` non si caricava rispondeva "gia'
# presenti" tirando dritto - il tethering restava invisibile e lo script diceva
# che era tutto a posto. Il file sul disco non e' lo stato che conta.
#
# `usbnet` va per primo: e' la base di cdc_ncm, rndis_host e cdc_ether, e
# quando non si carica lui il log riempie di "dependency not loaded usbnet" e
# sembrano rotti tutti e tre indipendentemente.
USB_NET_MODULES="usbnet cdc_ncm rndis_host cdc_ether"
USB_NET_PACKAGES="kmod-usb-net kmod-usb-net-cdc-ncm kmod-usb-net-rndis kmod-usb-net-cdc-ether"

# Vero se il modulo e' in memoria, provando a caricarlo se non lo e' gia'.
usb_net_module_ok() {
	[ -d "/sys/module/$1" ] && return 0
	modprobe "$1" >/dev/null 2>&1 || true
	[ -d "/sys/module/$1" ]
}

usb_net_broken() {
	local mod list=""
	for mod in $USB_NET_MODULES; do
		usb_net_module_ok "$mod" || list="$list $mod"
	done
	printf '%s' "$list"
}

BROKEN_USB=$(usb_net_broken)

if [ -n "$BROKEN_USB" ]; then
	say "driver per il tethering USB da sistemare:$BROKEN_USB"
	# shellcheck disable=SC2086
	travel_apk_add $USB_NET_PACKAGES || true

	# Secondo giro di caricamento, e non e' ridondante: durante l'installazione
	# kmodloader puo' provare a caricare un driver prima che `usbnet` sia
	# scritto sul disco, e fallire per una dipendenza che un attimo dopo c'e'.
	# E' il motivo per cui rilanciare lo stesso `apk add` a mano "risolveva".
	BROKEN_USB=$(usb_net_broken)
fi

if [ -n "$BROKEN_USB" ]; then
	say "ATTENZIONE: questi moduli non si caricano:$BROKEN_USB"
	for mod in $BROKEN_USB; do
		say "  modprobe $mod: $(modprobe "$mod" 2>&1 | head -n 1)"
	done
	say "Senza, un telefono in tethering resta invisibile: lui mostra la"
	say "condivisione accesa e qui non compare nessuna WAN. Le cause tipiche"
	say "sono due: mancava Internet adesso (rilancia il deploy quando c'e'),"
	say "oppure i kmod non combaciano con il kernel in esecuzione - in quel"
	say "caso servono i pacchetti della stessa build del firmware."
else
	say "driver per il tethering USB caricati"
fi

# Multi-WAN: installazione e configurazione generata. Non blocca il
# resto se manca Internet: lo script lo dice e si esce puliti.
chmod 0755 /usr/share/travel/mwan3-setup.sh
say "multi-WAN"
sh /usr/share/travel/mwan3-setup.sh

# IPv6 sulle WAN: una interfaccia logica esplicita per ognuna.
#
# Su OpenWrt 25.12 non esiste nessun altro modo, e la migrazione `ipv6_init`
# piu' sopra da sola non accende niente. Verificato sul router:
# /lib/netifd/proto/dhcp.sh non nomina mai l'opzione `ipv6`, e nessuno script in
# /lib/netifd/proto/ crea alias `<net>_6` al volo. Senza una `config interface`
# dedicata IPv6 su una WAN semplicemente non si alza - ed e' lo stesso motivo
# per cui l'immagine di fabbrica porta gia' un `wan6` accanto a `wan`.
#
# STA DOPO mwan3-setup.sh, e non e' un dettaglio di ordinamento: le metriche
# delle WAN v4 le assegna lui, e su un'installazione nuova prima del suo giro
# non esistono. Piu' in alto ogni gemella nascerebbe con metrica 0 - tutte
# uguali, tutte "migliori" - e siccome le sezioni si creano una volta sola,
# quel valore sbagliato non lo correggerebbe piu' nessuno.
for net in $(uci -q get "firewall.$WAN_ZONE.network"); do
	[ -n "$(uci -q get "network.$net")" ] || continue
	# Solo le WAN v4: cosi' `wan6` e le altre gemelle non generano una gemella
	# della gemella.
	[ "$(uci -q get "network.$net.proto")" = "dhcp" ] || continue

	net6="${net}6"
	if [ -n "$(uci -q get "network.$net6")" ]; then
		say "interfaccia $net6 gia' presente"
	else
		say "creo l'interfaccia $net6 (DHCPv6 su $net)"
		uci set "network.$net6=interface"
		uci set "network.$net6.proto=dhcpv6"
		# Il riferimento simbolico e non il nome del device: per una STA WiFi il
		# device in uci non c'e' affatto - glielo assegna la sezione wireless -
		# e cambia quando la radio si riassocia. Cosi' la gemella segue la
		# sorella v4 dovunque vada.
		uci set "network.$net6.device=@$net"
		uci commit network
		NEED_IPV6_NETWORK_RELOAD=1
	fi

	# La metrica si riallinea a OGNI giro, non solo alla creazione: quella della
	# sorella v4 cambia ogni volta che si riordinano le priorita' delle WAN
	# dall'interfaccia, e una gemella rimasta indietro manderebbe IPv6 fuori da
	# una WAN diversa da IPv4. E' il guasto in cui "meta' del web carica", molto
	# piu' difficile da diagnosticare di una caduta pulita.
	#
	# Vale anche per il `wan6` dell'immagine, che nasce con metrica 0: la sua
	# metrica non e' una preferenza dell'utente, e' la meta' v6 di una coppia.
	# `|| true` per la stessa ragione di `net_get` piu' sopra: con `set -e` una
	# assegnazione da un'opzione che non c'e' ferma tutto lo script. E qui il
	# caso non e' teorico - mwan3-setup.sh esce prima di assegnare le metriche
	# quando mwan3 non e' installabile perche' manca Internet, e proprio allora
	# saltare il resto del setup sarebbe il danno peggiore.
	metric=$(uci -q get "network.$net.metric" 2>/dev/null || true)
	if [ -n "$metric" ] && [ "$metric" != "$(uci -q get "network.$net6.metric" || true)" ]; then
		say "$net6: metrica $metric, come $net"
		uci set "network.$net6.metric=$metric"
		uci commit network
		NEED_IPV6_NETWORK_RELOAD=1
	fi

	# Senza zona firewall il traffico v6 verso la rete a monte non passa, e la
	# WAN sembrerebbe su senza portare niente.
	if [ -n "$WAN_ZONE" ]; then
		if uci -q get "firewall.$WAN_ZONE.network" | tr ' ' '\n' | grep -qx "$net6"; then
			say "$net6 gia' nella zona firewall wan"
		else
			say "aggiungo $net6 alla zona firewall wan"
			uci add_list "firewall.$WAN_ZONE.network=$net6"
			uci commit firewall
			NEED_IPV6_FIREWALL_RELOAD=1
		fi
	else
		say "ATTENZIONE: zona firewall 'wan' non trovata, $net6 non e' stata aggiunta"
	fi
done

# Ricarica sua, perche' questo ciclo gira DOPO il blocco che ricarica rete e
# firewall piu' in alto. Contatori separati e non i soliti NEED_*: quelli sono
# gia' stati letti e riazzerare i loro non direbbe niente a nessuno, mentre
# riusarli farebbe credere al prossimo lettore che il reload di sopra copra
# anche questa parte.
if [ "$NEED_IPV6_FIREWALL_RELOAD" = "1" ]; then
	/etc/init.d/firewall reload >/dev/null 2>&1
fi
if [ "$NEED_IPV6_NETWORK_RELOAD" = "1" ]; then
	say "ricarico la rete per le interfacce IPv6"
	/etc/init.d/network reload >/dev/null 2>&1
fi

# VPN: tailscale e la regola del kill switch. Come per il multi-WAN,
# la mancanza di Internet non blocca il resto: lo script lo dice ed esce.
say "VPN"
sh /usr/share/travel/vpn-setup.sh

say "avvio travelD"
/etc/init.d/travel enable  >/dev/null 2>&1
/etc/init.d/travel-led enable
/etc/init.d/travel-led start
# La posizione registrata l'ha scritta la versione di prima, che poteva leggere
# la levetta al contrario: si riparte da "non lo so", che e' la verita' finche'
# il kernel non manda un evento nuovo. Al riavvio sparirebbe da sola.
rm -f /var/run/travel-toggle.position
/etc/init.d/travel-toggle enable
/etc/init.d/travel-toggle start
/etc/init.d/travel restart >/dev/null 2>&1

say "riavvio rpcd"
/etc/init.d/rpcd restart
# Si aspetta che il plugin risponda davvero, con tentativi brevi, invece di una
# pausa fissa. Il riavvio torna prima che il vecchio rpcd sia morto - spesso va
# finito con SIGKILL, perche' sta servendo una chiamata lenta di travelD - e
# finche' c'e' l'oggetto `travel` resta suo: una chiamata partita in quel
# momento aspettava tutti i 30 secondi del timeout e faceva fallire il deploy
# a installazione gia' completa.
_tries=0
until ubus -t 3 call travel status >/dev/null 2>&1; do
	_tries=$((_tries + 1))
	[ "$_tries" -lt 10 ] || break
	sleep 1
done

if [ "$NEED_UHTTPD_RELOAD" = "1" ]; then
	say "ricarico uhttpd"
	/etc/init.d/uhttpd reload
fi

say "verifica: ubus call travel status"
ubus call travel status

printf '\n'
say "verifica: ubus call traveld status"
if ubus call traveld status 2>/dev/null; then
	:
else
	say "travelD non ha registrato l'oggetto ubus. Cosa dice il log:"
	logread 2>/dev/null | grep -i traveld | tail -n 15
	say ""
	say "Il resto dell'interfaccia funziona lo stesso: travelD serve solo alla"
	say "riconnessione automatica, che non e' ancora attiva."
fi
