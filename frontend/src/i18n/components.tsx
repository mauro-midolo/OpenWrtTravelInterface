import { defineText } from '.';

/** I componenti condivisi (`components/`) e i testi di `lib/toggle.ts`. */
export const componentsText = defineText({
  it: {
    apply: {
      applying: 'Applico la configurazione…',
      waiting:
        'Se la pagina non risponde, allo scadere il router torna alla configurazione precedente.',
      abort: 'Annulla subito',
      rolledBack:
        'Nessuna conferma in tempo: il router è tornato alla configurazione precedente.',
    },
    led: {
      label: 'LED di stato',
      byToggle: "Lo comanda l'interruttore fisico",
    },
    toggle: {
      label: 'Interruttore fisico',
      unknownHint: 'Il router la rileva al primo movimento della levetta',
      positionHint: 'Posizione attuale della levetta',
      unknown: 'posizione ignota',
      actions: {
        none: 'Non fare nulla',
        led: 'Controllo LED di stato',
        ap24: 'Controllo access point WiFi 2,4 GHz',
        ap5: 'Controllo access point WiFi 5 GHz',
      },
    },
    unavailable: 'non disponibile',
    loading: 'Caricamento…',
    mac: {
      label: 'Indirizzo MAC da usare',
      device: 'Della scheda',
      random: 'Casuale',
      manual: 'Manuale',
      clone: 'Di un dispositivo',
      regenerate: 'Rigenera',
      loadingClients: 'Leggo i dispositivi collegati…',
      noClients: 'Nessun dispositivo collegato.',
      cloneWarn: (mac: string) => (
        <>
          <code>{mac}</code> — quel dispositivo non deve restare collegato direttamente a questa
          rete.
        </>
      ),
      invalid: 'Indirizzo MAC non valido.',
    },
  },
  en: {
    apply: {
      applying: 'Applying the configuration…',
      waiting: 'If the page stops responding, when time runs out the router rolls back.',
      abort: 'Cancel now',
      rolledBack: 'No confirmation in time: the router rolled back to the previous configuration.',
    },
    led: {
      label: 'Status LED',
      byToggle: 'Controlled by the physical switch',
    },
    toggle: {
      label: 'Physical switch',
      unknownHint: 'The router detects it the first time the switch moves',
      positionHint: 'Current switch position',
      unknown: 'position unknown',
      actions: {
        none: 'Do nothing',
        led: 'Status LED control',
        ap24: '2.4 GHz WiFi access point control',
        ap5: '5 GHz WiFi access point control',
      },
    },
    unavailable: 'not available',
    loading: 'Loading…',
    mac: {
      label: 'MAC address to use',
      device: 'Adapter’s own',
      random: 'Random',
      manual: 'Manual',
      clone: 'From a device',
      regenerate: 'Regenerate',
      loadingClients: 'Reading connected devices…',
      noClients: 'No device connected.',
      cloneWarn: (mac: string) => (
        <>
          <code>{mac}</code> — that device must not stay connected directly to this network.
        </>
      ),
      invalid: 'Invalid MAC address.',
    },
  },
});
