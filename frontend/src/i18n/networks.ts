import { defineText } from '.';

/**
 * Testi delle funzioni WiFi di `lib/`: cifrature, bande, errori di scansione
 * e di condivisione.
 */
export const networksText = defineText({
  it: {
    noBand: 'nessuna banda',
    bothBands: '2.4 e 5 GHz',
    unreadableSaved: 'Impossibile leggere i dati della rete salvata.',
    scanFailed: (band: string, error: string) => `Scansione su ${band} GHz: ${error}`,
    noAp: (radio: string) =>
      `Nessun access point configurato su ${radio}. Rilancia tools\\setup-ap.ps1.`,
    open: 'Aperta',
    enc: {
      apSaeMixed: {
        label: 'WPA2 + WPA3 (consigliato)',
        note: 'Compatibile con tutto, usa WPA3 dove il dispositivo lo supporta.',
      },
      apSae: {
        label: 'WPA3',
        note: 'Il più sicuro. I dispositivi anteriori al 2019 circa non si collegano.',
      },
      apPsk2: {
        label: 'WPA2',
        note: 'Lo standard classico, compatibile con qualunque dispositivo recente.',
      },
      staPsk2: { label: 'WPA2', note: 'Il caso normale: quasi tutte le reti protette di oggi.' },
      staSaeMixed: {
        label: 'WPA2 / WPA3',
        note: 'Reti che accettano entrambi. Se WPA2 non basta, di solito è questa.',
      },
      staSae: { label: 'WPA3', note: 'Solo WPA3. Una rete così rifiuta i dispositivi più vecchi.' },
      staNone: {
        label: 'Nessuna (rete aperta)',
        note: 'Senza password. Il traffico viaggia in chiaro fino al punto di accesso.',
      },
    },
    share: {
      unsupported: 'Questo tipo di sicurezza non supporta la condivisione tramite QR.',
      badSsid: 'Il nome della rete salvata non è valido.',
      noKey:
        'Questa rete protetta non ha una password salvata. Modifica la rete prima di condividerla.',
    },
  },
  en: {
    noBand: 'no band',
    bothBands: '2.4 and 5 GHz',
    unreadableSaved: 'Could not read the saved network data.',
    scanFailed: (band: string, error: string) => `Scan on ${band} GHz: ${error}`,
    noAp: (radio: string) =>
      `No access point configured on ${radio}. Run tools\\setup-ap.ps1 again.`,
    open: 'Open',
    enc: {
      apSaeMixed: {
        label: 'WPA2 + WPA3 (recommended)',
        note: 'Works with everything, uses WPA3 where the device supports it.',
      },
      apSae: {
        label: 'WPA3',
        note: 'The most secure. Devices older than about 2019 cannot connect.',
      },
      apPsk2: {
        label: 'WPA2',
        note: 'The classic standard, works with any recent device.',
      },
      staPsk2: { label: 'WPA2', note: 'The usual case: almost every protected network today.' },
      staSaeMixed: {
        label: 'WPA2 / WPA3',
        note: 'Networks that accept both. If WPA2 is not enough, it is usually this one.',
      },
      staSae: { label: 'WPA3', note: 'WPA3 only. Such a network rejects older devices.' },
      staNone: {
        label: 'None (open network)',
        note: 'No password. Traffic travels unencrypted up to the access point.',
      },
    },
    share: {
      unsupported: 'This kind of security cannot be shared with a QR code.',
      badSsid: 'The saved network name is not valid.',
      noKey: 'This protected network has no saved password. Edit the network before sharing it.',
    },
  },
});
