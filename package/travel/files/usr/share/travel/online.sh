# Aspettare che si esca davvero, e non installare mai alla cieca.
#
# Da sorgere (`. /usr/share/travel/online.sh`), non da eseguire.
#
# Nasce da un'installazione su router pulito che si e' piantata a "installo
# tailscale": mwan3 era appena stato configurato e riavviato, e finche' non ha
# dichiarato online almeno una WAN le sue regole mandano il traffico in
# `unreachable`. Servono una quindicina di secondi - `interval 5` per `up 3` -
# e in quella finestra Internet non c'e'. `apk` ci e' finito dentro e ci e'
# rimasto: senza limite di tempo, un comando che aspetta una rete che non
# arriva non torna piu'.
#
# Due regole, che valgono per ogni pacchetto installato da questi script:
#
#   1. prima di installare si guarda se si esce, e se non si esce si aspetta -
#      ma per un tempo dichiarato, non per sempre;
#   2. `apk` gira comunque sotto `timeout`. La prima regola copre il caso noto,
#      la seconda quello che non abbiamo previsto.

# Vero se si raggiunge Internet adesso.
#
# Una connessione TCP alla porta 80 di un indirizzo pubblico noto: niente DNS
# (che dipende da dnsmasq e dai resolver a monte, cioe' da altre due cose che
# potrebbero essere a meta'), niente ICMP (che alcune reti filtrano). Si prova
# piu' di un indirizzo perche' uno solo che ha una brutta giornata direbbe
# "niente Internet" a un router che ce l'ha.
travel_online() {
	local host

	for host in 1.1.1.1 8.8.8.8 9.9.9.9; do
		if command -v nc >/dev/null 2>&1; then
			printf '' | nc -w 3 "$host" 80 >/dev/null 2>&1 && return 0
		elif command -v uclient-fetch >/dev/null 2>&1; then
			uclient-fetch -q -T 3 -O /dev/null "http://$host/" >/dev/null 2>&1 && return 0
		else
			ping -c 1 -W 3 "$host" >/dev/null 2>&1 && return 0
		fi
	done

	return 1
}

# Aspetta che Internet torni, al massimo per $1 secondi (default 60).
#
# Torna 0 se si esce, 1 se il tempo e' scaduto. Chi chiama decide cosa fare:
# qui non si installa niente e non si rompe niente, si dice soltanto com'e'
# messa - la stessa distinzione fra misurare e agire che regge il resto.
travel_wait_online() {
	local limit="${1:-60}" waited=0

	travel_online && return 0

	say "aspetto che la connessione torni (fino a ${limit}s)"
	while [ "$waited" -lt "$limit" ]; do
		sleep 5
		waited=$((waited + 5))
		if travel_online; then
			say "connessione tornata dopo ${waited}s"
			return 0
		fi
	done

	return 1
}

# `apk add` con un limite di tempo, e mai a vuoto.
#
# Il limite e' la parte che conta: e' l'assenza di un limite ad aver bloccato
# un'installazione intera, non l'assenza di rete. Una rete che manca e' un
# messaggio; un comando che non torna e' una serata persa.
travel_apk_add() {
	local timeout_bin=""

	command -v timeout >/dev/null 2>&1 && timeout_bin="timeout 180"

	# shellcheck disable=SC2086
	$timeout_bin apk update >/dev/null 2>&1 || true
	# shellcheck disable=SC2086
	$timeout_bin apk add "$@" >/dev/null 2>&1
}
