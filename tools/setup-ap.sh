#!/bin/sh
# Crea l'access point su ENTRAMBE le radio, stesso SSID e stessa password.
#
# E' la base del piano radio: il dispositivo ha una sola phy con due radio e un
# canale per radio, quindi l'AP non puo' mai stare sulla stessa radio della STA
# senza rischiare di cadere con lei. Avendolo pronto su entrambe, l'interfaccia
# potra' spostarlo su quella libera a seconda della banda della rete a cui ci si
# collega, e dal telefono il cambio e' quasi invisibile.
#
# Parametri (variabili d'ambiente, iniettate dal wrapper PowerShell):
#   AP_SSID, AP_PASS, AP_COUNTRY

: "${AP_SSID:?manca AP_SSID}"
: "${AP_PASS:?manca AP_PASS}"
: "${AP_COUNTRY:=IT}"

say()  { printf '  %s\n' "$*"; }
head2() { printf '\n== %s ==\n' "$*"; }
fail() { printf '\nERRORE: %s\n' "$*" >&2; exit 1; }

[ ${#AP_PASS} -ge 8 ] || fail "la password deve essere di almeno 8 caratteri"

radios=$(uci show wireless 2>/dev/null | sed -n 's/^wireless\.\([^.]*\)=wifi-device$/\1/p')
[ -n "$radios" ] || fail "nessuna radio trovata in /etc/config/wireless"

apply_config() {
	enc="$1"

	# Le wifi-iface di default di OpenWrt vanno spente: se si abilita la radio
	# senza toccarle, si accende una rete "OpenWrt" APERTA. Meglio saperlo.
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

head2 "Radio trovate"
for r in $radios; do say "$r"; done

# WPA2/WPA3 in transizione se il wpad installato lo regge, altrimenti WPA2:
# meglio degradare in modo visibile che lasciare l'AP giu' senza spiegazione.
head2 "Configuro l'AP (WPA2/WPA3 in transizione)"
say "SSID: $AP_SSID"
say "Country code: $AP_COUNTRY"
apply_config "sae-mixed"

if [ "$(count_ap)" -eq 0 ]; then
	head2 "WPA3 non disponibile, ripiego su WPA2"
	say "Il wpad installato non supporta SAE."
	apply_config "psk2"
fi

head2 "Risultato"
n=$(count_ap)
if [ "$n" -eq 0 ]; then
	say "Nessun access point attivo. Ultimi messaggi:"
	logread 2>/dev/null | grep -iE 'hostapd|wifi|netifd' | tail -n 15
	exit 1
fi

say "$n access point attivi:"
iw dev | awk '
	$1 == "Interface" { ifn = $2 }
	$1 == "type"      { typ = $2 }
	$1 == "channel"   { n = split($0, a, "("); split(a[2], b, " ")
	                    if (typ == "AP") printf "    %-8s  %s MHz\n", ifn, b[1] }
'

head2 "Regolatorio in vigore"
iw reg get 2>/dev/null | head -n 12

head2 "Fatto"
say "Collega il telefono alla rete \"$AP_SSID\" e lascia lo schermo acceso,"
say "poi lancia la misura:  .\\tools\\measure-scan-impact.ps1"
