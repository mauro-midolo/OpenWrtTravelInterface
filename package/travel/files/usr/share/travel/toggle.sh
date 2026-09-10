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

# Quante volte chi tiene il turno rincorre una levetta che si e' mossa mentre
# agiva. Chi la sposta avanti e indietro senza fermarsi non merita un ciclo
# infinito: la sua ultima posizione resta scritta, e il prossimo evento - o
# l'avvio - la trova li'.
TOGGLE_ALIGN_TRIES=3

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
# Due specie di azioni, e la differenza non e' un dettaglio.
#
# Quelle **fisse** sono scritte qui: un id in `TOGGLE_ACTIONS` e una funzione
# `toggle_do_<id>` che riceve "on" o "off". L'id va anche in `TOGGLE_ACTIONS` di
# `src/lib/toggle.ts`, che gli mette accanto l'etichetta da mostrare.
#
# Quelle **nominate** invece non si possono elencare in anticipo, perche' le
# crea chi usa il router: una configurazione WireGuard alla volta puo' portare
# il traffico, quindi non esiste un "accendi WireGuard" generico da mettere in
# lista - esiste "accendi *questa*". L'id e' `wg:<sezione>`, dove la sezione e'
# gia' l'identificatore con cui tutto il resto del sistema chiama quel profilo:
# non se ne inventa un secondo, e uno solo non puo' divergere dall'altro.
# L'etichetta la sa solo il router, perche' e' il nome che le ha dato una
# persona: `toggle_get` la manda insieme all'elenco.
TOGGLE_ACTIONS='none led ap24 ap5'

# `wg.sh` si carica quando serve, non in cima: e' lui a chiedere a noi chi
# comanda la levetta (`toggle_wg_id`), e due file che si sorgono a vicenda in
# cima non si caricherebbero mai.
toggle_wg_load() {
	[ -n "$TOGGLE_WG_LOADED" ] && return 0
	. /usr/share/travel/wg.sh || return 1
	TOGGLE_WG_LOADED=1
}

# L'elenco completo, una azione per riga: le fisse e una per ogni
# configurazione WireGuard salvata.
toggle_actions() {
	local action section
	for action in $TOGGLE_ACTIONS; do
		printf '%s\n' "$action"
	done
	toggle_wg_load || return 0
	for section in $(wg_profiles); do
		printf 'wg:%s\n' "$section"
	done
}

# La configurazione WireGuard comandata dalla levetta, o niente.
#
# Legge la scelta salvata e non `$TOGGLE_ACTION`: chi la chiede - `wg.sh`, per
# sapere se l'interfaccia puo' ancora accendere e spegnere - non ha nessun
# motivo di aver caricato prima la configurazione.
toggle_wg_id() {
	local action
	action=$(uci -q get travel_toggle.main.action)
	case "$action" in
		wg:*) printf '%s' "${action#wg:}" ;;
		*) return 1 ;;
	esac
}

# La banda dell'access point che un'azione comanda, o niente.
#
# Le due voci sono fisse e non nominate - `ap24` e `ap5`, non `ap:<qualcosa>` -
# perche' le bande non le crea chi usa il router: sono due, sono sempre quelle,
# e la loro etichetta e' una traduzione che sta nella SPA come quella del LED.
# La corrispondenza fra id e banda pero' serve in due punti, l'esecuzione e chi
# deve sapere quale controllo virtuale spegnere: sta scritta qui una volta sola.
toggle_ap_band_of() {
	case "$1" in
		ap24) printf '2.4' ;;
		ap5)  printf '5' ;;
		*) return 1 ;;
	esac
}

# La banda comandata dalla levetta adesso, o niente.
#
# Legge la scelta salvata e non `$TOGGLE_ACTION`, come `toggle_wg_id` e per la
# stessa ragione: chi la chiede - `ap.sh`, per dire all'interfaccia quale
# controllo virtuale non e' piu' premibile - non ha nessun motivo di aver
# caricato prima la configurazione.
toggle_ap_band() {
	toggle_ap_band_of "$(uci -q get travel_toggle.main.action)"
}

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

# L'access point della banda scelta segue la levetta.
#
# Come per il LED e per WireGuard, qui non si tocca `uci` e non si ricarica
# niente: lo fa `ap_switch` di `ap.sh`, che e' l'unico posto in cui un access
# point cambia stato. Ne segue da solo quale sezione vale quando su una radio
# ce n'e' piu' d'una, che e' la regola che l'interfaccia legge dall'altro lato.
toggle_do_ap() {
	local band position="$2"
	band=$(toggle_ap_band_of "$1") || { toggle_error 'Banda non valida.'; return 1; }
	. /usr/share/travel/ap.sh || { toggle_error 'Access point non disponibile.'; return 1; }
	ap_switch "$band" "$position"
}

toggle_do_ap24() { toggle_do_ap ap24 "$1"; }
toggle_do_ap5() { toggle_do_ap ap5 "$1"; }

# La configurazione WireGuard scelta segue la levetta.
#
# Come per il LED, qui non si tocca `uci` e non si rifa' l'instradamento: lo fa
# `wg_switch`, lo stesso che usa la scheda WireGuard. Ne segue da solo il
# vincolo che ne puo' essere accesa una alla volta - accendendo questa,
# `wg_switch` spegne quella che trova, con la logica che ha gia'.
toggle_do_wg() {
	local id="$1" position="$2"
	toggle_wg_load || { toggle_error 'WireGuard non disponibile.'; return 1; }
	case "$position" in
		on)  wg_switch "$id" on toggle ;;
		off) wg_switch "$id" off toggle ;;
	esac
}

