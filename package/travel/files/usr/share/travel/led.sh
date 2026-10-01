#!/bin/sh
# Controllo riutilizzabile: source per led_get/led_set/led_apply, oppure
# sh /usr/share/travel/led.sh apply per ripristinare la scelta persistente.
. /lib/functions/leds.sh

# Il motivo esce su stderr, com'e' sempre stato: e' quello che finisce nei log.
# Il primo argomento e' un codice stabile e i seguenti, dopo il messaggio, coppie
# chiave/valore: se chi chiama ha indicato un file in TRAVEL_ERR_FILE - l'rpcd,
# per mostrare l'errore nella lingua dell'interfaccia - ci finiscono una per
# riga, il codice per primo.
led_error() {
	_err_code="$1"
	shift
	printf '%s\n' "$1" >&2
	shift
	[ -z "${TRAVEL_ERR_FILE:-}" ] || printf '%s\n' "$_err_code" "$@" > "$TRAVEL_ERR_FILE"
	return 0
}

# Solo i LED dichiarati dal device tree per lo stato del router. Sul Beryl 7
# running e' blu, boot bianco: OFF deve spegnere entrambi i colori.
led_detect() {
	local role name seen=' '
	LED_RUNNING=$(get_dt_led running)
	LED_DEVICES=''
	for role in running boot failsafe upgrade; do
		name=$(get_dt_led "$role")
		case "$name" in
			'') continue ;;
			*/*|*[!A-Za-z0-9_:.-]*) led_error led_bad_name 'Nome LED non valido.'; return 1 ;;
		esac
		case "$seen" in *" $name "*) continue ;; esac
		if [ ! -r "/sys/class/leds/$name/brightness" ] ||
			[ ! -w "/sys/class/leds/$name/brightness" ] ||
			[ ! -w "/sys/class/leds/$name/trigger" ]; then
			led_error led_unavailable 'LED di stato non disponibile su questo router.'
			return 1
		fi
		seen="$seen$name "
		LED_DEVICES="$LED_DEVICES $name"
	done
	case "$seen" in *" $LED_RUNNING "*) [ -n "$LED_RUNNING" ] && return 0 ;; esac
	led_error led_unavailable 'LED di stato non disponibile su questo router.'
	return 1
}

led_get() {
	local brightness
	LED_ENABLED=$(uci -q get travel_led.main.enabled)
	case "$LED_ENABLED" in
		0|1) return 0 ;;
		'')
			# Prima della prima scelta si mostra lo stato hardware corrente.
			brightness=$(cat "/sys/class/leds/$LED_RUNNING/brightness") || return 1
			LED_ENABLED=0
			[ "$brightness" -gt 0 ] && LED_ENABLED=1
			return 0 ;;
		*) led_error led_bad_config 'Configurazione del LED non valida.'; return 1 ;;
	esac
}

led_write() {
	local want="$1" name value
	for name in $LED_DEVICES; do
		value=0
		if [ "$want" = 1 ] && [ "$name" = "$LED_RUNNING" ]; then
			value=$(cat "/sys/class/leds/$name/max_brightness") || return 1
			case "$value" in ''|*[!0-9]*) return 1 ;; esac
			[ "$value" -gt 0 ] || return 1
		fi
		printf '%s\n' none > "/sys/class/leds/$name/trigger" || return 1
		printf '%s\n' "$value" > "/sys/class/leds/$name/brightness" || return 1
	done
}

# Runtime e persistenza condividono il lock, anche fra processi RPC distinti.
# La configurazione dedicata evita di committare modifiche di rete pendenti.
led_set() (
	local want="$1" persist="${2:-1}" name trigger brightness snapshot='' tmp=''
	case "$want" in 0|1) ;; *) led_error led_bad_state 'Stato LED non valido.'; exit 1 ;; esac
	mkdir /var/lock/travel-led 2>/dev/null || {
		led_error led_busy 'Modifica del LED in corso. Riprova.'; exit 1
	}
	trap '[ -z "$tmp" ] || rm -f "$tmp"; rmdir /var/lock/travel-led' EXIT
	led_detect || exit 1
	for name in $LED_DEVICES; do
		trigger=$(sed -n 's/.*\[\([^]]*\)\].*/\1/p' "/sys/class/leds/$name/trigger")
		brightness=$(cat "/sys/class/leds/$name/brightness") || exit 1
		[ -n "$trigger" ] || { led_error led_read_failed 'Impossibile leggere il LED.'; exit 1; }
		snapshot="$snapshot$name $trigger $brightness
"
	done
	led_restore() {
		printf '%s' "$snapshot" | while read -r name trigger brightness; do
			printf '%s\n' none > "/sys/class/leds/$name/trigger"
			printf '%s\n' "$brightness" > "/sys/class/leds/$name/brightness"
			printf '%s\n' "$trigger" > "/sys/class/leds/$name/trigger"
		done
	}
	if ! led_write "$want"; then
		led_restore
		led_error led_apply_failed 'Impossibile applicare lo stato del LED.'
		exit 1
	fi
	[ "$persist" = 1 ] || exit 0
	# Non riscrivere la flash per una scelta gia' salvata.
	[ "$(uci -q get travel_led.main.enabled)" = "$want" ] && exit 0
	tmp=$(mktemp /etc/config/.travel-led.XXXXXX)
	if [ -n "$tmp" ] &&
		printf "config led 'main'\n\toption enabled '%s'\n" "$want" > "$tmp" &&
		chmod 600 "$tmp" && mv -f "$tmp" /etc/config/travel_led; then
		tmp=''
	else
		led_restore
		led_error led_save_failed 'Impossibile salvare lo stato del LED.'
		exit 1
	fi
)

led_apply() {
	local want
	want=$(uci -q get travel_led.main.enabled)
	# Nessuna preferenza: conserva il comportamento iniziale di OpenWrt.
	[ -n "$want" ] || return 0
	led_set "$want" 0
}

case "$1" in apply) led_apply ;; esac
