/**
 * Il dispositivo: stato e porta USB.
 *
 * E' la controparte della schermata Impostazioni, come lib/portal.ts lo e' del
 * captive portal. La parte USB stava in lib/dashboard.ts finche' la porta viveva
 * in fondo alla dashboard: adesso che ha una scheda sua, sta con il resto di
 * cio' che riguarda l'hardware del router.
 *
 * Lo stato arriva da `travel.status`, cioe' dal plugin rpcd e non da travelD:
 * questa schermata deve funzionare anche quando il daemon non risponde - e' il
 * posto da cui si apre LuCI, quindi proprio quello dove si finisce quando
 * qualcosa non va.
 */

import { call } from './ubus';

export interface DeviceStatus {
  /** Versione dei file installati sul router. */
  version: string;
  /** Fase del progetto a cui corrispondono. */
  phase: string;
  model: string;
  release: string;
  /** Nome del router, quello vero in RAM. */
  hostname: string;
  uptime: number;
  load: number[];
  memory: { total_kb: number; available_kb: number };
  overlay: { total_kb: number; available_kb: number };
  /** Millesimi di grado. Assente sui target senza sensore: non si inventa. */
  temp_mc?: number;
}

export function getStatus(): Promise<DeviceStatus> {
  return call<DeviceStatus>('travel', 'status');
}

/**
 * Una funzione esposta da un dispositivo USB.
 *
 * Un telefono ne espone diverse insieme - trasferimento file, ADB, e quando il
 * tethering e' acceso una di rete. E' il livello a cui si vede la differenza
 * fra "non sta offrendo rete" e "la offre e nessuno l'ha agganciata".
 */
export interface UsbFunction {
  /** "NCM (tethering)", "MTP (trasferimento file)"... vuoto se sconosciuta. */
  label: string;
  /** Codici grezzi classe.sottoclasse.protocollo, per i casi non tradotti. */
  class: string;
  /** Driver che l'ha presa, vuoto se nessuno. */
  driver: string;
  /** Vero per le funzioni di rete: le uniche che possono diventare un uplink. */
  network: boolean;
  /** Modulo del kernel che servirebbe, vuoto se non e' una funzione di rete. */
  module: string;
  /** caricato | installato | assente */
  module_state: string;
}

export interface UsbDevice {
  /** Porta del bus, es. "1-1". */
  port: string;
  name: string;
  vendor: string;
  product: string;
  /** Mbit/s dichiarati dal bus: 480 = High Speed, 5000 = SuperSpeed. */
  speed: string;
  /** Vuoto se nessun driver di rete lo ha agganciato. */
  netdev: string;
  driver: string;
  interfaces: UsbFunction[];
}

export interface UsbDevices {
  devices: UsbDevice[];
  /**
   * Stato dei moduli del tethering, `usbnet` compreso.
   *
   * `usbnet` e' la base di cdc_ncm, rndis_host e cdc_ether: se non si carica
   * lui non si carica nessuno dei tre, e il guasto sembra stare nel driver
   * specifico mentre sta nella dipendenza comune.
   */
  modules: Record<string, string>;
  wan_usb: { device: string; disabled: boolean };
}

/**
 * Cosa c'e' attaccato alla porta USB, e se qualcuno lo ha agganciato.
 *
 * Esiste per separare due situazioni che dall'interfaccia si vedevano uguali -
 * cioe' non si vedevano affatto: niente collegato, e collegato ma senza driver
 * di rete. Nel secondo caso il telefono mostra il tethering acceso e il router
 * non ha nessuna interfaccia da alzare, e senza questa lettura non c'e' modo
 * di accorgersene dal browser.
 */
export function getUsbDevices(): Promise<UsbDevices> {
  return call<UsbDevices>('travel', 'usb_devices');
}

export interface UsbState {
  /** Vero se la SuperSpeed e' spenta per scelta. */
  force_usb2: boolean;
  /** Cosa e' davvero in atto adesso: usb2 | usb3 | unsupported. */
  mode: string;
}

export function getUsb(): Promise<UsbState> {
  return call<UsbState>('travel', 'usb');
}

/**
 * Cambia la velocita' massima della porta USB.
 *
 * Il default e' la velocita' piena. Il limite a USB 2.0 esiste perche' su
 * questo SoC il link SuperSpeed con un telefono si e' visto cadere a ripetizione
 * - il telefono spegneva il tethering dopo una decina di secondi - ma in quella
 * stessa occasione anche lo stack USB del telefono era bloccato, e a risolvere
 * e' stato un suo riavvio. Non si sa quindi se il limite serva davvero: sta qui
 * come cosa da provare quando il sintomo torna, non come regola.
 *
 * La scrittura passa da uci; l'effetto sull'hardware da `travel.usb_mode`,
 * perche' spegnere una porta del root hub non lo fa `uci apply`. Stesso schema
 * di mwan3.
 */
export async function setUsbMode(forceUsb2: boolean): Promise<string> {
  await call('uci', 'set', {
    config: 'travel',
    section: 'usb',
    values: { force_usb2: forceUsb2 ? '1' : '0' },
  });
  await call('uci', 'apply', {});

  const result = await call<{ applied?: boolean; mode?: string; error?: string }>(
    'travel',
    'usb_mode',
    {},
    25_000,
  );
  if (result.error) throw new Error(result.error);
  return result.mode ?? '';
}

/**
 * Riavvia il controller USB senza riavviare il router.
 *
 * Serve quando il driver dell'hub si arrende e disabilita la porta: da quel
 * momento il telefono non viene piu' visto, e senza questo l'unica via sarebbe
 * spegnere il router.
 *
 * Stacca per qualche secondo qualunque periferica USB collegata, quindi resta
 * un comando esplicito e non un automatismo.
 */
export async function resetUsb(): Promise<{ controller: string; mode: string }> {
  const result = await call<{
    reset?: boolean;
    controller?: string;
    /** usb2 = SuperSpeed spenta, usb3 = accesa, unsupported = kernel senza controllo. */
    mode?: string;
    error?: string;
  }>('travel', 'usb_reset', {}, 25_000);
  if (result.error) throw new Error(result.error);
  return { controller: result.controller ?? '', mode: result.mode ?? '' };
}