# Esegue l'azione. Le fisse hanno una funzione con il loro nome; quelle
# nominate portano dentro l'id, e il nome della funzione non lo puo' contenere.
toggle_do() {
	local action="$1" position="$2"
	case "$action" in
		wg:*) toggle_do_wg "${action#wg:}" "$position" ;;
		*)    "toggle_do_$action" "$position" ;;
	esac
}

toggle_known() {
	local action
	case "$1" in
		wg:*)
			toggle_wg_load || return 1
			wg_known "${1#wg:}"
			return $?
			;;
	esac
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
	# Una configurazione WireGuard eliminata lascia una scelta che indica il
	# vuoto. Non e' una configurazione rotta, e' un puntatore vecchio, e vale
	# "non fare nulla": rifiutarla bloccherebbe la riga che serve a cambiarla,
	# e la levetta resterebbe associata a un tunnel che non esiste piu'.
	case "$TOGGLE_ACTION" in
		wg:*) TOGGLE_ACTION=none; return 0 ;;
	esac
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
	toggle_align "$action"
	case $? in
		0) ;;
		# Applicato, e poi la levetta si e' mossa ancora. La funzione scelta non
		# e' scritta a meta': funziona, e anzi e' l'unica cosa che potra'
		# rimettere le cose a posto al prossimo spostamento. Disfarla qui
		# lascerebbe l'uscita dove l'ultimo tentativo riuscito l'ha messa, con
		# nessuno a comandarla - il contrario di cio' che il ritorno indietro
		# serve a ottenere.
		2)
			toggle_error 'Funzione salvata: la levetta si e mossa, si riallinea al prossimo spostamento.'
			;;
		*)
			toggle_write "$previous" ||
				toggle_error 'Scelta non applicata e non ripristinata.'
			toggle_error 'Impossibile applicare la funzione scelta.'
			exit 1
			;;
	esac
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
	# Rinunciare al turno non vuol dire perdere il movimento: chi ce l'ha
	# riguarda la posizione prima di mollarlo, e quella appena scritta la
	# trovera'. Non e' un fallimento e non va segnalato come tale - il turno
	# resta occupato a lungo proprio quando l'azione e' lenta, cioe' quando un
	# allarme a ogni movimento sarebbe la norma invece che l'eccezione.
	toggle_lock "$TOGGLE_LOCK_WAIT" || {
		toggle_error 'Modifica in corso: la applica chi ha il turno.'; return 0
	}
	# La posizione la rilegge `toggle_align` dal file, e non e' un giro inutile:
	# chi ha aspettato il turno puo' aver visto la levetta muoversi ancora, e
	# un'azione lenta - alzare un tunnel vuole una quindicina di secondi - rende
	# quel caso normale invece che raro. Conta dov'e' la levetta adesso, non
	# dov'era quando l'evento e' partito.
	toggle_align
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
#
# **E si riguarda dov'e' finita la levetta prima di mollare il turno.** Un'azione
# lenta - alzare un tunnel WireGuard vuole una quindicina di secondi - dura piu'
# dei cinque che un evento aspetta in coda: chi si sposta in quel mezzo registra
# la sua posizione, non ottiene il turno e rinuncia. Senza questo giro in piu'
# quel movimento sarebbe perso per sempre, e resterebbe un tunnel acceso su una
# levetta che dice "no" finche' qualcuno non la muove di nuovo. La posizione la
# scrive per primo chi la rileva, apposta perche' chi tiene il turno la trovi.
# Tre esiti, e la differenza fra gli ultimi due decide se una scelta si puo'
# disfare:
#
#   0  allineato, e la levetta era ferma
#   1  non applicato: niente e' stato toccato, si puo' disfare tutto
#   2  applicato, ma poi la rincorsa e' finita male
#
# Il 2 esiste per il chiamante che disfa. Un primo tentativo fallito non lascia
# niente dietro di se' - e' la ragione per cui l'allineamento e' l'ultimo passo
# di `toggle_set` - ma uno fallito *dopo* uno riuscito si': li' l'uscita e' gia'
# stata mossa, e disfare la scelta lascerebbe un tunnel acceso e nessuno a
# comandarlo. Sono due cose diverse e vanno dette con due numeri diversi.
toggle_align() {
	local action="$1" tries=0 seen status applied=0
	[ -n "$action" ] || { toggle_get || return 1; action="$TOGGLE_ACTION"; }
	toggle_known "$action" || { toggle_error 'Azione non valida.'; return 1; }
	while :; do
		toggle_position
		[ "$TOGGLE_POSITION" = unknown ] && return 0
		seen="$TOGGLE_POSITION"
		toggle_do "$action" "$seen"
		status=$?
		# Un'azione fallita non si rincorre: inseguire la levetta con qualcosa
		# che non funziona vuol dire solo fallire piu' volte.
		if [ "$status" -ne 0 ]; then
			[ "$applied" -eq 1 ] && return 2
			return 1
		fi
		applied=1
		toggle_position
		[ "$TOGGLE_POSITION" = "$seen" ] && return 0
		tries=$((tries + 1))
		[ "$tries" -lt "$TOGGLE_ALIGN_TRIES" ] || {
			toggle_error 'La levetta continua a muoversi: allineamento interrotto.'
			return 2
		}
	done
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
