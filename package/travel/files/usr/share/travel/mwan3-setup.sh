#!/bin/sh
# Fondamenta multi-WAN (requisiti A e B): installa mwan3 e genera una
# configurazione coerente per ogni WAN della zona firewall.
#
# Idempotente. Le sezioni che l'utente puo' aver ritoccato (pesi, priorita',
# tracking IP) non vengono sovrascritte: si creano solo quelle mancanti, cosi'
# una porta commutata in WAN dopo l'installazione compare da sola.
#
# Chiamato da setup.sh; puo' essere rilanciato a mano in qualsiasi momento.

say() { printf '  %s\n' "$*"; }

# --- 1. Pacchetti -------------------------------------------------------------

have_mwan3() { [ -x /usr/sbin/mwan3 ] || [ -x /etc/init.d/mwan3 ]; }

if have_mwan3; then
	say "mwan3 gia' installato"
else
	say "installo mwan3 (serve Internet)"
	. /usr/share/travel/online.sh
	if travel_apk_add mwan3 ip-full && have_mwan3; then
		say "mwan3 installato"
	else
		say "ATTENZIONE: mwan3 non installato (Internet assente?). Tutto il resto"
		say "funziona; il bilanciamento e il failover arriveranno al prossimo setup"
		say "con una connessione attiva."
		exit 0
	fi
fi

# --- 2. Flow offload spento ---------------------------------------------------
#
# L'offload fa saltare i pacchetti fuori dal percorso netfilter dopo il primo:
# mwan3 non vede piu' i suoi mark e conntrack non vede piu' le connessioni.
# Costo dichiarato: meno throughput di routing. Su un uplink d'albergo non si
# nota; su fibra da 2.5G si noterebbe, ma non e' questo il caso d'uso.
for opt in flow_offloading flow_offloading_hw; do
	if [ "$(uci -q get firewall.@defaults[0].$opt)" = "1" ]; then
		say "disattivo $opt (incompatibile con mwan3 e conntrack)"
		uci set "firewall.@defaults[0].$opt=0"
		NEED_FW=1
	fi
done
[ "$NEED_FW" = "1" ] && uci commit firewall && /etc/init.d/firewall reload >/dev/null 2>&1

# --- 3. Metriche distinte per ogni WAN ---------------------------------------
#
# Il kernel tiene una sola rotta predefinita per metrica: due WAN con la
# stessa metrica si pestano i piedi. mwan3 pretende metriche distinte.
# L'ordine iniziale riflette la preferenza di viaggio: ethernet, poi WiFi 5,
# poi 2.4, poi tethering. Si cambia dall'interfaccia.
zone=$(uci show firewall 2>/dev/null | sed -n "s/^firewall\.\(@zone\[[0-9]*\]\)\.name='wan'\$/\1/p" | head -n 1)

# Porte che stanno nel bridge della LAN: sono LAN, non uplink, e non devono
# ricevere sezioni mwan3. Stesso criterio del plugin rpcd.
lan_ports=$(uci show network 2>/dev/null \
	| sed -n "s/^network\.[^.]*\.ports='\(.*\)'\$/\1/p" | tr "' " '  ')

wans=""
for net in $(uci -q get "firewall.$zone.network"); do
	case "$(uci -q get "network.$net.proto")" in
		dhcpv6|6in4|6to4|6rd|464xlat|'') continue ;;
	esac
	# Le interfacce disattivate NON si saltano qui: `wan_usb` nasce disattivata
	# e deve avere comunque le sue sezioni mwan3 pronte, altrimenti al primo
	# telefono attaccato mancherebbero tracking IP e priorita' proprio quando
	# servono. Una porta commutata in LAN e' esclusa dal controllo sul bridge
	# qui sotto, che e' il criterio giusto per quel caso.
	device=$(uci -q get "network.$net.device")
	if [ -n "$device" ]; then
		skip=0
		for entry in $lan_ports; do
			[ "$entry" = "$device" ] && skip=1
		done
		[ "$skip" = "1" ] && continue
	fi

	wans="$wans $net"
