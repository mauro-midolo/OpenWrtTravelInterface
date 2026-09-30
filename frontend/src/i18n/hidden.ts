import { defineText } from '.';

/** Il modulo della rete nascosta (`screens/HiddenNetwork.tsx`). */
export const hiddenText = defineText({
  it: {
    title: 'Aggiungi rete nascosta',
    ssid: 'Nome della rete (SSID)',
    ssidPlaceholder: "esattamente com'è scritto",
    ssidTooLong: 'Il nome può essere lungo al massimo 32 byte.',
    bands: 'Bande',
    pickBand: 'Scegli almeno una banda.',
    security: 'Sicurezza',
    password: 'Password',
    minPassword: 'almeno 8 caratteri',
    badPassword: 'La password deve essere fra 8 e 63 caratteri.',
    note: 'Nota (facoltativa)',
    notePlaceholder: "es. rete dell'ufficio",
    conflict: (ssid: string, band: string) =>
      `«${ssid}» è già salvata a ${band}: modificala dalle reti salvate.`,
  },
  en: {
    title: 'Add hidden network',
    ssid: 'Network name (SSID)',
    ssidPlaceholder: 'exactly as it is written',
    ssidTooLong: 'The name can be at most 32 bytes long.',
    bands: 'Bands',
    pickBand: 'Choose at least one band.',
    security: 'Security',
    password: 'Password',
    minPassword: 'at least 8 characters',
    badPassword: 'The password must be between 8 and 63 characters.',
    note: 'Note (optional)',
    notePlaceholder: 'e.g. office network',
    conflict: (ssid: string, band: string) =>
      `«${ssid}» is already saved on ${band}: edit it from the saved networks.`,
  },
});
