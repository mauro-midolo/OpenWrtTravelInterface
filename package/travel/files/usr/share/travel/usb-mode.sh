#!/bin/sh
# Modalita' della porta USB: opzionalmente forza USB 2.0 spegnendo le porte
# SuperSpeed del root hub.
#
# **Il default e' la velocita' piena.** La limitazione a USB 2.0 nasce da una
# sessione in cui il link SuperSpeed con il telefono non si negoziava (`usb
# usb2-port1: Cannot enable`) e il tethering cadeva dopo una decina di secondi;
# spegnere la SuperSpeed rendeva il collegamento stabile. Ma nella stessa
# sessione lo stack USB del telefono era rimasto incantato, e a rimettere in
# sesto le cose e' stato un suo riavvio: con il telefono sano la SuperSpeed non
# e' mai stata riprovata. Tenerla spenta per default significherebbe pagare per
# sempre un prezzo su un sospetto mai confermato.
#
# Resta quindi come interruttore, non come regola: se il tethering ricomincia a
# cadere dopo pochi secondi, accenderlo dalla scheda Dispositivo e' la prima
# cosa da provare. Con la porta USB 3 del root hub spenta il telefono non trova
# la terminazione SuperSpeed, ripiega da solo su USB 2.0 e si enumera sulle
# coppie High Speed. Per il tethering non si perde nulla: la connessione di un
# telefono sta ben sotto i 480 Mbit/s.
#
# Uso:
#   usb-mode.sh apply     applica quello che dice `travel.usb.force_usb2`
#   usb-mode.sh status    stampa usb2 | usb3 | unsupported

log() { logger -t travel-usb "$@"; }

# Le porte dei root hub SuperSpeed.
#
# I device "porta" non stanno in /sys/bus/usb/devices - non appartengono a
# nessun bus, motivo per cui un `ls` li' non li trova - ma sotto l'interfaccia
# dell'hub: usbN/N-0:1.0/usbN-portM. Il root hub e' SuperSpeed se dichiara
# almeno 5000 Mbit/s.
ss_ports() {
	local hub speed port
	for hub in /sys/bus/usb/devices/usb[0-9]*; do
		[ -d "$hub" ] || continue
		read -r speed < "$hub/speed" 2>/dev/null || continue
		[ "$speed" -ge 5000 ] 2>/dev/null || continue
		for port in "$hub"/*-0:1.0/usb*-port[0-9]*; do
			[ -e "$port/disable" ] && printf '%s\n' "$port"
		done
	done
}

# Dopo un rebind del controller, o a inizio boot, le porte possono comparire
# con un attimo di ritardo rispetto al root hub.
wait_ports() {
	local i=0
	while [ "$i" -lt 5 ]; do
		[ -n "$(ss_ports)" ] && return 0
		sleep 1
		i=$((i + 1))
	done
	return 1
}

apply() {
	local want port cur name
	want=$(uci -q get travel.usb.force_usb2)
	# Assente significa velocita' piena: la limitazione e' una scelta esplicita.
	[ -n "$want" ] || want=0

	wait_ports || {
		log "nessuna porta SuperSpeed con controllo di stato: kernel senza l'attributo 'disable'?"
		return 1
	}

	for port in $(ss_ports); do
		name=${port##*/}
		read -r cur < "$port/disable" 2>/dev/null
		if [ "$want" = "1" ]; then
			[ "$cur" = "1" ] && continue
			if printf 1 > "$port/disable" 2>/dev/null; then
				log "$name: SuperSpeed spenta, le periferiche si collegano in USB 2.0"
			else
				log "$name: non riesco a spegnere la SuperSpeed"
			fi
		else
			[ "$cur" = "0" ] && continue
			if printf 0 > "$port/disable" 2>/dev/null; then
				log "$name: SuperSpeed riattivata"
			else
				log "$name: non riesco a riattivare la SuperSpeed"
			fi
		fi
	done
}

status() {
	local port cur any=0 alloff=1
	for port in $(ss_ports); do
		any=1
		read -r cur < "$port/disable" 2>/dev/null
		[ "$cur" = "1" ] || alloff=0
	done
	if [ "$any" = "0" ]; then
		echo unsupported
	elif [ "$alloff" = "1" ]; then
		echo usb2
	else
		echo usb3
	fi
}

case "$1" in
	apply)  apply ;;
	status) status ;;
	*)      echo "uso: $0 apply|status" >&2; exit 2 ;;
esac