done

# Attenzione all'ordine: in un `case` vince il primo modello che combacia, e
# `wan_*` intercetterebbe anche `wan_usb`. Il tethering va per ultimo perche' e'
# la WAN a consumo: preferirla al WiFi significa bruciare dati del telefono
# avendo un'alternativa gratuita disponibile.
initial_metric() {
	case "$1" in
		wan_usb|usb*) echo 40 ;;
		wan)          echo 10 ;;
		wan_*)        echo 15 ;;
		wwan_radio1)  echo 20 ;;
		wwan_radio0)  echo 30 ;;
		*)            echo 50 ;;
	esac
}

used=""
for net in $wans; do
	m=$(uci -q get "network.$net.metric")
	if [ -z "$m" ]; then
		m=$(initial_metric "$net")
		# Evita collisioni se due WAN cadono nello stesso gruppo.
		while printf '%s' "$used" | grep -qw "$m"; do m=$((m + 1)); done
		say "metrica $m per $net"
		uci set "network.$net.metric=$m"
		NEED_NET=1
	fi
	used="$used $m"
done
[ "$NEED_NET" = "1" ] && uci commit network

# --- 4. Configurazione mwan3 -------------------------------------------------
#
# Tracking IP DISTINTI per ogni WAN (requisito B): se tutte pingassero lo
# stesso indirizzo e quello avesse un problema, tutte le WAN sembrerebbero
# morte insieme. Si ruota su una rosa di resolver pubblici.
pool="1.1.1.1 8.8.8.8 9.9.9.9 208.67.222.222 1.0.0.1 8.8.4.4 149.112.112.112 208.67.220.220"

# Lo stesso in IPv6. Deve essere un pool a se': un ping IPv6 verso 1.1.1.1 non
# esiste, e mwan3 dichiarerebbe la WAN v6 morta per sempre.
pool6="2606:4700:4700::1111 2001:4860:4860::8888 2620:fe::fe 2a0d:2a00:1:: 2606:4700:4700::1001 2001:4860:4860::8844 2620:fe::9 2a0d:2a00:2::"

# $1 = indice della WAN, $2 = il pool. Ne prende due sfalsate.
#
# Il pool e' un parametro e non una variabile globale: le due famiglie ruotano
# con la stessa regola, e averne due copie sarebbe il modo in cui una delle due
# smette di ruotare senza che nessuno se ne accorga.
pick_track_ips() {
	local i="$1" n=0 a="" b=""
	for ip in $2; do
		[ "$n" = "$((i * 2 % 8))" ] && a="$ip"
		[ "$n" = "$(((i * 2 + 1) % 8))" ] && b="$ip"
		n=$((n + 1))
	done
	printf '%s %s' "$a" "$b"
}

