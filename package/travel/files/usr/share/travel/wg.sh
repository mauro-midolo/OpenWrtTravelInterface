#!/bin/sh
# WireGuard: i profili salvati, chi decide da dove esce il traffico, e come si
# accende o si spegne un tunnel.
#
# Sta in un file a se' e non dentro il plugin rpcd perche' i lettori sono due:
# la scheda WireGuard, che passa da `wg_toggle`, e l'interruttore fisico, che a
# una configurazione ci puo' essere associato. Due strade che accendono la
# stessa cosa devono accenderla nello stesso modo - lock, vincoli e
# instradamento compresi - altrimenti prima o poi si contraddicono. E' la
# stessa ragione per cui l'azione `led` della levetta chiama `led_set` di
# `led.sh` invece di scrivere in sysfs per conto suo.
#
# Qui dentro non si stampa JSON e non si convalida niente che arrivi dal
# browser: quello resta al plugin, che di questo file e' il primo cliente.

# Il motivo esce su stderr, com'e' sempre stato: e' quello che finisce nei log.
# Il primo argomento e' un codice stabile e i seguenti, dopo il messaggio, coppie
# chiave/valore: se chi chiama ha indicato un file in TRAVEL_ERR_FILE - l'rpcd,
# per mostrare l'errore nella lingua dell'interfaccia - ci finiscono una per
# riga, il codice per primo.
wg_error() {
	_err_code="$1"
	shift
	printf '%s\n' "$1" >&2
	shift
	[ -z "${TRAVEL_ERR_FILE:-}" ] || printf '%s\n' "$_err_code" "$@" > "$TRAVEL_ERR_FILE"
	return 0
}

# --- I profili WireGuard, elencati --------------------------------------------
#
# Le configurazioni WireGuard vivono in `/etc/config/network` come interfacce
# netifd e si chiamano `travel_wg`, `travel_wg1`, `travel_wg2`... Il nome della
# sezione **e'** il nome dell'interfaccia - netifd funziona cosi' - quindi e'
# anche l'identificatore con cui l'interfaccia parla di un profilo: non serve
# inventarne un secondo, e uno solo non puo' divergere dall'altro.
#
# `travel_wg` senza numero e' il tunnel unico delle versioni precedenti. Resta
# com'e' invece di essere rinominato: rinominare un'interfaccia significa
# abbatterla e rifarla, e chi aggiorna il router mentre e' in albergo non se lo
# merita. Diventa semplicemente la prima voce dell'elenco.
#
# Queste funzioni stanno qui sopra, prima della policy, perche' la policy e' il
# loro primo lettore: "c'e' un tunnel acceso?" e "quale?" sono la stessa
# domanda, e devono avere una risposta sola.
WG_PREFIX=travel_wg

# Le sezioni interfaccia dei profili, una per riga. Le sezioni peer si chiamano
# `<profilo>_peer` e non finiscono qui: hanno tipo `wireguard_<profilo>`, non
# `interface`, e il filtro le lascia fuori da solo.
wg_profiles() {
	uci -q show network 2>/dev/null |
		sed -n "s/^network\.\(${WG_PREFIX}[0-9]*\)=interface\$/\1/p"
}

# Il profilo acceso, o niente.
#
# Al massimo uno: e' il vincolo di tutta la fase, e qui si legge come "il primo
# che non e' disabilitato". Se una configurazione scritta a mano - LuCI, ssh -
# ne avesse accesi due, questa ne nomina uno e i cancelli piu' sotto rifiutano
# di accenderne altri: si torna a uno solo spegnendo, che e' la strada normale.
wg_active() {
	local section

	for section in $(wg_profiles); do
		[ "$(uci -q get "network.$section.disabled")" = "1" ] && continue
		printf '%s' "$section"
		return 0
	done

	return 1
}

# Il nome che gli ha dato chi lo ha salvato.
#
# E' obbligatorio da quando si crea un profilo in poi. Non c'e' per il tunnel
# unico che arriva da una versione precedente: li' si mostra l'endpoint, che e'
# l'unica cosa che lo distingue, e il primo salvataggio gli da' un nome vero.
wg_name() {
	local section="$1" name

	name=$(uci -q get "network.$section.travel_name")
	[ -n "$name" ] || name=$(uci -q get "network.${section}_peer.endpoint_host")
	[ -n "$name" ] || name="$section"
	printf '%s' "$name"
}

