#!/bin/sh
# Access point WiFi: dove sta, com'e' messo, e l'unico posto in cui cambia stato.
#
# Sta in un file a se' per la stessa ragione di `wg.sh`: i lettori sono piu' di
# uno. Il plugin rpcd lo legge per raccontare com'e' messo l'access point, e
# l'interruttore fisico lo usa per accenderlo e spegnerlo quando gli e' stata
# associata una banda. Due strade che toccano la stessa cosa devono toccarla
# nello stesso modo - quale sezione uci vale, che cosa vuol dire "acceso", come
# si fa prendere effetto - altrimenti prima o poi si contraddicono.
#
# Qui dentro non si stampa JSON e non si convalida niente che arrivi dal
# browser: quello resta al plugin, che di questo file e' il primo cliente.

ap_error() { printf '%s\n' "$*" >&2; }

# --- Dove sta l'access point --------------------------------------------------

# Come si chiama una banda fuori da uci.
#
# `2g` e `5g` sono i valori che scrive OpenWrt; "2.4" e "5" quelli con cui ne
# parlano l'interfaccia, le reti salvate e le azioni della levetta. Vuoto per
# una radio che non dichiara la banda: e' un caso vero, e allora la banda si
# ricava dal canale reale - lo fa chi la mostra, non chi la scrive.
band_label() {
	case "$1" in
		2g) printf '2.4' ;;
		5g) printf '5' ;;
		*)  printf '' ;;
	esac
}

# Le radio configurate, una per riga.
ap_radios() {
	uci show wireless 2>/dev/null | sed -n 's/^wireless\.\([^.]*\)=wifi-device$/\1/p'
}

# La radio di una banda ("2.4" oppure "5"), o niente.
ap_radio_of_band() {
	local want="$1" radio

	[ -n "$want" ] || return 1
	for radio in $(ap_radios); do
		[ "$(band_label "$(uci -q get "wireless.$radio.band")")" = "$want" ] || continue
		printf '%s' "$radio"
		return 0
	done

	return 1
}

# La sezione dell'access point su una radio, o niente.
#
# Due regole, e la seconda esiste per un caso preciso.
#
# **Vince quello acceso**: e' quello davvero in onda, ed e' quello di cui si
# racconta lo stato e che va spento quando si spegne la banda.
#
# **Fra quelli spenti vince il nostro**, cioe' `ap_<radio>`, il nome che gli da'
# `tools/setup-ap.sh`. Finche' il nostro e' acceso la prima regola basta da
# sola, ed e' per questo che prima c'era solo quella; ma la levetta lo spegne
# per mestiere, e a quel punto sulla radio non c'e' piu' niente di acceso. Senza
# questa seconda regola si sarebbe ripreso il primo che capita nell'ordine di
# `uci show` - e le sezioni `wifi-iface` di default di OpenWrt sono li', spente,
# **aperte e senza password**: riaccendere avrebbe potuto alzare quella invece
# della nostra, cioe' esporre la LAN a chiunque sia nel raggio.
#
# La regola sta scritta qui una volta sola perche' la applicano in tre - le due
# letture del plugin e questa accensione - e tre copie che scegliessero una
# sezione diversa racconterebbero o accenderebbero access point diversi.
ap_section_of_radio() {
	local radio="$1" section dev disabled on='' off=''

	[ -n "$radio" ] || return 1
	for section in $(uci show wireless 2>/dev/null | sed -n 's/^wireless\.\([^.]*\)=wifi-iface$/\1/p'); do
		dev=$(uci -q get "wireless.$section.device")
		[ "$dev" = "$radio" ] || continue
		[ "$(uci -q get "wireless.$section.mode")" = "ap" ] || continue
		disabled=$(uci -q get "wireless.$section.disabled")
		if [ "${disabled:-0}" = "0" ]; then
			on="$section"
		elif [ -z "$off" ] || [ "$section" = "ap_$radio" ]; then
			off="$section"
		fi
	done

	[ -n "$on" ] && { printf '%s' "$on"; return 0; }
	[ -n "$off" ] || return 1
	printf '%s' "$off"
}

# La sezione dell'access point di una banda, o niente.
ap_section_of_band() {
	local radio

	radio=$(ap_radio_of_band "$1") || return 1
	ap_section_of_radio "$radio"
}

# Vero se la sezione e' accesa. `disabled` assente vale acceso: e' il default di
# uci, ed e' come lo legge il resto del sistema.
ap_section_enabled() {
	[ "$(uci -q get "wireless.$1.disabled")" != "1" ]
}

