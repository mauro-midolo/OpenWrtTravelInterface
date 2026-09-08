#!/bin/sh
# Interruttore fisico del router.
#
# Quattro cose distinte, e questo file ne contiene tre:
#
#   rilevamento    /etc/rc.button/BTN_* - dice solo "on" oppure "off"
#   configurazione quale azione e' associata, salvata in /etc/config
#   registro      l'elenco delle azioni possibili e cosa fa ognuna
#   esecuzione    toggle_run: legge la configurazione e chiama l'azione
#
# Il rilevamento non sa quale azione girera', e le azioni non sanno da dove
# arriva l'evento: aggiungerne una non tocca /etc/rc.button.

TOGGLE_POSITION_FILE=/var/run/travel-toggle.position
TOGGLE_LOCK=/var/lock/travel-toggle

# Quanto aspetta un evento della levetta se qualcuno sta salvando: il tempo di
# una scrittura in flash, non di piu'.
TOGGLE_LOCK_WAIT=5

toggle_error() { printf '%s\n' "$*" >&2; }

# --- Turni -------------------------------------------------------------------

# Un solo lock per tutto quello che tocca l'interruttore: salvataggio,
# allineamento e ritorno indietro.
#
# Serve perche' la scelta diventa visibile appena salvata, mentre chi la sta
# salvando non ha ancora finito di allinearla. Un evento della levetta che
# entrasse in quel mezzo agirebbe sulla funzione nuova - accendendo e salvando
# il LED per conto suo - e il ritorno indietro rimetterebbe a posto la scelta
# lasciando il LED dove l'evento l'ha messo.
toggle_lock() {
	local waited=0 limit="${1:-0}"
	until mkdir "$TOGGLE_LOCK" 2>/dev/null; do
		[ "$waited" -lt "$limit" ] || return 1
		sleep 1
		waited=$((waited + 1))
	done
	return 0
}

toggle_unlock() { rmdir "$TOGGLE_LOCK" 2>/dev/null; }

# --- Registro delle azioni ---------------------------------------------------
#
# Per aggiungerne una: un id qui e una funzione `toggle_do_<id>` che riceve
# "on" o "off". L'id va anche in `TOGGLE_ACTIONS` di `src/lib/toggle.ts`, che
# gli mette accanto l'etichetta da mostrare.
TOGGLE_ACTIONS='none led'

toggle_do_none() { :; }

# Il LED ha gia' il suo controllo, con lock, rollback e persistenza: qui non si
# tocca sysfs, si chiama quello. La scelta resta salvata come se fosse arrivata
# dall'interfaccia, quindi le due strade non si contraddicono al riavvio.
toggle_do_led() {
	. /usr/share/travel/led.sh
	case "$1" in
		on)  led_set 1 ;;
		off) led_set 0 ;;
	esac
}

toggle_known() {
	local action
	for action in $TOGGLE_ACTIONS; do
		[ "$1" = "$action" ] && return 0
	done
	return 1
}

# --- Configurazione ----------------------------------------------------------

# Senza scelta salvata l'interruttore non fa niente: e' il comportamento di un
# router appena installato, e nessuno si trova il LED che si spegne da solo.
toggle_get() {
	TOGGLE_ACTION=$(uci -q get travel_toggle.main.action)
	[ -n "$TOGGLE_ACTION" ] || TOGGLE_ACTION=none
	toggle_known "$TOGGLE_ACTION" && return 0
	toggle_error 'Configurazione dell interruttore non valida.'
	return 1
}

# Scrive la scelta, o toglie il file se la scelta e' vuota: serve a salvare e
# anche a rimettere le cose com'erano. File dedicato per non trascinarsi dietro
# modifiche di rete in sospeso, e sostituzione atomica come per il LED.
toggle_write() {
	local action="$1" tmp
	[ -n "$action" ] || { rm -f /etc/config/travel_toggle; return 0; }
	tmp=$(mktemp /etc/config/.travel-toggle.XXXXXX) || return 1
	[ -n "$tmp" ] || return 1
	if printf "config toggle 'main'\n\toption action '%s'\n" "$action" > "$tmp" &&
		chmod 600 "$tmp" && mv -f "$tmp" /etc/config/travel_toggle; then
		return 0
	fi
	rm -f "$tmp"
	return 1
}

