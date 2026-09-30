import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { qrMatrix, QR_QUIET_ZONE, qrSide } from '../src/lib/qr';
import { wifiUri } from '../src/lib/share';

const network = { ssid: 'Hotel', encryption: 'psk2', key: 'hotelguest', hidden: false };

describe('Wi-Fi QR payload', () => {
  it.each([
    ['psk', 'WPA'], ['psk2', 'WPA'], ['sae-mixed', 'WPA'],
    ['sae', 'SAE'], ['psk2+ccmp', 'WPA'], ['sae+ccmp', 'SAE'],
  ])('encodes %s as %s', (encryption, security) => {
    expect(wifiUri({ ...network, encryption })).toBe(`WIFI:T:${security};S:Hotel;P:hotelguest;;`);
  });

  it('omits even an old stored password for an open network', () => {
    expect(wifiUri({ ...network, encryption: 'none' })).toBe('WIFI:T:nopass;S:Hotel;;');
  });

  it('escapes delimiters and preserves whitespace and hidden status', () => {
    expect(wifiUri({ ...network, ssid: ' a;:,"\\ ', key: ' p;:,"\\ ', hidden: true }))
      .toBe('WIFI:T:WPA;S: a\\;\\:\\,\\"\\\\ ;P: p\\;\\:\\,\\"\\\\ ;H:true;;');
  });

  it('distinguishes hexadecimal-looking text from a raw WPA PSK', () => {
    expect(wifiUri({ ...network, ssid: 'C0FFEE', key: '12345678' }))
      .toBe('WIFI:T:WPA;S:"C0FFEE";P:"12345678";;');
    expect(wifiUri({ ...network, key: 'a'.repeat(64) })).toContain(`P:${'a'.repeat(64)};;`);
  });

  it('rejects missing credentials and unsupported security instead of making a broken QR', () => {
    expect(() => wifiUri({ ...network, key: '' })).toThrow('password salvata');
    expect(() => wifiUri({ ...network, encryption: 'wpa2' })).toThrow('tipo di sicurezza');
    expect(() => wifiUri({ ...network, encryption: '' })).toThrow('tipo di sicurezza');
    expect(() => wifiUri({ ...network, ssid: '' })).toThrow('nome della rete');
  });
});

describe('QR decoding with an independent reader', () => {
  it.each([
    network,
    { ...network, encryption: 'none', key: '' },
    { ...network, ssid: 'Caffè 東京 🛜', key: 'pàss;:"\\word', hidden: true },
    { ...network, ssid: ';'.repeat(32), key: '\\'.repeat(63) },
  ])('recovers the exact Wi-Fi payload for $ssid', (input) => {
    const payload = wifiUri(input);
    const matrix = qrMatrix(payload);
    const scale = 5;
    const side = qrSide(matrix) * scale;
    const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
    matrix.forEach((row, y) => row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const offset = (((y + QR_QUIET_ZONE) * scale + dy) * side +
            (x + QR_QUIET_ZONE) * scale + dx) * 4;
          pixels.fill(0, offset, offset + 3);
        }
      }
    }));
    expect(jsQR(pixels, side, side)?.data).toBe(payload);
  });
});