touch /etc/config/mwan3
idx=0
for net in $wans; do
	if [ -z "$(uci -q get "mwan3.$net")" ]; then
		say "mwan3: interfaccia $net"
		uci set "mwan3.$net=interface"
		uci set "mwan3.$net.enabled=1"
		for ip in $(pick_track_ips "$idx" "$pool"); do
			uci add_list "mwan3.$net.track_ip=$ip"
		done
		uci set "mwan3.$net.track_method=ping"
		uci set "mwan3.$net.reliability=1"
		uci set "mwan3.$net.count=1"
		uci set "mwan3.$net.timeout=2"
		uci set "mwan3.$net.interval=5"
		uci set "mwan3.$net.down=3"
		uci set "mwan3.$net.up=3"
		uci set "mwan3.$net.family=ipv4"
		NEED_MWAN=1
	fi

	# Due membri per WAN: uno per il failover (metrica = priorita', peso 1),
	# uno per il bilanciamento (metrica uguale per tutti, peso configurabile).
	# mwan3 bilancia solo fra membri con la stessa metrica: e' il motivo per cui
	# servono due insiemi e non uno.
	if [ -z "$(uci -q get "mwan3.${net}_f")" ]; then
		uci set "mwan3.${net}_f=member"
		uci set "mwan3.${net}_f.interface=$net"
		uci set "mwan3.${net}_f.metric=$(uci -q get "network.$net.metric")"
		uci set "mwan3.${net}_f.weight=1"
		NEED_MWAN=1
	fi
	if [ -z "$(uci -q get "mwan3.${net}_b")" ]; then
		uci set "mwan3.${net}_b=member"
		uci set "mwan3.${net}_b.interface=$net"
		uci set "mwan3.${net}_b.metric=1"
		uci set "mwan3.${net}_b.weight=1"
		NEED_MWAN=1
	fi

	# --- La gemella IPv6 ---------------------------------------------------
	#
	# `mwan3.<sezione>` e' MONO-FAMIGLIA, e il nome della sezione deve essere
	# quello di un'interfaccia netifd vera: e' il motivo per cui questo blocco
	# non poteva esistere prima della Fase 4, che le sezioni `<net>6` le crea.
	# Se manca, si salta: un profilo a meta' e' peggio di nessun profilo.
	if [ -n "$(uci -q get "network.${net}6")" ]; then
		if [ -z "$(uci -q get "mwan3.${net}6")" ]; then
			say "mwan3: interfaccia ${net}6"
			uci set "mwan3.${net}6=interface"
			uci set "mwan3.${net}6.enabled=$(uci -q get "mwan3.$net.enabled" || echo 1)"
			for ip in $(pick_track_ips "$idx" "$pool6"); do
				uci add_list "mwan3.${net}6.track_ip=$ip"
			done
			uci set "mwan3.${net}6.track_method=ping"
			uci set "mwan3.${net}6.reliability=1"
			uci set "mwan3.${net}6.count=1"
			uci set "mwan3.${net}6.timeout=2"
			uci set "mwan3.${net}6.interval=5"
			uci set "mwan3.${net}6.down=3"
			uci set "mwan3.${net}6.up=3"
			uci set "mwan3.${net}6.family=ipv6"
			NEED_MWAN=1
		fi

		# Le metriche partono da quelle della sorella v4: se le due famiglie
		# preferissero WAN diverse, meta' del web caricherebbe - un guasto molto
		# piu' difficile da diagnosticare di uno pulito.
		if [ -z "$(uci -q get "mwan3.${net}6_f")" ]; then
			uci set "mwan3.${net}6_f=member"
			uci set "mwan3.${net}6_f.interface=${net}6"
			uci set "mwan3.${net}6_f.metric=$(uci -q get "mwan3.${net}_f.metric" || uci -q get "network.$net.metric")"
			uci set "mwan3.${net}6_f.weight=1"
			NEED_MWAN=1
		fi
		if [ -z "$(uci -q get "mwan3.${net}6_b")" ]; then
			uci set "mwan3.${net}6_b=member"
			uci set "mwan3.${net}6_b.interface=${net}6"
			uci set "mwan3.${net}6_b.metric=1"
			uci set "mwan3.${net}6_b.weight=$(uci -q get "mwan3.${net}_b.weight" || echo 1)"
			NEED_MWAN=1
		fi
	fi

	idx=$((idx + 1))
done

