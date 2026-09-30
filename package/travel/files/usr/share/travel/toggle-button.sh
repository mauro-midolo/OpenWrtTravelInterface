#!/bin/sh
# Rilevamento dell'interruttore fisico.
#
# Riceve dall'hotplug dei tasti `ACTION` e `BUTTON` e ne ricava una sola cosa:
# da che parte sta la levetta. Cosa succeda poi non lo decide qui - lo dice la
# configurazione, e la esegue `toggle_run`. E' il motivo per cui aggiungere una
# funzione all'interruttore non richiede di rimettere le mani in questo file.
#
# Un interruttore a levetta e' un EV_SW: il kernel manda "pressed" quando e'
# chiuso e "released" quando e' aperto, una volta per ogni spostamento e una
# all'avvio. Non e' un tasto, quindi "timeout" e le pressioni lunghe non
# arrivano mai e non hanno un significato da tradurre.
#
# Quale delle due posizioni sia "acceso" non lo dice il kernel: lo dice la
# serigrafia. Sul Beryl 7 il pallino stampato sta a destra, e a destra la
# levetta risulta aperta, cioe' "released" - provato sul router. E' l'unico
# punto in cui questa scelta e' scritta: chi legge il resto vede solo "on" e
# "off", e un modello che cablasse la levetta al contrario si sistema qui.
. /usr/share/travel/toggle.sh

case "$ACTION" in
	released) position=on ;;
	pressed)  position=off ;;
	*) exit 0 ;;
esac

toggle_run "$position" ||
	logger -t travel-toggle "Azione dell'interruttore ${BUTTON:-fisico} fallita ($position)"

exit 0
