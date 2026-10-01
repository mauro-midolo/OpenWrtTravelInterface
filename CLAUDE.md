## Git

Dopo ogni modifica completata, esegui sempre commit e push delle modifiche sul repository remoto, utilizzando il branch Git attualmente attivo.

#Router di test

È disponibile un router collegato al PC, raggiungibile all'indirizzo 192.168.10.1.

Il router non ha alcuna password configurata ed è disponibile per test, verifiche e sviluppo delle funzionalità del progetto.

## Documentazione in due lingue

`README.md` (inglese, versione predefinita) e `README-it.md` (italiano) vanno sempre modificati insieme: ogni cambiamento a uno dei due deve essere riportato nell'altro nello stesso commit, mantenendo la stessa struttura di sezioni.

Lo stesso vale per i testi dell'interfaccia: ogni testo nuovo o modificato in `frontend/src/i18n/` va scritto sia in italiano sia in inglese.

I messaggi che il backend (plugin rpcd, helper shell, traveld) manda all'interfaccia sono in inglese e hanno sempre un codice (`fail_code codice "message" chiave valore`); la traduzione italiana e quella inglese del codice vanno aggiunte in `frontend/src/i18n/backend.ts`.