# Migrazione dei nomi delle politiche per WAN.
#
# mwan3 impone 15 caratteri ai nomi delle politiche: e' il limite dei nomi di
# catena di iptables, e mwan3 lo fa rispettare rifiutando la politica. Con i
# prefissi vecchi `only_wwan_radio0` ne faceva 16, e nel log del router
# comparivano righe come:
#
#   Policy only_wwan_radio0 exceeds max of 15 chars. Not setting policy
#
# La politica non veniva applicata e le regole che la usavano non facevano
# niente, in silenzio: la peggior specie di guasto. I prefissi passano quindi
# da `only_`/`pref_` a `o_`/`p_`, che lasciano 13 caratteri al nome della WAN.
for net in $wans; do
	for pair in "only_ o_" "pref_ p_"; do
		old_name="${pair%% *}$net"
		new_name="${pair#* }$net"
		[ -n "$(uci -q get "mwan3.$old_name")" ] || continue
		say "rinomino la politica $old_name in $new_name (limite di mwan3)"
		# Le regole che puntavano al nome vecchio vanno seguite nella stessa
		# passata, altrimenti restano appese a una politica che non esiste piu'.
		for rule in $(uci show mwan3 2>/dev/null | sed -n 's/^mwan3\.\([^.]*\)=rule$/\1/p'); do
			[ "$(uci -q get "mwan3.$rule.use_policy")" = "$old_name" ] \
				&& uci set "mwan3.$rule.use_policy=$new_name"
		done
		uci -q delete "mwan3.$old_name"
		NEED_MWAN=1
	done
done