# --- Chi decide da dove esce il traffico -------------------------------------
#
# Tre cose, e **al massimo una alla volta**:
#
#   balance    il bilanciamento multi-WAN sparpaglia le connessioni su piu' WAN
#   ts_exit    un exit node Tailscale porta tutto dentro il tailnet
#   wireguard  un tunnel WireGuard porta tutto dall'altra parte
#
# Sembrano quattro vincoli distinti - "in bilanciamento niente exit node", "con
# WireGuard niente bilanciamento", "WireGuard ed exit node si escludono"... - e
# invece sono lo stesso enunciato visto da tre lati: **sono tre modi di
# decidere la stessa cosa, e due decisioni contemporanee sulla stessa cosa non
# esistono.**
#
# Il perche', per ciascuna coppia:
#
# - **balance con un tunnel completo** non ha niente da bilanciare e tutto da
#   rompere. Il tunnel e' una connessione sola: mwan3 non la puo' sparpagliare,
#   ma la puo' spostare, e a ogni spostamento cambia l'indirizzo di partenza e
#   costringe a un handshake nuovo su *tutto* il traffico, perche' tutto e' li'
#   dentro (il ragionamento lungo sta piu' su);
# - **due tunnel completi insieme** vorrebbe dire due rotte predefinite dentro
#   due tunnel diversi. Vincerebbe quella con la priorita' piu' alta e l'altra
#   resterebbe li' a non fare niente, con l'interfaccia che ne mostra due
#   accesi: uno stato che sembra una configurazione e invece e' un errore
#   silenzioso.
#
# Scritta una volta sola, qui. La UI la rilegge da `travel.vpn` per spegnere le
# opzioni giuste, e i metodi che applicano la ricontrollano prima di agire: se
# l'interfaccia venisse scavalcata - LuCI, ssh, un backup importato - il vincolo
# regge lo stesso, perche' vive nel punto in cui la modifica prende effetto e
# non in quello in cui viene chiesta.

# Vero se il multi-WAN e' in bilanciamento.
policy_balance() {
	[ "$(uci -q get mwan3.travel_default.use_policy)" = "travel_balance" ]
}

# Vero se un exit node Tailscale e' configurato. Conta la CONFIGURAZIONE, non
# se il tunnel sta funzionando in questo momento: il vincolo deve valere anche
# mentre la rete e' giu', altrimenti basterebbe un momento di disconnessione per
# infilare una configurazione incompatibile che poi torna su da sola.
policy_ts_exit() {
	[ -n "$(uci -q get travel.tailscale.exit_node)" ]
}

# Vero se un tunnel WireGuard e' acceso - uno qualunque dei profili salvati.
#
# I profili sono tanti, la decisione su dove esce il traffico e' una: quello che
# conta qui non e' quale sia acceso ma che ce ne sia uno. Quale, lo chiede chi
# deve scrivere la frase da mostrare.
policy_wireguard() {
	wg_active >/dev/null
}

# Chi sta gia' decidendo, escludendo quello che si sta per accendere.
#
# Torna il nome dell'occupante, o niente se la strada e' libera. Il chiamante
# passa cio' che vuole accendere, cosi' la stessa funzione risponde a tutte e
# tre le domande senza tre elenchi da tenere allineati.
policy_holder() {
	local want="$1"

	[ "$want" != "balance" ]   && policy_balance   && { printf 'balance';   return 0; }
	[ "$want" != "ts_exit" ]   && policy_ts_exit   && { printf 'ts_exit';   return 0; }
	[ "$want" != "wireguard" ] && policy_wireguard && { printf 'wireguard'; return 0; }

	return 1
}

# La stessa frase per tutti: la scrive il router, non tre schermate diverse.
policy_reason() {
	case "$1" in
		balance)
			printf 'multi-WAN is load balancing: it spreads connections over several WANs, and a tunnel cannot be spread' ;;
		ts_exit)
			printf 'a Tailscale exit node is already carrying all traffic' ;;
		wireguard)
			# Col nome del profilo, adesso che ce ne puo' essere piu' d'uno:
			# "un tunnel WireGuard" non basta piu' a dire quale spegnere.
			_wg_on=$(wg_active) &&
				printf 'the WireGuard tunnel "%s" is already carrying all traffic' "$(wg_name "$_wg_on")" ||
				printf 'a WireGuard tunnel is already carrying all traffic' ;;
		*)
			printf '' ;;
	esac
}

