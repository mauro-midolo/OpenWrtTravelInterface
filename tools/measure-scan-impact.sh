#!/bin/sh
# Measures how much a WiFi scan disturbs the rest of the device.
#
# Question it must answer: on this hardware there is ONE SINGLE phy with two
# radios. Does a scan on one radio also interrupt what is running on the other?
# It cannot be inferred from the documentation, it depends on the mt76 driver.
#
# The scan screen depends on the answer: if scanning is disruptive at the phy
# level, the requirement "scan without interrupting connected STAs" is
# impossible, and the UI must warn instead of promising it.
#
# IT CHANGES NOTHING: it only runs pings and scans.

PINGS=20
TMP=/tmp/travel-measure
mkdir -p "$TMP"

title() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
say()   { printf '%s\n' "$*"; }
fail()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# --- 1. What is turned on ---------------------------------------------------

command -v iw >/dev/null || fail "'iw' is missing (install the iw-full package)"

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

[ -s "$TMP/ifaces" ] || fail "no active wireless interface"

band_of() {
	[ "$1" = "0" ] && { echo "off"; return; }
	[ "$1" -lt 3000 ] && echo "2.4 GHz" || echo "5 GHz"
}

title "Wireless interfaces"
while read -r ifn typ freq; do
	printf '  %-8s %-8s %s\n' "$ifn" "$typ" "$(band_of "$freq")"
done < "$TMP/ifaces"

# --- 2. Who we make suffer -------------------------------------------------
#
# The best target is a device connected to the AP: it is exactly what happens
# in real life while you scan from the phone.

target_ip=""
target_desc=""
target_freq=0

while read -r ifn typ freq; do
	[ "$typ" = "AP" ] || continue
	for mac in $(iw dev "$ifn" station dump 2>/dev/null | awk '$1 == "Station" { print $2 }'); do
		ip=$(awk -v m="$mac" 'tolower($2) == tolower(m) { print $3; exit }' /tmp/dhcp.leases 2>/dev/null)
		[ -n "$ip" ] || continue
		target_ip="$ip"
		target_desc="client $mac connected to AP $ifn"
		target_freq="$freq"
		break
	done
	[ -n "$target_ip" ] && break
done < "$TMP/ifaces"

# Fallback: if there is no client on the AP, measure a STA's gateway.
if [ -z "$target_ip" ]; then
	while read -r ifn typ freq; do
		[ "$typ" = "managed" ] || continue
		iw dev "$ifn" link 2>/dev/null | grep -q '^Connected' || continue
		gw=$(ip route show dev "$ifn" 2>/dev/null | awk '/^default/ { print $3; exit }')
		[ -n "$gw" ] || continue
		target_ip="$gw"
		target_desc="gateway $gw reached by STA $ifn"
		target_freq="$freq"
		break
	done < "$TMP/ifaces"
fi

if [ -z "$target_ip" ]; then
	cat <<'EOF'

Found nothing to measure.

At least one of these two things is needed, then run again:
  - a device connected to the router's access point (the phone is just
    fine: connect it to the router's WiFi and leave it there);
  - the router connected to a WiFi network as a client.

If you are working over an ethernet cable, connect the phone to the AP: that
is exactly the case we want to measure.
EOF
	exit 1
fi

title "Measurement target"
say "  $target_desc"
say "  target radio: $(band_of "$target_freq")"

# Some busybox builds accept fractional intervals, others do not: more
# resolution when possible, without breaking when it is not.
PING_INT=1
if ping -c 1 -i 0.2 -W 1 "$target_ip" >/dev/null 2>&1; then
	PING_INT=0.2
fi
say "  interval between pings: ${PING_INT}s, $PINGS packets per test"

# --- 3. The tests -----------------------------------------------------------

report_ping() {
	loss=$(sed -n 's/.*, \([0-9]*\)% packet loss.*/\1/p' "$TMP/ping")
	rtt=$(sed -n 's|.*round-trip min/avg/max = \(.*\)|\1|p' "$TMP/ping")
	[ -n "$loss" ] || loss="?"
	printf '  loss: %s%%   rtt min/avg/max: %s\n' "$loss" "${rtt:-n/a}"
}

title "Test 0 - baseline, no scan"
ping -c "$PINGS" -i "$PING_INT" -W 1 "$target_ip" > "$TMP/ping" 2>&1
report_ping

# One test per radio: scan using an interface that lives on that radio, and
# see whether the target (which is on the other one) notices.
seen_bands=""
while read -r ifn typ freq; do
	[ "$freq" = "0" ] && continue
	band=$(band_of "$freq")
	case " $seen_bands " in *" $band "*) continue ;; esac
	seen_bands="$seen_bands $band"

	if [ "$band" = "$(band_of "$target_freq")" ]; then
		relation="SAME radio as the target (disturbance expected)"
	else
		relation="OTHER radio than the target (this is what matters)"
	fi

	title "Test - scan on $ifn ($band)"
	say "  $relation"

	ping -c "$PINGS" -i "$PING_INT" -W 1 "$target_ip" > "$TMP/ping" 2>&1 &
	ping_pid=$!

	sleep 3
	t0=$(date +%s)
	if iw dev "$ifn" scan > "$TMP/scan" 2>&1; then
		t1=$(date +%s)
		found=$(grep -c '^BSS ' "$TMP/scan")
		say "  scan succeeded: $found networks in $((t1 - t0))s"
	else
		t1=$(date +%s)
		say "  scan FAILED after $((t1 - t0))s: $(head -n 1 "$TMP/scan")"
	fi

	wait "$ping_pid"
	report_ping
done < "$TMP/ifaces"

# --- 4. Context -------------------------------------------------------------

title "Latest log lines"
logread 2>/dev/null | tail -n 25

title "How to read it"
cat <<'EOF'
  Compare the loss of Test 0 with that of the following tests.

  - Loss similar to the baseline even when scanning on the OTHER radio
    -> the radios are independent: scanning does not disturb.

  - Much higher loss on the OTHER radio as well
    -> the scan takes up the whole phy: the UI will have to warn that
       scanning briefly interrupts connections.

  - Scan failed on an interface in AP mode
    -> scanning that band will need a dedicated interface.
EOF

printf '\n'
