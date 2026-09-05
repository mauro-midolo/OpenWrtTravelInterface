# Se qualcosa va storto

Scritto per quando sei in viaggio, hai solo il telefono e non hai SSH.

> **Salva questa pagina offline sul telefono prima di partire.** Se il router non
> funziona non puoi leggerla dal router, e potresti non avere Internet.

Indirizzo di riferimento: **192.168.10.1**. Se l'hai cambiato, usa il tuo.

---

## Prima cosa da fare: aspettare

Se hai appena confermato una modifica e la pagina non risponde piu':

**Non fare niente per due minuti.**

Ogni modifica rischiosa viene applicata con un timeout: se non arriva la
conferma entro 90 secondi, il router torna da solo alla configurazione
precedente. Nella maggior parte dei casi si risolve cosi', da solo.

Se dopo due minuti sei ancora fuori, scendi lungo questa lista. I livelli sono
in ordine: prova il primo, e solo se fallisce passa al successivo.

---

## Livello 1 — Riconnettere il telefono all'access point

Il tuo telefono potrebbe essersi solo scollegato.

1. Impostazioni WiFi del telefono, dimentica la rete del router e ricollegati.
2. Se l'access point non compare piu' nella lista, prova a cercarlo **sull'altra
   banda**: l'interfaccia sposta l'AP tra 2.4 e 5 GHz a seconda della rete a cui
   e' collegato il router. Il nome e la password restano gli stessi.
3. Apri `https://192.168.10.1/travel/`.

---

## Livello 2 — LuCI

LuCI e' l'interfaccia standard di OpenWrt e resta installata e intatta apposta:
se l'app di gestione non parte, LuCI c'e' comunque.

Apri: **`https://192.168.10.1/cgi-bin/luci`**

Questo indirizzo funziona sempre, anche se l'app di gestione e' rotta: e' un
percorso di LuCI, non suo. La radice del router (`https://192.168.10.1/`) apre
l'app, ma quella pagina elenca anche LuCI, quindi da li' si arriva comunque.
Per rimettere LuCI sulla radice: `cp /www/index.html.luci /www/index.html`.

Cosa puoi fare da li' con il telefono:

| Problema | Dove andare in LuCI |
|---|---|
| Ripristinare una configurazione salvata | System → Backup / Flash Firmware → Restore |
| Rimettere in piedi il WiFi | Network → Wireless |
| Rimettere la porta ethernet come LAN | Network → Interfaces |
| Vedere cosa e' successo | Status → System Log |
| Disinstallare l'app di gestione | System → Software, cerca `travel` |

---

## Livello 3 — Terminale web

Se durante il setup hai installato il terminale web, hai una riga di comando
**dentro il browser del telefono**, senza SSH.

Apri: **`https://192.168.10.1/cgi-bin/luci/admin/services/ttyd`**

Comandi utili:

```sh
# Cos'e' cambiato di recente nella configurazione
uci changes

# Buttare via modifiche non ancora salvate
uci revert network wireless firewall dhcp

# Rimettere in piedi rete e wireless
/etc/init.d/network restart
wifi up

# Vedere gli ultimi errori
logread | tail -50
```

**Ripristinare l'ultima configurazione confermata dall'interfaccia:**

```sh
tar xzf /etc/travel/lastgood.tar.gz -C /
reboot
```

**Disattivare del tutto l'app di gestione, lasciando il router funzionante:**

```sh
rm -f /usr/libexec/rpcd/travel
/etc/init.d/rpcd restart
```

---

## Livello 4 — Ethernet

Se il WiFi e' completamente inutilizzabile ma hai un cavo e un computer:

1. Collega il computer a una porta **LAN** del router.
2. Apri `https://192.168.10.1/cgi-bin/luci`.

Se la porta era stata commutata in WAN, l'unica porta LAN potrebbe essere
l'altra. Provale entrambe.

---

## Livello 5 — Failsafe mode

> I livelli 5 e 6 sono le procedure standard di OpenWrt. La tempistica esatta
> del pulsante e il comportamento dei LED variano da modello a modello e **non
> sono ancora state verificate su questo dispositivo**: provale una volta a casa,
> con calma, prima di doverci contare in aeroporto.

Serve un computer con un cavo di rete. Rimette il router in uno stato minimo
senza cancellare niente.

1. Stacca la corrente al router.
2. Ridai corrente e guarda il LED di stato.
3. Appena il LED comincia a lampeggiare, **premi il pulsante reset una volta**
   (una pressione breve, non tenuto premuto).
4. Il LED lampeggia piu' velocemente: sei in failsafe.
5. Imposta sul computer l'indirizzo IP fisso `192.168.1.2` con maschera
   `255.255.255.0`.
6. Collegati con telnet a `192.168.1.1` (in failsafe non c'e' password).
7. Da li':

```sh
mount_root          # rende scrivibile la configurazione
firstboot -y        # ATTENZIONE: cancella tutta la configurazione
reboot -f
```

`firstboot` riporta il router come appena flashato: perdi tutte le reti salvate
e tutta la configurazione, ma il firmware resta.

---

## Livello 6 — Reset di fabbrica

L'ultima spiaggia, non serve nessun computer.

1. A router acceso e avviato, **tieni premuto il pulsante reset per almeno 10
   secondi**, finche' i LED non lampeggiano tutti insieme.
2. Rilascia. Il router si riavvia con la configurazione di fabbrica.

**Attenzione all'indirizzo dopo il reset.** `192.168.10.1` e' la tua
impostazione, non quella di fabbrica: il reset la cancella. Il router torna
all'indirizzo di default dell'immagine OpenWrt, che di norma e'
**`192.168.1.1`**. Se dopo un reset cerchi ancora `192.168.10.1` sembra che il
router sia morto, e invece e' solo altrove. Vale anche per il Livello 5.

Dopo il reset il router e' senza password e va riconfigurato da zero. Se hai un
backup, caricalo da LuCI → System → Backup / Flash Firmware → Restore.

---

## Da fare *prima* di partire

- [ ] Salva questa pagina offline sul telefono.
- [ ] Scarica un backup della configurazione — dall'interfaccia da viaggio,
      *Impostazioni → Backup della configurazione → Scarica il backup*, oppure
      da LuCI → System → Backup — e mettilo sul telefono o nel cloud. E' lo
      stesso archivio: quello scaricato da qui si rimette anche da LuCI, che e'
      il caso che conta quando questa interfaccia non parte.
      **Contiene le password del WiFi e le chiavi della VPN**: tienilo come
      terresti quelle.
- [ ] Verifica che il terminale web si apra.
- [ ] Segnati la password di root da qualche parte che non sia il router.
- [ ] Prova almeno una volta il Livello 2, cosi' sai dov'e' quando serve.
