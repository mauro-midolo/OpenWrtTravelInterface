import { defineText } from '.';

/** WireGuard (`screens/WireGuard.tsx`). */
export const wgText = defineText({
  it: {
    noEndpoint: 'senza endpoint',
    name: 'Nome',
    namePlaceholder: 'es. casa, ufficio, provider svizzero',
    addresses: 'Indirizzi dell’interfaccia',
    peerKey: 'Chiave pubblica del peer',
    peerKeyPlaceholder: 'PublicKey del [Peer]',
    endpoint: 'Endpoint',
    port: 'Porta',
    allowedIps: 'Instradato nel tunnel',
    dns: 'DNS',
    dnsPlaceholder: 'vuoto per non cambiarli',
    mtu: 'MTU',
    mtuPlaceholder: 'vuoto per il valore automatico',
    keepalive: 'Keepalive (secondi)',
    privateKey: 'Chiave privata',
    keepKey: 'lascia vuoto per non cambiarla',
    required: 'obbligatoria',
    missingKey: 'Manca: senza, il tunnel non può salire.',
    presharedKey: 'Chiave precondivisa',
    optional: 'facoltativa',
    dropPreshared: 'Togli la chiave precondivisa',
    reimportTitle: (name: string) => `Reimporta «${name}»`,
    newConfig: 'Nuova configurazione',
    paste: 'Incolla il file .conf del provider',
    importing: 'Importo…',
    replace: 'Sostituisci',
    activate: 'Attiva',
    deactivate: 'Disattiva',
    toggleTitle: (on: boolean, name: string) => `${on ? 'Attiva' : 'Disattiva'} «${name}»`,
    onWarn: 'Tutto il traffico dei client uscirà da questo tunnel.',
    offWarn: 'Il traffico tornerà a uscire direttamente dalla rete a cui sei collegato.',
    applying: 'Applico…',
    isActive: 'È la configurazione attiva.',
    unnamed: 'Questa configurazione non ha un nome: dagliene uno da Modifica.',
    deactivateFirst: (name: string) => `Per attivare questa devi prima disattivare «${name}».`,
    blocked: (reason: string) => `Non si può attivare WireGuard adesso: ${reason}.`,
    followsSwitch: 'Questa configurazione segue l’interruttore fisico.',
    switchControls: (name: string) => `L’interruttore fisico comanda «${name}».`,
    aConfig: 'una configurazione',
    edit: 'Modifica',
    reimport: 'Reimporta',
    remove: 'Elimina',
    deactivateToDelete: 'Per eliminarla, disattivala prima.',
    activeSaveWarn: 'Configurazione attiva: salvando, il traffico si interrompe per qualche secondo.',
    saving: 'Salvo…',
    confirmDelete: (name: string) => `Elimini «${name}» e la sua chiave privata?`,
    deleting: 'Elimino…',
    notInstalled: 'non installato',
    noneSaved: 'nessuna configurazione salvata',
    active: 'attiva',
    activeNoTraffic: 'attiva, ma il traffico non ci entra',
    activeNoPeer: 'attiva, ma il peer non risponde',
    noneActive: (n: number) => `nessuna attiva · ${n} salvat${n === 1 ? 'a' : 'e'}`,
    carries: 'porta il traffico',
    missingPackage: (
      <>
        Il pacchetto <code>wireguard-tools</code> non è installato.
      </>
    ),
    lockedBy: (name: string) => (
      <>
        <strong>{name}</strong> segue l’interruttore fisico.
      </>
    ),
    noConfigs: 'Nessuna configurazione.',
    lastHandshake: 'Ultimo handshake',
    traffic: 'Traffico',
    entersTunnel: 'Il traffico entra nel tunnel?',
    ok: 'a posto',
    missing: 'manca',
    notEntering: (fixes: string) => (
      <>
        Il tunnel è su ma <strong>il traffico dei client non ci entra</strong>: {fixes}
      </>
    ),
    staleHandshake: (
      <>
        Il tunnel è acceso ma <strong>l'ultimo handshake non è recente</strong>: il peer non sta
        rispondendo.
      </>
    ),
    add: 'Aggiungi configurazione',
  },
  en: {
    noEndpoint: 'no endpoint',
    name: 'Name',
    namePlaceholder: 'e.g. home, office, Swiss provider',
    addresses: 'Interface addresses',
    peerKey: 'Peer public key',
    peerKeyPlaceholder: 'PublicKey of the [Peer]',
    endpoint: 'Endpoint',
    port: 'Port',
    allowedIps: 'Routed into the tunnel',
    dns: 'DNS',
    dnsPlaceholder: 'empty to leave them unchanged',
    mtu: 'MTU',
    mtuPlaceholder: 'empty for the automatic value',
    keepalive: 'Keepalive (seconds)',
    privateKey: 'Private key',
    keepKey: 'leave empty to keep it',
    required: 'required',
    missingKey: 'Missing: without it the tunnel cannot come up.',
    presharedKey: 'Preshared key',
    optional: 'optional',
    dropPreshared: 'Remove the preshared key',
    reimportTitle: (name: string) => `Re-import «${name}»`,
    newConfig: 'New configuration',
    paste: 'Paste the provider’s .conf file',
    importing: 'Importing…',
    replace: 'Replace',
    activate: 'Activate',
    deactivate: 'Deactivate',
    toggleTitle: (on: boolean, name: string) => `${on ? 'Activate' : 'Deactivate'} «${name}»`,
    onWarn: 'All client traffic will go out through this tunnel.',
    offWarn: 'Traffic will go back to leaving directly through the network you are connected to.',
    applying: 'Applying…',
    isActive: 'This is the active configuration.',
    unnamed: 'This configuration has no name: give it one from Edit.',
    deactivateFirst: (name: string) => `To activate this one, deactivate «${name}» first.`,
    blocked: (reason: string) => `WireGuard cannot be activated now: ${reason}.`,
    followsSwitch: 'This configuration follows the physical switch.',
    switchControls: (name: string) => `The physical switch controls «${name}».`,
    aConfig: 'a configuration',
    edit: 'Edit',
    reimport: 'Re-import',
    remove: 'Delete',
    deactivateToDelete: 'To delete it, deactivate it first.',
    activeSaveWarn: 'Active configuration: saving interrupts traffic for a few seconds.',
    saving: 'Saving…',
    confirmDelete: (name: string) => `Delete «${name}» and its private key?`,
    deleting: 'Deleting…',
    notInstalled: 'not installed',
    noneSaved: 'no saved configuration',
    active: 'active',
    activeNoTraffic: 'active, but traffic is not entering it',
    activeNoPeer: 'active, but the peer is not responding',
    noneActive: (n: number) => `none active · ${n} saved`,
    carries: 'carries traffic',
    missingPackage: (
      <>
        The <code>wireguard-tools</code> package is not installed.
      </>
    ),
    lockedBy: (name: string) => (
      <>
        <strong>{name}</strong> follows the physical switch.
      </>
    ),
    noConfigs: 'No configurations.',
    lastHandshake: 'Last handshake',
    traffic: 'Traffic',
    entersTunnel: 'Does traffic enter the tunnel?',
    ok: 'fine',
    missing: 'missing',
    notEntering: (fixes: string) => (
      <>
        The tunnel is up but <strong>client traffic is not entering it</strong>: {fixes}
      </>
    ),
    staleHandshake: (
      <>
        The tunnel is on but <strong>the last handshake is not recent</strong>: the peer is not
        responding.
      </>
    ),
    add: 'Add configuration',
  },
});
