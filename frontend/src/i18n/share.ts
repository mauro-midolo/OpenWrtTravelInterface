import { defineText } from '.';

/** La condivisione di una rete col QR (`screens/ShareNetwork.tsx`). */
export const shareText = defineText({
  it: {
    title: (ssid: string) => `Condividi ${ssid}`,
    loading: 'Leggo la rete salvata dal router…',
    hidden: ' · rete nascosta',
    qr: (ssid: string) => `Codice QR per collegarsi a ${ssid}`,
    open: 'Rete aperta, senza password.',
    password: 'Password',
    masked: 'Password nascosta',
    hide: 'Nascondi password',
    show: 'Mostra password',
  },
  en: {
    title: (ssid: string) => `Share ${ssid}`,
    loading: 'Reading the saved network from the router…',
    hidden: ' · hidden network',
    qr: (ssid: string) => `QR code to connect to ${ssid}`,
    open: 'Open network, no password.',
    password: 'Password',
    masked: 'Password hidden',
    hide: 'Hide password',
    show: 'Show password',
  },
});