toggle_set() (
	local action="$1" previous
	toggle_known "$action" || { toggle_error 'Azione non valida.'; exit 1; }
	# Chi chiede dall'interfaccia non aspetta in coda: c'e' un "Riprova", ed e'
	# meglio di una chiamata che resta appesa.
	toggle_lock || { toggle_error 'Modifica in corso. Riprova.'; exit 1; }
	trap 'toggle_unlock' EXIT
	previous=$(uci -q get travel_toggle.main.action)
	# Niente riscrittura della flash per una scelta gia' salvata. L'allineamento
	# si fa lo stesso: e' quello che rimette d'accordo levetta e uscita.
	if [ "$previous" != "$action" ]; then
		toggle_write "$action" || { toggle_error 'Impossibile salvare la scelta.'; exit 1; }
	fi
	# Si allinea per ultimo, cosi' l'unica cosa gia' fatta e' la scrittura della
	# scelta, ed e' una cosa che si sa disfare. Scegliere una funzione non
	# sposta la levetta: senza questo, chi la trova gia' in alto vedrebbe il LED
	# spento fino al primo spostamento.
	#
	# Se l'allineamento non riesce, `led_set` ha gia' rimesso a posto luminosita'
	# e preferenza per conto suo; qui si disfa la scelta, e chi ha chiesto la
	# modifica ritrova esattamente lo stato di prima invece di una funzione
	# scritta a meta'.
	toggle_align "$action" || {
		toggle_write "$previous" ||
			toggle_error 'Scelta non applicata e non ripristinata.'
		toggle_error 'Impossibile applicare la funzione scelta.'
		exit 1
	}
)

# --- Posizione rilevata ------------------------------------------------------

# Sta in /var/run e non in /etc/config perche' non e' una preferenza: e' dove
# si trova adesso una levetta. Dopo un riavvio la riporta il primo evento.
toggle_position() {
	TOGGLE_POSITION=unknown
	[ -r "$TOGGLE_POSITION_FILE" ] || return 0
	read -r TOGGLE_POSITION < "$TOGGLE_POSITION_FILE" 2>/dev/null
	case "$TOGGLE_POSITION" in
		on|off) ;;
		*) TOGGLE_POSITION=unknown ;;
	esac
	return 0
}

# --- Esecuzione --------------------------------------------------------------

# L'unico punto di ingresso del rilevamento. La posizione e' gia' normalizzata:
# quale tasto l'abbia prodotta, e con che nome, qui non conta.
toggle_run() {
	local position="$1" status
	case "$position" in
		on|off) ;;
		*) toggle_error 'Posizione non valida.'; return 1 ;;
	esac
	# La posizione si registra sempre e subito, anche dovendo poi aspettare il
	# turno: e' l'unica cosa che dice dov'e' la levetta adesso, e chi si allinea
	# dopo la legge da qui. Chi sta salvando, se non ha ancora allineato,
	# trovera' gia' quella nuova.
	printf '%s\n' "$position" > "$TOGGLE_POSITION_FILE" 2>/dev/null
	toggle_lock "$TOGGLE_LOCK_WAIT" || {
		toggle_error 'Modifica in corso: evento non applicato.'; return 1
	}
	toggle_get && "toggle_do_$TOGGLE_ACTION" "$position"
	status=$?
	toggle_unlock
	return "$status"
}

# Rimette l'uscita d'accordo con la levetta senza aspettare che qualcuno la
# sposti. Due momenti la richiedono: l'avvio, e la scelta di una funzione nuova.
#
# Dove sia la levetta lo sa solo il kernel, che lo dice con un evento - anche
# all'avvio, quando registra un EV_SW. Finche' quell'evento non e' arrivato la
# posizione e' `unknown` e non c'e' niente da riallineare: si tace, invece di
# tirare a indovinare e spegnere un LED che magari andava lasciato acceso.
#
# Il turno lo prende chi chiama: qui si agisce e basta.
toggle_align() {
	local action="$1"
	[ -n "$action" ] || { toggle_get || return 1; action="$TOGGLE_ACTION"; }
	toggle_known "$action" || { toggle_error 'Azione non valida.'; return 1; }
	toggle_position
	[ "$TOGGLE_POSITION" = unknown ] && return 0
	"toggle_do_$action" "$TOGGLE_POSITION"
}

# L'allineamento dell'avvio prende il turno come tutti gli altri: al boot
# l'evento della levetta puo' arrivare proprio adesso.
toggle_apply() {
	local status
	toggle_lock "$TOGGLE_LOCK_WAIT" || {
		toggle_error 'Modifica in corso: allineamento saltato.'; return 1
	}
	toggle_align
	status=$?
	toggle_unlock
	return "$status"
}

# `sh /usr/share/travel/toggle.sh apply` all'avvio, come fa led.sh.
case "$1" in apply) toggle_apply ;; esac
