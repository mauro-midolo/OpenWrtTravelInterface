/**
 * Condivisione di una rete WiFi: il testo che finisce dentro il QR.
 *
 * Il formato non e' un'invenzione nostra: e' quello che leggono la fotocamera
 * di Android e quella di iOS, nato in ZXing e diventato lo standard di fatto
 * per "inquadra e connettiti". Sbagliarlo di un carattere non da' un errore -
 * da' un telefono che propone una rete che non esiste, o che chiede la
 * password lo stesso.
 *
 *   WIFI:T:<sicurezza>;S:<ssid>;P:<password>;H:true;;
 *
 * I due punti e virgola finali chiudono il record e non sono facoltativi.
 */

/** La sicurezza come la scrive il QR, dedotta dalla cifratura salvata. */
export function qrSecurity(encryption: string): 'nopass' | 'WPA' | 'SAE' {
  // Rete aperta: il campo P si omette.
  if (encryption === 'none') return 'nopass';
  // WPA3 puro. Android genera SAE per queste, e un telefono che ci prova con
  // WPA2 su una rete che accetta solo SAE non si aggancia.
  const base = encryption.split('+')[0];
  if (base === 'sae') return 'SAE';
  // WPA/WPA2 e transizione WPA2/WPA3 usano il tipo WPA del formato WiFi.
  if (['psk', 'psk2', 'psk-mixed', 'sae-mixed'].includes(base)) return 'WPA';
  throw new Error('Questo tipo di sicurezza non supporta la condivisione tramite QR.');
}

/**
 * Un valore dentro il record, con i caratteri che lo romperebbero protetti.
 *
 * Senza questo, un SSID che contiene un punto e virgola - sono ammessi -
 * chiuderebbe il campo a meta' e il telefono leggerebbe un nome troncato.
 * L'elenco dei caratteri da proteggere e' quello del formato: la barra
 * rovesciata per prima, altrimenti si proteggerebbero le barre appena messe.
 */
export function escapeField(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1');
}

/**
 * Vero se il valore verrebbe scambiato per una sequenza esadecimale.
 *
 * Il formato prevede che un valore di sole cifre esadecimali possa essere
 * letto come byte grezzi invece che come testo: una rete che si chiama
 * "C0FFEE" diventerebbe tre byte. Le virgolette dicono al lettore di prenderlo
 * per quello che e'.
 */
function looksHex(value: string): boolean {
  return value !== '' && /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0;
}

function field(value: string): string {
  const escaped = escapeField(value);
  return looksHex(value) ? `"${escaped}"` : escaped;
}

export interface ShareInput {
  ssid: string;
  encryption: string;
  /** Vuota per le reti aperte, e allora non compare nel record. */
  key: string;
  hidden: boolean;
}

/**
 * Il record da mettere nel QR per questa rete.
 *
 * Usa solo i dati della rete che gli si passa: SSID, sicurezza, password e se
 * e' nascosta. Non guarda a cosa e' collegato il router adesso, quindi vale
 * anche per una rete che non si sta usando - che e' il caso normale, si
 * condivide la rete di casa stando altrove.
 */
export function wifiUri(net: ShareInput): string {
  const security = qrSecurity(net.encryption);
  if (!net.ssid || new TextEncoder().encode(net.ssid).length > 32) {
    throw new Error('Il nome della rete salvata non è valido.');
  }
  if (security !== 'nopass' && !net.key) {
    throw new Error('Questa rete protetta non ha una password salvata. Modifica la rete prima di condividerla.');
  }

  const parts = [`T:${security}`, `S:${field(net.ssid)}`];

  // Una rete aperta non condivide eventuali vecchie credenziali salvate.
  if (security !== 'nopass') {
    // Una PSK WPA di 64 cifre esadecimali e' una chiave grezza, non una passphrase.
    const rawPsk = security === 'WPA' && /^[0-9a-fA-F]{64}$/.test(net.key);
    parts.push(`P:${rawPsk ? net.key : field(net.key)}`);
  }

  // H e' facoltativo per le reti visibili.
  if (net.hidden) parts.push('H:true');

  return `WIFI:${parts.join(';')};;`;
}
