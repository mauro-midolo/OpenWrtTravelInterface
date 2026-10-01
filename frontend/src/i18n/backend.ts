import { getLang } from '.';
import { vpnText } from './vpn';

/**
 * Gli errori che arrivano dal router (rpcd `travel`, helper shell, traveld).
 *
 * Il router manda la frase in italiano e, accanto, un codice stabile con i
 * suoi parametri (`error_code`, `error_params`). In italiano si mostra la
 * frase del router, che e' gia' quella giusta; nelle altre lingue si
 * ricompone dal codice. Un codice che qui non c'e' - un router piu' nuovo di
 * questa interfaccia - ricade sulla frase originale: meglio in italiano che
 * niente.
 */

export type BackendParams = Record<string, string | number | null | undefined>;

const str = (value: BackendParams[string]) => (value == null ? '' : String(value));

/** Chi blocca un'opzione, nella frase inglese: la stessa di `blockReason`. */
function policy(p: BackendParams): string {
  const t = vpnText().lib.policy;
  if (p.holder === 'balance') return t.balance;
  if (p.holder === 'ts_exit') return t.ts_exit;
  if (p.holder === 'wireguard') return t.wireguard(str(p.name));
  return str(p.holder);
}

const EN: Record<string, (p: BackendParams) => string> = {
  // LED e interruttore fisico
  led_read_failed: () => 'Could not read the LED state.',
  led_bad_request: () => 'Invalid LED request.',
  led_bad_enabled: () => 'enabled must be a boolean.',
  led_bad_name: () => 'Invalid LED name.',
  led_unavailable: () => 'Status LED not available on this router.',
  led_bad_config: () => 'Invalid LED configuration.',
  led_bad_state: () => 'Invalid LED state.',
  led_busy: () => 'The LED is being changed. Try again.',
  led_apply_failed: () => 'Could not apply the LED state.',
  led_save_failed: () => 'Could not save the LED state.',
  toggle_bad_config: () => 'Invalid switch configuration.',
  toggle_bad_request: () => 'Invalid switch request.',
  toggle_bad_action_type: () => 'action must be a string.',
  toggle_bad_band: () => 'Invalid band.',
  toggle_ap_unavailable: () => 'Access point not available.',
  toggle_wg_unavailable: () => 'WireGuard not available.',
  toggle_bad_action: () => 'Invalid action.',
  toggle_busy: () => 'A change is in progress. Try again.',
  toggle_save_failed: () => 'Could not save the choice.',
  toggle_moved: () =>
    'Function saved: the switch moved, it will realign at the next movement.',
  toggle_not_restored: () => 'Choice not applied and not restored.',
  toggle_apply_failed: () => 'Could not apply the chosen function.',
  toggle_bad_position: () => 'Invalid position.',
  toggle_deferred: () => 'A change is in progress: whoever holds the turn will apply it.',
  toggle_unstable: () => 'The switch keeps moving: alignment interrupted.',
  toggle_align_skipped: () => 'A change is in progress: alignment skipped.',
  // Access point
  ap_bad_state: () => 'invalid access point state',
  ap_none: (p) => `no access point configured on the ${str(p.band)} GHz band`,
  ap_open: (p) =>
    `the access point ${str(p.section)} on the ${str(p.band)} GHz band has no password: not turning it on. Configure it with tools/setup-ap.sh`,
  // WiFi e reti salvate
  unknown_radio: () => 'unknown radio',
  unknown_saved: () => 'unknown saved network',
  missing_session: () => 'missing session',
  connect_prepare_failed: () => 'could not prepare the connection',
  scan_no_phy: () => 'no wireless phy found',
  scan_temp_failed: (p) => `could not create the temporary interface on ${str(p.phy)}`,
  scan_empty: (p) =>
    p.radio ? `scan of ${str(p.radio)} returned no results` : 'the scan returned no results',
  // USB, multi-WAN, portali
  usb_no_xhci: () => 'no USB controller bound to an xhci driver',
  mwan_missing: () => 'mwan3 is not installed',
  balance_blocked: (p) => `cannot switch to load balancing: ${policy(p)}`,
  unknown_wan: () => 'unknown WAN',
  unknown_entry: () => 'unknown entry',
  probe_failed: () => 'probe failed',
  // Tailscale
  tailscale_missing: () => 'tailscale is not installed',
  tailscaled_not_started: () => 'tailscaled did not start: check logread | grep tailscale',
  tailscaled_not_running: () => 'tailscaled is not running',
  exit_node_blocked: (p) => `cannot use an exit node: ${policy(p)}`,
  // WireGuard
  wg_empty_config: () => 'empty configuration',
  wg_unknown: () => 'unknown WireGuard configuration',
  wg_too_many: () => 'too many saved WireGuard configurations',
  wg_name_taken: () => 'a WireGuard configuration with this name already exists',
  wg_delete_active: () => 'it is the active configuration: deactivate it before deleting it',
  wg_not_installed: () => 'wireguard-tools is not installed',
  wg_none_active: () => 'no active WireGuard configuration',
  wg_by_toggle: (p) =>
    `the physical switch controls it: "${str(p.name)}" follows the switch. Change the switch function to decide from here again`,
  wg_busy: (p) =>
    `the configuration "${str(p.name)}" is already active: deactivate it before activating another one`,
  wg_blocked: (p) => `cannot turn on WireGuard: ${policy(p)}`,
  wg_bad_name: () => 'invalid name: letters, digits, spaces, dot, - and _, up to 32 characters',
  wg_no_private_key: () => 'the private key is missing (PrivateKey in the [Interface] section)',
  wg_bad_private_key: () => 'the private key is not a valid WireGuard key',
  wg_no_peer_key: () => 'the peer public key is missing (PublicKey in the [Peer] section)',
  wg_bad_peer_key: () => 'the peer public key is not a valid WireGuard key',
  wg_bad_preshared: () => 'the preshared key is not a valid WireGuard key',
  wg_no_address: () => 'the interface addresses are missing (Address in the [Interface] section)',
  wg_bad_address: () => 'the interface addresses are malformed',
  wg_no_allowed: () => 'what to route into the tunnel is missing (AllowedIPs in the [Peer] section)',
  wg_bad_allowed: () => 'malformed AllowedIPs',
  wg_bad_dns: () => 'the DNS entries are not valid addresses',
  wg_no_endpoint: () => 'the peer endpoint is missing (Endpoint in the [Peer] section)',
  wg_bad_endpoint: () => 'the peer endpoint is neither a valid name nor a valid address',
  wg_bad_port: () => 'the endpoint port is not valid',
  wg_bad_mtu: () => 'MTU out of range (576-9200)',
  wg_bad_keepalive: () => 'keepalive out of range',
  // Profili
  profile_bad_name: () => 'invalid name: letters, digits, spaces, - and _, up to 24 characters',
  profile_unknown: () => 'unknown profile',
  profile_balance_blocked: (p) => `the profile asked for load balancing: ${policy(p)}`,
  // Backup e ripristino
  backup_no_ucode: () => 'ucode is missing: download the backup from LuCI',
  backup_failed: () => 'creating the backup failed',
  backup_unreadable: () => 'backup not readable',
  backup_too_big: (p) => `backup too large (${str(p.kb)} KB): download it from LuCI`,
  backup_encode_failed: () => 'encoding the backup failed',
  restore_no_ucode: () => 'ucode is missing: restore the backup from LuCI',
  chunk_empty: () => 'empty chunk',
  chunk_not_base64: () => 'the chunk is not base64',
  chunk_misaligned: () => 'misaligned chunk: it must be a multiple of 4 characters',
  chunk_decode_failed: () => 'decoding the chunk failed',
  archive_unreadable: () => 'the archive does not open: incomplete upload or wrong file',
  archive_not_openwrt: () => 'this archive does not contain /etc/config: it is not an OpenWrt backup',
  restore_failed: () => 'restore failed',
  // Ora e riavvio
  system_section_missing: () => 'system section not found',
  timezone_invalid: () => 'invalid time zone',
  zonename_invalid: () => 'invalid time zone name',
  ntp_server_invalid: (p) => `invalid NTP server: ${str(p.server)}`,
  ntp_too_many: () => 'too many servers: eight are enough',
  ntp_none: () => 'at least one NTP server is needed',
  hour_invalid: () => 'invalid hour',
  minute_invalid: () => 'invalid minute',
  weekday_invalid: () => 'invalid day',
  // traveld
  config_read_failed: (p) => `reading /etc/config/travel failed: ${str(p.error)}`,
  saved_read_failed: (p) => `reading the saved networks failed: ${str(p.error)}`,
  ubus_call_failed: (p) => `call ${str(p.call)} failed: ${str(p.error)}`,
  hostname_write_failed: (p) => `writing the DHCP name failed: ${str(p.error)}`,
  wireless_write_failed: (p) => `writing /etc/config/wireless failed: ${str(p.error)}`,
  vpn_read_failed: (p) => `reading the VPN settings failed: ${str(p.error)}`,
  killswitch_failed: (p) => `re-arming the kill switch failed: ${str(p.error)}`,
  sample_failed: (p) => `sampling failed: ${str(p.error)}`,
  portal_loop_failed: (p) => `portal check interrupted: ${str(p.error)}`,
  killswitch_check_failed: (p) => `kill switch check interrupted: ${str(p.error)}`,
  loop_failed: (p) => `control loop interrupted: ${str(p.error)}`,
};

/** La frase di un errore del router, nella lingua dell'interfaccia. */
export function backendMessage(message: string, code?: string, params?: BackendParams): string {
  if (!code || getLang() === 'it') return message;
  const format = EN[code];
  return format ? format(params ?? {}) : message;
}

/** I codici noti: servono ai test per controllare che il router non ne usi di sconosciuti. */
export const BACKEND_CODES: readonly string[] = Object.keys(EN);
