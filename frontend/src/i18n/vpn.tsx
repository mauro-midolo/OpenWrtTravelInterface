import { defineText } from '.';

/** La scheda VPN (`screens/Vpn.tsx`) e i testi di `lib/vpn.ts`. */
export const vpnText = defineText({
  it: {
    lib: {
      never: 'mai',
      secondsAgo: (n: number) => `${n} s fa`,
      minutesAgo: (n: number) => `${n} min fa`,
      hoursAgo: (n: number) => `${n} h fa`,
      endpointV6: 'sembra un indirizzo IPv6 incompleto: la porta va nel campo accanto',
      endpointBad: 'non è un nome di host né un indirizzo',
      steps: {
        device: (name: string) => `Interfaccia del tunnel (${name})`,
        deviceFix: 'l’interfaccia non esiste: netifd non l’ha alzata',
        route: 'Rotta dentro il tunnel (tabella 53)',
        routeFix: 'manca la rotta nella tabella del tunnel',
        rule: 'Regola che ci manda il traffico (pref 901)',
        ruleFix:
          'manca la regola di instradamento — da SSH: sh /usr/share/travel/vpn-setup.sh runtime',
        zone: 'Nella zona firewall del tunnel',
        zoneFix: 'l’interfaccia non è nella zona vpn: reimporta la configurazione',
        route6: 'Rotta IPv6 dentro il tunnel (tabella 53)',
        route6Fix: 'manca la rotta IPv6: il traffico IPv6 esce dalla WAN in chiaro',
        rule6: 'Regola IPv6 che ci manda il traffico (pref 901)',
        rule6Fix: 'manca la regola IPv6 — da SSH: sh /usr/share/travel/vpn-setup.sh runtime',
      },
      tsState: {
        Running: 'connesso',
        Starting: 'in avvio',
        Stopped: 'disconnesso',
        NeedsLogin: 'serve l’accesso',
        NeedsMachineAuth: 'in attesa di approvazione',
        NoState: 'non avviato',
      } as Record<string, string>,
      unknown: 'sconosciuto',
      none: 'nessuno',
      policy: {
        balance:
          'il multi-WAN è in bilanciamento: sparpaglia le connessioni su più WAN, e un tunnel non si può sparpagliare',
        ts_exit: 'un exit node Tailscale sta già portando fuori tutto il traffico',
        wireguard: (name: string) =>
          name
            ? `il tunnel WireGuard "${name}" sta già portando fuori tutto il traffico`
            : 'un tunnel WireGuard sta già portando fuori tutto il traffico',
      },
    },
    online: 'in linea',
    offline: 'non in linea',
    exitBadge: 'uscita',
    check: {
      iface: 'Interfaccia del tunnel (tailscale0)',
      ifaceFix: 'Non c’è: tailscaled non l’ha creata. Riprova l’accesso.',
      forward: 'Inoltro IP del kernel',
      forwardFix: (raw: string) =>
        `Spento${raw ? ` (vale "${raw}")` : ''}. Da SSH: sh /usr/share/travel/vpn-setup.sh forwarding`,
      ifaceForward: 'Inoltro sull’interfaccia del tunnel',
      ifaceForwardFix:
        'Spento su tailscale0: è quello che conta, perché il pacchetto entra da lì. Salva di nuovo le impostazioni Tailscale — lo riscrive.',
      fwOut: 'Inoltro del firewall verso la WAN',
      fwOutFix:
        'La sezione travel_vpn_out è spenta. Salva di nuovo le impostazioni Tailscale con l’annuncio attivo.',
      fwLoaded: 'Regole fw4 caricate per tailscale0',
      fwLoadedFix:
        'Il firewall in esecuzione non conosce il tunnel. Da SSH: /etc/init.d/firewall reload',
      route: 'Rotta verso il tailnet (100.64.0.0/10 via tailscale0)',
      routeFix:
        'Manca: senza, il router non raggiunge nessun peer e le risposte non hanno da dove rientrare nel tunnel. Salva di nuovo le impostazioni Tailscale, o da SSH: sh /usr/share/travel/vpn-setup.sh runtime',
      routeRule: 'Risposte instradate nel tunnel (sopra mwan3)',
      routeRuleFix:
        'Manca la regola di instradamento: mwan3 manda le risposte ai nodi del tailnet fuori dalla WAN. Salva di nuovo le impostazioni Tailscale, o da SSH: sh /usr/share/travel/vpn-setup.sh runtime',
      approved: 'Autorizzato dal tailnet',
      approvedFix: 'Va approvato dalla console di Tailscale, fra le rotte del nodo.',
      wgFw: 'Uscita del tailnet dentro WireGuard',
      wgFwFix:
        'La sezione travel_vpn_wg è spenta: il pacchetto viene instradato nel tunnel e lì il firewall lo rifiuta, perché i due tunnel stanno nella stessa zona. Salva di nuovo le impostazioni Tailscale con l’annuncio attivo.',
      wgFwLoaded: 'Regola fw4 caricata (travel-exit-via-wg)',
      wgFwLoadedFix:
        'Scritta in uci ma assente dal firewall in esecuzione. Da SSH: /etc/init.d/firewall reload, e se non compare nemmeno così è fw4 che scarta la regola — allora serve un’altra strada.',
      wgRule: 'Traffico instradato in WireGuard (pref 901)',
      wgRuleFix:
        'Manca la regola: il traffico esce lo stesso, ma dalla WAN — l’indirizzo finale sarebbe quello di qui, non quello della VPN. Da SSH: sh /usr/share/travel/vpn-setup.sh runtime',
      title: 'Uscita per gli altri',
      ok: 'a posto',
      missing: 'manca',
      working: (viaWg: boolean) =>
        `Uscita per gli altri funzionante${viaWg ? ', dentro WireGuard' : ''}.`,
      wgDrops:
        'Se WireGuard cade, chi ti usa come uscita esce in chiaro: il kill switch non lo blocca.',
      broken: (n: number) => (n === 1 ? 'Manca un anello' : `Mancano ${n} anelli`),
    },
    authorize: 'Autorizza il router',
    starting: 'Avvio…',
    signIn: 'Accedi',
    haveKey: 'Ho una auth key',
    authKey: 'Auth key',
    linking: 'Collego…',
    linkWithKey: 'Collega con la chiave',
    startingTs: 'Avvio Tailscale…',
    settingsTitle: 'Impostazioni Tailscale',
    exitBlocked: (reason: string) => `L'exit node non è selezionabile: ${reason}.`,
    exitNode: 'Exit node',
    none: 'Nessuno',
    chosen: 'scelto',
    offlineSuffix: ' · non in linea',
    noExitNodes: 'Nessun exit node disponibile nel tailnet.',
    offerExit: 'Offri questo router come exit node',
    approveInConsole: (
      <>
        Va <strong>autorizzato dalla console di Tailscale</strong>.
      </>
    ),
    acceptRoutes: 'Accetta le rotte annunciate dagli altri nodi',
    acceptDns: 'Usa il DNS del tailnet (MagicDNS)',
    advertiseLan: 'Annuncia la LAN del router',
    applying: 'Applico…',
    ksOnTitle: 'Accendi il kill switch',
    ksOffTitle: 'Spegni il kill switch',
    ksOnWarn:
      'I dispositivi collegati usciranno solo dentro il tunnel: se cade, restano senza Internet.',
    ksOffWarn: 'I dispositivi potranno uscire anche senza tunnel.',
    title: 'VPN',
    loading: 'Caricamento…',
    noAnswer: 'Il router non ha risposto.',
    notInstalled: 'non installato',
    viaTunnel: 'esce dal tunnel',
    exitForOthers: 'uscita per gli altri',
    missingPackage: (
      <>
        Il pacchetto <code>tailscale</code> non è installato.
      </>
    ),
    tunnelOff: (name: string) =>
      name ? (
        <>
          Tunnel spento · <strong>{name}</strong>.
        </>
      ) : (
        <>Tunnel spento.</>
      ),
    needsMachineAuth: 'Il nodo va autorizzato dalla console di Tailscale.',
    tailnetName: 'Nome nel tailnet',
    address: 'Indirizzo',
    notActive: ' · non attivo',
    noneLower: 'nessuno',
    offered: 'Offerto come uscita',
    no: 'no',
    yesApproved: 'sì, autorizzato',
    yesPending: 'sì, da autorizzare',
    version: 'Versione',
    exitNeedsApproval: (
      <>
        L'exit node va <strong>approvato dalla console di Tailscale</strong>.
      </>
    ),
    noBoot: 'Il servizio non è abilitato all’avvio: dopo un riavvio la VPN non torna su da sola.',
    exitUnused: (name: string) => (
      <>
        L'exit node <strong>{name}</strong> è impostato ma non è in uso.
      </>
    ),
    settings: 'Impostazioni',
    disconnect: 'Disconnetti',
    turningOn: 'Accendo…',
    turnOn: 'Accendi',
    turnOff: 'Spegni',
    signOut: 'Esci dall’account',
    devices: 'Dispositivi',
    noDevices: 'Nessun altro dispositivo nel tailnet.',
    ks: 'Kill switch',
    ksOff: 'spento',
    ksSuspended: (minutes: number) => `sospeso, si riarma fra ${minutes} min`,
    ksOn: 'attivo',
    ksBlocks: 'blocca',
    ksMissing: 'La regola di firewall del kill switch non c’è.',
    ksNoTunnel: (
      <>
        <strong>Nessun tunnel porta il traffico</strong>: i client sono senza Internet. Scegli un
        exit node Tailscale oppure accendi WireGuard.
      </>
    ),
    ksSuspendedWarn: (minutes: number) => (
      <>
        Sospeso: il traffico esce in chiaro. Si riarma da solo fra <strong>{minutes} min</strong>.
      </>
    ),
    suspend: (minutes: number) => `Sospendi ${minutes} min`,
    resume: 'Riarma adesso',
  },
  en: {
    lib: {
      never: 'never',
      secondsAgo: (n: number) => `${n} s ago`,
      minutesAgo: (n: number) => `${n} min ago`,
      hoursAgo: (n: number) => `${n} h ago`,
      endpointV6: 'looks like an incomplete IPv6 address: the port goes in the field next to it',
      endpointBad: 'is neither a host name nor an address',
      steps: {
        device: (name: string) => `Tunnel interface (${name})`,
        deviceFix: 'the interface does not exist: netifd did not bring it up',
        route: 'Route inside the tunnel (table 53)',
        routeFix: 'the route in the tunnel table is missing',
        rule: 'Rule sending traffic there (pref 901)',
        ruleFix: 'the routing rule is missing — over SSH: sh /usr/share/travel/vpn-setup.sh runtime',
        zone: 'In the tunnel firewall zone',
        zoneFix: 'the interface is not in the vpn zone: import the configuration again',
        route6: 'IPv6 route inside the tunnel (table 53)',
        route6Fix: 'the IPv6 route is missing: IPv6 traffic leaves through the WAN unencrypted',
        rule6: 'IPv6 rule sending traffic there (pref 901)',
        rule6Fix: 'the IPv6 rule is missing — over SSH: sh /usr/share/travel/vpn-setup.sh runtime',
      },
      tsState: {
        Running: 'connected',
        Starting: 'starting',
        Stopped: 'disconnected',
        NeedsLogin: 'sign-in needed',
        NeedsMachineAuth: 'waiting for approval',
        NoState: 'not started',
      },
      unknown: 'unknown',
      none: 'none',
      policy: {
        balance:
          'multi-WAN is load balancing: it spreads connections over several WANs, and a tunnel cannot be spread',
        ts_exit: 'a Tailscale exit node is already carrying all traffic',
        wireguard: (name: string) =>
          name
            ? `the WireGuard tunnel "${name}" is already carrying all traffic`
            : 'a WireGuard tunnel is already carrying all traffic',
      },
    },
    online: 'online',
    offline: 'offline',
    exitBadge: 'exit',
    check: {
      iface: 'Tunnel interface (tailscale0)',
      ifaceFix: 'Missing: tailscaled did not create it. Try signing in again.',
      forward: 'Kernel IP forwarding',
      forwardFix: (raw: string) =>
        `Off${raw ? ` (value "${raw}")` : ''}. Over SSH: sh /usr/share/travel/vpn-setup.sh forwarding`,
      ifaceForward: 'Forwarding on the tunnel interface',
      ifaceForwardFix:
        'Off on tailscale0: that is the one that matters, because packets come in there. Save the Tailscale settings again — it rewrites it.',
      fwOut: 'Firewall forwarding to the WAN',
      fwOutFix:
        'The travel_vpn_out section is off. Save the Tailscale settings again with advertising on.',
      fwLoaded: 'fw4 rules loaded for tailscale0',
      fwLoadedFix:
        'The running firewall does not know the tunnel. Over SSH: /etc/init.d/firewall reload',
      route: 'Route to the tailnet (100.64.0.0/10 via tailscale0)',
      routeFix:
        'Missing: without it the router reaches no peer and replies have no way back into the tunnel. Save the Tailscale settings again, or over SSH: sh /usr/share/travel/vpn-setup.sh runtime',
      routeRule: 'Replies routed into the tunnel (above mwan3)',
      routeRuleFix:
        'The routing rule is missing: mwan3 sends replies to tailnet nodes out through the WAN. Save the Tailscale settings again, or over SSH: sh /usr/share/travel/vpn-setup.sh runtime',
      approved: 'Approved by the tailnet',
      approvedFix: 'It must be approved from the Tailscale console, among the node’s routes.',
      wgFw: 'Tailnet exit inside WireGuard',
      wgFwFix:
        'The travel_vpn_wg section is off: packets are routed into the tunnel and the firewall rejects them there, because both tunnels are in the same zone. Save the Tailscale settings again with advertising on.',
      wgFwLoaded: 'fw4 rule loaded (travel-exit-via-wg)',
      wgFwLoadedFix:
        'Written in uci but missing from the running firewall. Over SSH: /etc/init.d/firewall reload, and if it still does not show up, fw4 is dropping the rule — then another way is needed.',
      wgRule: 'Traffic routed into WireGuard (pref 901)',
      wgRuleFix:
        'The rule is missing: traffic still goes out, but through the WAN — the final address would be the local one, not the VPN’s. Over SSH: sh /usr/share/travel/vpn-setup.sh runtime',
      title: 'Exit for others',
      ok: 'fine',
      missing: 'missing',
      working: (viaWg: boolean) => `Exit for others working${viaWg ? ', inside WireGuard' : ''}.`,
      wgDrops:
        'If WireGuard drops, whoever uses you as an exit goes out unencrypted: the kill switch does not block it.',
      broken: (n: number) => (n === 1 ? 'One link is missing' : `${n} links are missing`),
    },
    authorize: 'Authorize the router',
    starting: 'Starting…',
    signIn: 'Sign in',
    haveKey: 'I have an auth key',
    authKey: 'Auth key',
    linking: 'Connecting…',
    linkWithKey: 'Connect with the key',
    startingTs: 'Starting Tailscale…',
    settingsTitle: 'Tailscale settings',
    exitBlocked: (reason: string) => `The exit node cannot be selected: ${reason}.`,
    exitNode: 'Exit node',
    none: 'None',
    chosen: 'chosen',
    offlineSuffix: ' · offline',
    noExitNodes: 'No exit node available in the tailnet.',
    offerExit: 'Offer this router as an exit node',
    approveInConsole: (
      <>
        It must be <strong>approved from the Tailscale console</strong>.
      </>
    ),
    acceptRoutes: 'Accept routes announced by other nodes',
    acceptDns: 'Use the tailnet DNS (MagicDNS)',
    advertiseLan: 'Announce the router’s LAN',
    applying: 'Applying…',
    ksOnTitle: 'Turn on the kill switch',
    ksOffTitle: 'Turn off the kill switch',
    ksOnWarn:
      'Connected devices will only go out through the tunnel: if it drops, they are left without Internet.',
    ksOffWarn: 'Devices will be able to go out without a tunnel too.',
    title: 'VPN',
    loading: 'Loading…',
    noAnswer: 'The router did not answer.',
    notInstalled: 'not installed',
    viaTunnel: 'goes out via tunnel',
    exitForOthers: 'exit for others',
    missingPackage: (
      <>
        The <code>tailscale</code> package is not installed.
      </>
    ),
    tunnelOff: (name: string) =>
      name ? (
        <>
          Tunnel off · <strong>{name}</strong>.
        </>
      ) : (
        <>Tunnel off.</>
      ),
    needsMachineAuth: 'The node must be approved from the Tailscale console.',
    tailnetName: 'Name in the tailnet',
    address: 'Address',
    notActive: ' · not active',
    noneLower: 'none',
    offered: 'Offered as exit',
    no: 'no',
    yesApproved: 'yes, approved',
    yesPending: 'yes, to be approved',
    version: 'Version',
    exitNeedsApproval: (
      <>
        The exit node must be <strong>approved from the Tailscale console</strong>.
      </>
    ),
    noBoot: 'The service is not enabled at boot: after a reboot the VPN will not come back by itself.',
    exitUnused: (name: string) => (
      <>
        The exit node <strong>{name}</strong> is set but not in use.
      </>
    ),
    settings: 'Settings',
    disconnect: 'Disconnect',
    turningOn: 'Turning on…',
    turnOn: 'Turn on',
    turnOff: 'Turn off',
    signOut: 'Sign out of the account',
    devices: 'Devices',
    noDevices: 'No other device in the tailnet.',
    ks: 'Kill switch',
    ksOff: 'off',
    ksSuspended: (minutes: number) => `paused, re-arms in ${minutes} min`,
    ksOn: 'on',
    ksBlocks: 'blocking',
    ksMissing: 'The kill switch firewall rule is missing.',
    ksNoTunnel: (
      <>
        <strong>No tunnel is carrying traffic</strong>: clients have no Internet. Choose a
        Tailscale exit node or turn on WireGuard.
      </>
    ),
    ksSuspendedWarn: (minutes: number) => (
      <>
        Paused: traffic goes out unencrypted. It re-arms by itself in <strong>{minutes} min</strong>.
      </>
    ),
    suspend: (minutes: number) => `Pause ${minutes} min`,
    resume: 'Re-arm now',
  },
});