# --- Accendere e spegnere -----------------------------------------------------

# L'unico posto in cui un access point cambia stato.
#
#   ap_switch <2.4|5> <on|off>
#
# Non c'e' il "da dove arriva la richiesta" che ha `wg_switch`, perche' qui le
# strade che scrivono sono due ma diverse in natura. La levetta passa di qui;
# l'interfaccia invece scrive `disabled` con l'oggetto `uci` e lo fa passare da
# applica-e-conferma, perche' spegnere l'access point da cui si e' collegati
# chiude fuori chi lo sta facendo e il ritorno indietro automatico e' l'unica
# rete di sicurezza che ci sia. Quel percorso non si puo' portare qui dentro
# senza perdere il conto alla rovescia, quindi il divieto di toccare da fuori un
# access point comandato dalla levetta vive nell'interfaccia, che sa gia' quale
# banda comanda perche' glielo dice `travel.radios`.
#
# Il motivo di un rifiuto esce su stderr, gia' scritto per esteso: chi chiama lo
# passa al log o a `fail_json` senza riscriverlo.
ap_switch() {
	local band="$1" want="$2" section

	case "$want" in
		on|off) ;;
		*) ap_error "stato dell'access point non valido"; return 1 ;;
	esac

	section=$(ap_section_of_band "$band") || {
		ap_error "nessun access point configurato sulla banda $band GHz"
		return 1
	}

	# Gia' com'e' richiesto: rifare la configurazione radio per confermare uno
	# stato gia' giusto farebbe cadere chi e' collegato a ogni allineamento, e
	# la levetta si riallinea a ogni avvio.
	if [ "$want" = on ]; then
		ap_section_enabled "$section" && return 0
		# Nessuna levetta accende una rete aperta. La scelta della sezione la
		# fa gia' bene `ap_section_of_radio`, ma quella e' una convenzione sul
		# nome, e una convenzione non e' il posto in cui tenere l'unica cosa
		# che separa un movimento della levetta dall'esporre la LAN a chiunque
		# sia nel raggio. Il divieto qui e' sul fatto, non sul nome: **questa
		# sezione non ha cifratura**, e allora non si alza, chiunque sia.
		# Spegnere invece resta sempre lecito - il verso pericoloso e' uno solo.
		case "$(uci -q get "wireless.$section.encryption")" in
			''|none)
				ap_error "l'access point $section sulla banda $band GHz e' senza password: non lo accendo. Configuralo con tools/setup-ap.sh"
				return 1
				;;
		esac
		uci set "wireless.$section.disabled=0"
	else
		ap_section_enabled "$section" || return 0
		uci set "wireless.$section.disabled=1"
	fi

	uci commit wireless
	# L'esito della ricarica non fa fallire la modifica, come per `wg_reload`:
	# la scrittura e' andata a buon fine ed e' quella che conta. Fallire qui
	# farebbe disfare a `toggle_set` la scelta appena salvata, lasciando
	# l'access point spostato e nessuno a comandarlo - il contrario di cio' che
	# il ritorno indietro serve a ottenere.
	ap_reload
	return 0
}

# Fa prendere effetto a cio' che e' appena stato scritto.
#
# E' quello che fa `wifi reload`: netifd rilegge `wireless` e riconfigura le
# radio. Non si aspetta che l'access point sia su - a differenza di un tunnel
# WireGuard, qui non c'e' un instradamento da rifare dopo, e chi ha chiesto la
# modifica tiene intanto il turno dell'interruttore.
ap_reload() {
	ubus call network reload >/dev/null 2>&1
}

# --- Chi comanda --------------------------------------------------------------

# La banda dell'access point comandato dall'interruttore fisico, o niente.
#
# La domanda la sa l'interruttore, quindi la risposta viene da li' - come
# `wg_toggle_owner`. Il carico e' rimandato al momento in cui serve davvero:
# `toggle.sh` a sua volta chiede a questo file di accendere, e due file che si
# sorgono a vicenda in cima non si caricherebbero mai.
#
# Una banda su cui non c'e' nessun access point configurato non comanda niente:
# lasciare bloccato un controllo per una levetta associata a qualcosa che non
# esiste sarebbe una trappola, la stessa che `wg_toggle_owner` evita con un
# profilo eliminato.
ap_toggle_band() {
	local band

	. /usr/share/travel/toggle.sh
	band=$(toggle_ap_band) || return 1
	ap_section_of_band "$band" >/dev/null || return 1
	printf '%s' "$band"
}
