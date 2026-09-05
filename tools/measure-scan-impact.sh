#!/bin/sh
# Misura quanto una scansione WiFi disturba il resto del dispositivo.
#
# Domanda a cui deve rispondere: su questo hardware c'e' UNA SOLA phy con due
# radio. Una scansione su una radio interrompe anche quello che sta girando
# sull'altra? Non e' deducibile dalla documentazione, dipende dal driver mt76.
#
# Dalla risposta dipende la schermata di scansione: se la scansione e'
# distruttiva a livello di phy, il requisito "scansiona senza interrompere le
# STA connesse" e' impossibile, e la UI deve avvisare invece di prometterlo.
#
# NON MODIFICA NIENTE: esegue solo ping e scansioni.

PINGS=20
TMP=/tmp/travel-measure
mkdir -p "$TMP"

title() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
say()   { printf '%s\n' "$*"; }
fail()  { printf '\nERRORE: %s\n' "$*" >&2; exit 1; }

# --- 1. Che cosa c'e' acceso -------------------------------------------------

command -v iw >/dev/null || fail "manca 'iw' (installa il pacchetto iw-full)"

iw dev | awk '
	function flush() {
		if (ifn != "")
			printf "%s %s %s\n", ifn, (typ == "" ? "?" : typ), (freq == "" ? 0 : freq)
		ifn = ""; typ = ""; freq = ""
	}
	$1 == "Interface" { flush(); ifn = $2 }
	$1 == "type"      { typ = $2 }
	$1 == "channel"   { n = split($0, a, "("); split(a[2], b, " "); freq = b[1] }
	END { flush() }
' > "$TMP/ifaces"

[ -s "$TMP/ifaces" ] || fail "nessuna interfaccia wireless attiva"

band_of() {
	[ "$1" = "0" ] && { echo "spenta"; return; }
	[ "$1" -lt 3000 ] && echo "2.4 GHz" || echo "5 GHz"
}

title "Interfacce wireless"
while read -r ifn typ freq; do
	printf '  %-8s %-8s %s\n' "$ifn" "$typ" "$(band_of "$freq")"
done < "$TMP/ifaces"

# --- 2. Chi facciamo soffrire ------------------------------------------------
#
# Il bersaglio migliore e' un dispositivo collegato all'AP: e' esattamente
# quello che succede nella realta' mentre scansioni dal telefono.

target_ip=""
target_desc=""
target_freq=0

while read -r ifn typ freq; do
	[ "$typ" = "AP" ] || continue
	for mac in $(iw dev "$ifn" station dump 2>/dev/null | awk '$1 == "Station" { print $2 }'); do
		ip=$(awk -v m="$mac" 'tolower($2) == tolower(m) { print $3; exit }' /tmp/dhcp.leases 2>/dev/null)
		[ -n "$ip" ] || continue
		target_ip="$ip"
		target_desc="client $mac collegato all'AP $ifn"
		target_freq="$freq"
		break
	done
	[ -n "$target_ip" ] && break
done < "$TMP/ifaces"

# Ripiego: se non c'e' nessun client sull'AP, si misura il gateway di una STA.
if [ -z "$target_ip" ]; then
	while read -r ifn typ freq; do
		[ "$typ" = "managed" ] || continue
		iw dev "$ifn" link 2>/dev/null | grep -q '^Connected' || continue
		gw=$(ip route show dev "$ifn" 2>/dev/null | awk '/^default/ { print $3; exit }')
		[ -n "$gw" ] || continue
		target_ip="$gw"
		target_desc="gateway $gw raggiunto dalla STA $ifn"
		target_freq="$freq"
		break
	done < "$TMP/ifaces"
fi

if [ -z "$target_ip" ]; then
	cat <<'EOF'

Non ho trovato niente da misurare.

Serve almeno una di queste due cose, poi rilancia:
  - un dispositivo collegato all'access point del router (il telefono va
    benissimo: collegalo al WiFi del router e lascialo li');
  - il router collegato a una rete WiFi come client.

Se stai lavorando via cavo ethernet, collega il telefono all'AP: e' proprio
il caso che ci interessa misurare.
EOF
	exit 1
fi

title "Bersaglio della misura"
say "  $target_desc"
say "  radio del bersaglio: $(band_of "$target_freq")"

# Alcune build di busybox accettano intervalli frazionari, altre no: piu'
# risoluzione se possibile, senza rompersi se non lo e'.
PING_INT=1
if ping -c 1 -i 0.2 -W 1 "$target_ip" >/dev/null 2>&1; then
	PING_INT=0.2
fi
say "  intervallo fra i ping: ${PING_INT}s, $PINGS pacchetti per prova"

# --- 3. Le prove -------------------------------------------------------------

report_ping() {
	loss=$(sed -n 's/.*, \([0-9]*\)% packet loss.*/\1/p' "$TMP/ping")
	rtt=$(sed -n 's|.*round-trip min/avg/max = \(.*\)|\1|p' "$TMP/ping")
	[ -n "$loss" ] || loss="?"
	printf '  perdita: %s%%   rtt min/avg/max: %s\n' "$loss" "${rtt:-n/d}"
}

title "Prova 0 - riferimento, nessuna scansione"
ping -c "$PINGS" -i "$PING_INT" -W 1 "$target_ip" > "$TMP/ping" 2>&1
report_ping

# Una prova per ogni radio: si scansiona usando un'interfaccia che vive su
# quella radio, e si guarda se il bersaglio (che sta sull'altra) se ne accorge.
seen_bands=""
while read -r ifn typ freq; do
	[ "$freq" = "0" ] && continue
	band=$(band_of "$freq")
	case " $seen_bands " in *" $band "*) continue ;; esac
	seen_bands="$seen_bands $band"

	if [ "$band" = "$(band_of "$target_freq")" ]; then
		relazione="STESSA radio del bersaglio (ci si aspetta disturbo)"
	else
		relazione="ALTRA radio rispetto al bersaglio (qui si gioca tutto)"
	fi

	title "Prova - scansione su $ifn ($band)"
	say "  $relazione"

	ping -c "$PINGS" -i "$PING_INT" -W 1 "$target_ip" > "$TMP/ping" 2>&1 &
	ping_pid=$!

	sleep 3
	t0=$(date +%s)
	if iw dev "$ifn" scan > "$TMP/scan" 2>&1; then
		t1=$(date +%s)
		found=$(grep -c '^BSS ' "$TMP/scan")
		say "  scansione riuscita: $found reti in $((t1 - t0))s"
	else
		t1=$(date +%s)
		say "  scansione FALLITA dopo $((t1 - t0))s: $(head -n 1 "$TMP/scan")"
	fi

	wait "$ping_pid"
	report_ping
done < "$TMP/ifaces"

# --- 4. Contesto -------------------------------------------------------------

title "Ultime righe di log"
logread 2>/dev/null | tail -n 25

title "Come si legge"
cat <<'EOF'
  Confronta la perdita della Prova 0 con quella delle prove successive.

  - Perdita simile al riferimento anche scansionando sull'ALTRA radio
    -> le radio sono indipendenti: si puo' scansionare senza disturbare.

  - Perdita molto piu' alta anche sull'ALTRA radio
    -> la scansione occupa tutta la phy: la UI dovra' avvisare che
       scansionare interrompe momentaneamente le connessioni.

  - Scansione fallita su un'interfaccia in modo AP
    -> per scansionare quella banda servira' un'interfaccia dedicata.
EOF

printf '\n'
