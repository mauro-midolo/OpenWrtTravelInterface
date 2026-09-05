// Serve a scoprire con quale opzione questo ucode esegue un file come script.
//
// In modalita' script stampa TRAVELOK; in modalita' template stamperebbe il
// proprio sorgente, dove "TRAVEL" e "OK" restano separati e non combaciano
// con la ricerca. Cosi' l'init script non deve indovinare l'opzione giusta.
print("TRAVEL" + "OK\n");
