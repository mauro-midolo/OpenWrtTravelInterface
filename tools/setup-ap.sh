#!/bin/sh
# Creates the access point on BOTH radios, with the same SSID and password.
#
# It is the basis of the radio plan: the device has a single phy with two radios
# and one channel per radio, so an AP on the same radio as the STA can go down
# together with it. With an AP on both radios, the one not used by the uplink
# keeps offering access to the router.
#
# Parameters (environment variables, injected by the PowerShell wrapper):
#   AP_SSID, AP_PASS, AP_COUNTRY

: "${AP_SSID:?AP_SSID is missing}"
: "${AP_PASS:?AP_PASS is missing}"
: "${AP_COUNTRY:=IT}"

say()  { printf '  %s\n' "$*"; }
head2() { printf '\n== %s ==\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ ${#AP_PASS} -ge 8 ] || fail "the password must be at least 8 characters long"

radios=$(uci show wireless 2>/dev/null | sed -n 's/^wireless\.\([^.]*\)=wifi-device$/\1/p')
[ -n "$radios" ] || fail "no radio found in /etc/config/wireless"

apply_config() {
	enc="$1"

	# OpenWrt's default wifi-ifaces must be turned off: enabling the radio
	# without touching them brings up an OPEN "OpenWrt" network.
	for i in $(uci show wireless | sed -n 's/^wireless\.\([^.]*\)=wifi-iface$/\1/p'); do
		case "$i" in
			ap_*) continue ;;
		esac
		uci set "wireless.$i.disabled=1"
	done

	for r in $radios; do
		uci set "wireless.$r.country=$AP_COUNTRY"
		uci set "wireless.$r.disabled=0"

		sec="ap_$r"
		uci set "wireless.$sec=wifi-iface"
		uci set "wireless.$sec.device=$r"
		uci set "wireless.$sec.network=lan"
		uci set "wireless.$sec.mode=ap"
		uci set "wireless.$sec.ssid=$AP_SSID"
		uci set "wireless.$sec.encryption=$enc"
		uci set "wireless.$sec.key=$AP_PASS"
		uci set "wireless.$sec.disabled=0"
	done

	uci commit wireless
	wifi reload >/dev/null 2>&1
	sleep 8
}

count_ap() {
	iw dev 2>/dev/null | grep -c 'type AP'
}

head2 "Radios found"
for r in $radios; do say "$r"; done

# WPA2/WPA3 transition mode if the installed wpad supports it, otherwise WPA2:
# better to degrade visibly than to leave the AP down without explanation.
head2 "Configuring the AP (WPA2/WPA3 transition mode)"
say "SSID: $AP_SSID"
say "Country code: $AP_COUNTRY"
apply_config "sae-mixed"

if [ "$(count_ap)" -eq 0 ]; then
	head2 "WPA3 not available, falling back to WPA2"
	say "The installed wpad does not support SAE."
	apply_config "psk2"
fi

head2 "Result"
n=$(count_ap)
if [ "$n" -eq 0 ]; then
	say "No access point active. Latest messages:"
	logread 2>/dev/null | grep -iE 'hostapd|wifi|netifd' | tail -n 15
	exit 1
fi

say "$n access point(s) active:"
iw dev | awk '
	$1 == "Interface" { ifn = $2 }
	$1 == "type"      { typ = $2 }
	$1 == "channel"   { n = split($0, a, "("); split(a[2], b, " ")
	                    if (typ == "AP") printf "    %-8s  %s MHz\n", ifn, b[1] }
'

head2 "Regulatory domain in effect"
iw reg get 2>/dev/null | head -n 12

head2 "Done"
say "Connect the phone to the \"$AP_SSID\" network and keep the screen on,"
say "then run the measurement:  .\\tools\\measure-scan-impact.ps1"
