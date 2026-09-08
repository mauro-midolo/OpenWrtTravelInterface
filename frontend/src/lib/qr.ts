/**
 * Generazione del QR, in un posto solo.
 *
 * La libreria sta dietro questa funzione e non compare altrove: il resto del
 * pannello lavora su una matrice di booleani, che e' tutto quello che serve
 * per disegnarla.
 */

import qrcode from 'qrcode-generator';

/**
 * I byte del testo, in UTF-8.
 *
 * La libreria di suo tronca ogni carattere a un byte (`c & 0xff`), che per
 * l'ASCII va bene e per tutto il resto no: un SSID "Caffè" finirebbe nel QR
 * come un byte 0xE9 isolato, e il telefono - che legge UTF-8 - proporrebbe di
 * collegarsi a un nome diverso da quello vero. Si sostituisce con l'encoder
 * della piattaforma, che fa esattamente la cosa giusta.
 */
qrcode.stringToBytes = (text: string) => Array.from(new TextEncoder().encode(text));

/**
 * La matrice del QR per questo testo: `true` = modulo scuro.
 *
 * Correzione d'errore M: e' il compromesso che usano i generatori di sistema.
 * Con L il codice sarebbe piu' piccolo ma perdona meno una foto storta o uno
 * schermo sporco; con Q o H crescerebbe senza che serva, visto che qui si
 * inquadra uno schermo a mezzo metro e non un'etichetta scolorita.
 *
 * La versione la sceglie la libreria (`0`): dipende da quanto e' lungo il
 * testo, e una password lunga fa crescere il codice da sola.
 */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const size = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let row = 0; row < size; row += 1) {
    const cells: boolean[] = [];
    for (let col = 0; col < size; col += 1) cells.push(qr.isDark(row, col));
    rows.push(cells);
  }
  return rows;
}

/** Quanto margine chiaro serve attorno al codice, in moduli. */
export const QR_QUIET_ZONE = 4;

/**
 * Il QR come path SVG unico.
 *
 * Un rettangolo per modulo sarebbero migliaia di nodi; un solo `path` con un
 * comando per modulo si disegna in un colpo e resta nitido a qualsiasi
 * dimensione, che e' cio' che serve a uno schermo che verra' inquadrato.
 */
export function qrPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  matrix.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h1v1h-1z`);
    });
  });
  return parts.join('');
}

/** Il lato del disegno, moduli piu' margine da entrambi i lati. */
export function qrSide(matrix: boolean[][]): number {
  return matrix.length + QR_QUIET_ZONE * 2;
}