# Due politiche per ogni WAN, per le regole di instradamento (requisito B):
#
#   o_<wan>  la usa e basta. Se cade, il traffico di quella regola si ferma.
#   p_<wan>  la preferisce. Se cade, il traffico torna sul routing normale.
#
# Servono entrambe perche' `last_resort` e' una proprieta' della politica, non
# della regola: non si puo' scegliere il comportamento senza cambiare politica.
for net in $wans; do
	# Il limite si ricontrolla qui invece di darlo per scontato: un nome di WAN
	# lungo lo sfonderebbe di nuovo, e un avviso e' meglio di una politica che
	# non viene applicata senza dirlo.
	if [ ${#net} -gt 13 ]; then
		say "ATTENZIONE: $net e' troppo lungo per una politica mwan3 (max 13"
		say "caratteri): le regole dedicate a questa WAN non funzioneranno"
		continue
	fi

	if [ -z "$(uci -q get "mwan3.o_$net")" ]; then
		uci set "mwan3.o_$net=policy"
		uci set "mwan3.o_$net.last_resort=unreachable"
		uci add_list "mwan3.o_$net.use_member=${net}_f"
		NEED_MWAN=1
	fi
	if [ -z "$(uci -q get "mwan3.p_$net")" ]; then
		uci set "mwan3.p_$net=policy"
		uci set "mwan3.p_$net.last_resort=default"
		uci add_list "mwan3.p_$net.use_member=${net}_f"
		NEED_MWAN=1
	fi

	# Le gemelle IPv6 delle politiche per WAN. Il nome cresce di un carattere,
	# quindi il limite qui e' 12 e non 13: `o_wwan_radio06` ne fa gia' 14.
	[ -n "$(uci -q get "network.${net}6")" ] || continue
	if [ ${#net} -gt 12 ]; then
		say "ATTENZIONE: ${net}6 e' troppo lungo per una politica mwan3: le"
		say "regole IPv6 dedicate a questa WAN non funzioneranno"
		continue
	fi
	if [ -z "$(uci -q get "mwan3.o_${net}6")" ]; then
		uci set "mwan3.o_${net}6=policy"
		uci set "mwan3.o_${net}6.last_resort=unreachable"
		uci add_list "mwan3.o_${net}6.use_member=${net}6_f"
		NEED_MWAN=1
	fi
	if [ -z "$(uci -q get "mwan3.p_${net}6")" ]; then
		uci set "mwan3.p_${net}6=policy"
		uci set "mwan3.p_${net}6.last_resort=default"
		uci add_list "mwan3.p_${net}6.use_member=${net}6_f"
		NEED_MWAN=1
	fi
done

# Le due politiche esistono sempre entrambe; la regola predefinita punta a
# quella della modalita' scelta. Cambiare modalita' = cambiare un'opzione.
for pol in travel_failover travel_balance; do
	if [ -z "$(uci -q get "mwan3.$pol")" ]; then
		say "mwan3: politica $pol"
		uci set "mwan3.$pol=policy"
		uci set "mwan3.$pol.last_resort=unreachable"
		NEED_MWAN=1
	fi
	# I membri si riallineano sempre: una WAN nuova deve entrare.
	uci -q delete "mwan3.$pol.use_member"
	suffix=$([ "$pol" = "travel_failover" ] && echo f || echo b)
	for net in $wans; do
		uci add_list "mwan3.$pol.use_member=${net}_$suffix"
	done
	NEED_MWAN=1
done

# Le gemelle IPv6 delle due politiche globali.
#
# **`travel_failover6` NON si puo' usare**: fa 16 caratteri, e mwan3 impone 15
# ai nomi delle politiche - lo stesso limite che ha gia' morso una volta con
# `only_wwan_radio0`, e allo stesso modo: la politica non viene applicata e le
# regole che la usano non fanno niente, senza un errore che lo dica. Da qui
# `travel_fail6` e `travel_bal6`, che di caratteri ne fanno 12 e 11.
for pol in travel_fail6 travel_bal6; do
	if [ -z "$(uci -q get "mwan3.$pol")" ]; then
		say "mwan3: politica $pol"
		uci set "mwan3.$pol=policy"
		uci set "mwan3.$pol.last_resort=unreachable"
		NEED_MWAN=1
	fi
	uci -q delete "mwan3.$pol.use_member"
	suffix=$([ "$pol" = "travel_fail6" ] && echo f || echo b)
	for net in $wans; do
		[ -n "$(uci -q get "network.${net}6")" ] || continue
		uci add_list "mwan3.$pol.use_member=${net}6_$suffix"
	done
	NEED_MWAN=1
done

if [ -z "$(uci -q get mwan3.travel_default)" ]; then
	say "mwan3: regola predefinita in failover"
	uci set "mwan3.travel_default=rule"
	uci set "mwan3.travel_default.dest_ip=0.0.0.0/0"
	uci set "mwan3.travel_default.family=ipv4"
	uci set "mwan3.travel_default.use_policy=travel_failover"
	NEED_MWAN=1
fi

# La regola predefinita IPv6: una regola VERA con `dest_ip='::/0'`, non
# l'assenza di una regola.
#
# Senza, il traffico v6 non entra in nessuna politica mwan3 e segue le rotte
# normali: continuerebbe a funzionare, ma uscirebbe da una WAN scelta dal
# kernel invece che da quella che l'utente ha messo per prima - cioe' v4 e v6
# uscirebbero da due WAN diverse senza che niente lo dica.
if [ -z "$(uci -q get mwan3.travel_default6)" ]; then
	say "mwan3: regola predefinita IPv6 in failover"
	uci set "mwan3.travel_default6=rule"
	uci set "mwan3.travel_default6.dest_ip=::/0"
	uci set "mwan3.travel_default6.family=ipv6"
	uci set "mwan3.travel_default6.use_policy=travel_fail6"
	NEED_MWAN=1
fi

# La sezione globale di mwan3 deve esistere, altrimenti il servizio non parte.
[ -z "$(uci -q get mwan3.globals)" ] && {
	uci set mwan3.globals=globals
	uci set mwan3.globals.mmx_mask=0x3F00
	NEED_MWAN=1
}

if [ "$NEED_MWAN" = "1" ]; then
	uci commit mwan3
	/etc/init.d/mwan3 enable >/dev/null 2>&1
	/etc/init.d/mwan3 restart >/dev/null 2>&1
	say "mwan3 configurato e avviato"
fi

# Verifica: l'oggetto ubus di mwan3 e' il canale che l'interfaccia leggera'.
sleep 2
if ubus list 2>/dev/null | grep -qx mwan3; then
	say "verifica: ubus call mwan3 status"
	ubus call mwan3 status 2>/dev/null | head -n 30
else
	say "ATTENZIONE: l'oggetto ubus mwan3 non c'e'. Il pacchetto potrebbe"
	say "non includere il plugin rpcd, oppure il servizio non e' partito:"
	logread 2>/dev/null | grep -i mwan3 | tail -n 10
fi