# Il nome del profilo WireGuard che blocca, per chi la frase la ricompone da se'
# (l'interfaccia, in un'altra lingua). Vuoto per gli altri occupanti.
policy_name() {
	[ "$1" = wireguard ] || return 0
	_wg_on=$(wg_active) && wg_name "$_wg_on"
	return 0
}

# Il pacchetto c'e'? Senza, la configurazione si scrive ma non si alza.
wg_installed() {
	[ -x /usr/bin/wg ] && [ -f /lib/netifd/proto/wireguard.sh ]
}

# Il profilo esiste davvero?
#
# Ogni metodo che riceve un identificatore dal browser passa di qui prima di
# toccare uci: senza, un `id` inventato scriverebbe una sezione nuova con un
# nome qualunque in `/etc/config/network`, che e' il modo piu' silenzioso di
# rompere la configurazione di rete di un router.
wg_known() {
	local want="$1" section

	[ -n "$want" ] || return 1
	for section in $(wg_profiles); do
		[ "$section" = "$want" ] && return 0
	done

	return 1
}

# Fa prendere effetto a cio' che e' appena stato scritto, e rimette
# l'instradamento.
#
# **Aspettare che il device esista prima di instradarlo.**
#
# `network reload` torna subito: netifd alza l'interfaccia per conto suo,
# qualche istante dopo. La prima versione lanciava l'instradamento appena
# tornata la chiamata, non trovava il device in /sys, e - peggio - concludeva
# che il tunnel fosse giu': cancellava la regola invece di scriverla. Il tunnel
# saliva un secondo dopo, faceva handshake, e il traffico dei client continuava
# a uscire dalla WAN. Tutto sembrava a posto tranne l'unica cosa che contava.
wg_reload() {
	local section="$1" tries=0

	ubus call network reload >/dev/null 2>&1

	if [ "$(uci -q get "network.$section.disabled")" != "1" ]; then
		ubus call network.interface."$section" up >/dev/null 2>&1
		while [ "$tries" -lt 15 ]; do
			[ -e "/sys/class/net/$section" ] && break
			sleep 1
			tries=$((tries + 1))
		done
	fi

	sh /usr/share/travel/vpn-setup.sh runtime >/dev/null 2>&1
}

# --- Accendere e spegnere -----------------------------------------------------

# L'unico posto in cui una configurazione WireGuard cambia stato.
#
#   wg_switch <id> on|off <ui|toggle>
#
# Il terzo argomento dice da dove arriva la richiesta, e cambia due cose sole:
#
# **Lo scambio.** Chi chiede dall'interfaccia si sente rispondere "spegni prima
# quella accesa", perche' fra il tunnel che cade e quello che sale c'e' un
# istante in cui il traffico esce in chiaro dalla rete dell'albergo, e nessuno
# lo ha chiesto: due passi espliciti valgono quell'istante. L'interruttore
# fisico invece quel passo lo ha gia' fatto - associargli una configurazione
# *e'* la richiesta - e una levetta non ha un secondo gesto da offrire. Lo
# scambio resta comunque una sola scrittura e un solo `network reload`, quindi
# non c'e' un momento in cui sono accese tutte e due.
#
# **Il comando della levetta.** Quando l'interruttore fisico comanda una
# configurazione, l'interfaccia non accende e non spegne piu' niente: la levetta
# resterebbe dov'e' e schermo, tunnel e levetta direbbero tre cose diverse. Il
# divieto sta qui e non solo nella UI, perche' e' qui che si passa comunque -
# anche da LuCI, da ssh o da un backup importato.
#
# Il motivo di un rifiuto esce su stderr, gia' scritto per esteso: chi chiama lo
# passa a `fail_json` o al log senza riscriverlo.
wg_switch() {
	local id="$1" want="$2" from="$3" busy holder owner also

	busy=$(wg_active) || busy=""

	if [ "$want" = on ]; then
		wg_known "$id" || { wg_error wg_unknown "unknown WireGuard configuration"; return 1; }
		wg_installed || { wg_error wg_not_installed "wireguard-tools is not installed"; return 1; }
		# Gia' com'e' richiesta: rialzare la rete per confermare uno stato gia'
		# giusto vorrebbe dire far cadere il traffico a ogni allineamento, e la
		# levetta si riallinea a ogni avvio.
		if [ "$(uci -q get "network.$id.disabled")" != "1" ]; then return 0; fi
	else
		# Spegnere senza dire quale spegne quello acceso: e' l'unico che possa
		# esserlo, e chiederne il nome per dire "spegni" sarebbe cerimonia.
		[ -n "$id" ] || id="$busy"
		[ -n "$id" ] || { wg_error wg_none_active "no active WireGuard configuration"; return 1; }
		wg_known "$id" || { wg_error wg_unknown "unknown WireGuard configuration"; return 1; }
		# Con la levetta in basso non deve restare acceso niente. Quella
		# associata e' spenta per definizione; un'altra accesa da prima
		# resterebbe li' a smentire una levetta che dice "no", e l'interfaccia
		# - che da adesso non accende e non spegne piu' - non avrebbe modo di
		# fermarla. Un blocco che puo' lasciare un tunnel senza interruttore
		# non e' un blocco, e' una trappola.
		if [ "$from" = toggle ] && [ -n "$busy" ] && [ "$busy" != "$id" ]; then
			also="$busy"
		fi
		if [ -z "$also" ] && [ "$(uci -q get "network.$id.disabled")" = "1" ]; then
			return 0
		fi
	fi

	if [ "$from" != toggle ]; then
		owner=$(wg_toggle_owner) && {
			wg_error wg_by_toggle "the physical switch controls it: \"$(wg_name "$owner")\" follows the switch. Change the switch function to decide from here again" \
				name "$(wg_name "$owner")"
			return 1
		}
	fi

	# Tutti i cancelli prima di qualunque scrittura: una richiesta rifiutata non
	# deve lasciare in `uci` una modifica a meta' da ricordarsi di annullare.
	if [ "$want" = on ]; then
		if [ -n "$busy" ]; then
			[ "$from" = toggle ] || {
				wg_error wg_busy "the configuration \"$(wg_name "$busy")\" is already active: deactivate it before activating another one" \
					name "$(wg_name "$busy")"
				return 1
			}
		fi
		# Il vincolo generale - al massimo una cosa alla volta decide da dove
		# esce il traffico - vale anche per la levetta: e' lo stesso traffico.
		holder=$(policy_holder wireguard) && {
			wg_error wg_blocked "cannot turn on WireGuard: $(policy_reason "$holder")" \
				holder "$holder" name "$(policy_name "$holder")"
			return 1
		}
		[ -n "$busy" ] && uci set "network.$busy.disabled=1"
		uci set "network.$id.disabled=0"
	else
		[ -n "$also" ] && uci set "network.$also.disabled=1"
		uci set "network.$id.disabled=1"
	fi

	uci commit network
	# L'esito dell'instradamento non fa fallire l'accensione: la scrittura e'
	# andata, e `40-travel-vpn` lo rifa' comunque quando l'interfaccia compare.
	wg_reload "$id"
	return 0
}

# L'id della configurazione comandata dall'interruttore fisico, o niente.
#
# La domanda la sa l'interruttore, quindi la risposta viene da li'. Il carico e'
# rimandato al momento in cui serve davvero: `toggle.sh` a sua volta chiede a
# questo file quali configurazioni esistono, e due file che si sorgono a vicenda
# in cima non si caricherebbero mai.
wg_toggle_owner() {
	local id

	. /usr/share/travel/toggle.sh
	id=$(toggle_wg_id) || return 1
	# Una configurazione eliminata lascia una scelta che indica il vuoto: non
	# comanda piu' niente, e l'interfaccia deve tornare a decidere da sola
	# invece di restare bloccata da una levetta associata a un tunnel che non
	# esiste. E' la stessa lettura che fa `toggle_get`, dall'altro lato.
	wg_known "$id" || return 1
	printf '%s' "$id"
}
