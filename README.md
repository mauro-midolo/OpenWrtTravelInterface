# Travel Router UI

**English** · [Italiano](README-it.md)

[![Version: 1.11.0](https://img.shields.io/badge/version-1.11.0-blue)](package/travel/files/usr/share/travel/version)
[![Reference OpenWrt: 25.12](https://img.shields.io/badge/OpenWrt-25.12-00B5E2)](docs/architettura.md)
[![Device: GL-MT3600BE](https://img.shields.io/badge/device-GL--MT3600BE-green)](#reference-device-and-firmware)
[![UI: English · Italiano](https://img.shields.io/badge/UI-English%20%C2%B7%20Italiano-lightgrey)](#languages)

**Travel router management, designed for a phone screen.**

Travel Router UI is a web interface for the **GL.iNet Beryl 7 (GL-MT3600BE)**
running **vanilla OpenWrt 25.12**. It brings WiFi connections, Internet access,
the local network and VPNs together in a single panel you can use from the
browser, even when the Internet connection is down.

## Why it exists

When you travel, the network you connect to keeps changing: the hotel WiFi
wants a login in the browser, a connection drops, your phone becomes an
emergency WAN. Handling all this from a smartphone can mean going through many
configuration pages and working out which settings depend on which.

The project aims to make the most frequent tasks simple: connecting the router
to whatever network is available, keeping a personal network for your own
devices, understanding why the Internet is not reachable and choosing how
traffic is routed. The interface is designed for one-handed use, with
information and actions grouped by task.

Every application file is served by the router itself: the local configuration
stays reachable without Internet, as long as the phone can reach the router.
LuCI remains available for advanced configuration.

## Reference device and firmware

| Item | Specification |
|---|---|
| Device | GL.iNet Beryl 7, model **GL-MT3600BE** |
| CPU | Quad-core MediaTek, 2.0 GHz |
| Memory | 512 MB DDR4 |
| Storage | 512 MB NAND flash |
| WiFi | Dual-band WiFi 7, 2.4 and 5 GHz |
| Ethernet | Two 2.5 Gb/s ports, WAN and LAN |
| USB | One USB 3.0 port for peripherals and compatible tethering |
| Power | USB-C |
| Reference firmware | **Vanilla OpenWrt 25.12** |
| Interface/plugin version | **1.11.0** |

Hardware specifications come from the
[official GL.iNet product page](https://www.gl-inet.com/products/gl-mt3600be/).
The radio features actually available depend on the installed firmware and
drivers.

The software base listed here is the reference environment documented in the
repository. The project is installed on top of an OpenWrt system already on the
device; it does not ship a firmware image. Compatibility with the stock GL.iNet
firmware, other routers or other OpenWrt versions has not been verified. The
install scripts use `apk`.

The version badge follows the
[version file shipped to the router](package/travel/files/usr/share/travel/version).
The repository targets the OpenWrt **25.12** series without pinning a specific
patch release or firmware build.

## What it can do

| Area | Features |
|---|---|
| **WiFi** | Scan for and join networks — a saved one reopens from the scan with its configuration, without typing the password again —, add a hidden network by hand, turn on auto-reconnect, manage the access points and choose MAC address and DHCP hostname. Saved networks have their own page: a single list where each network shows which bands it applies to — 2.4 GHz, 5 GHz or both — plus search, priority, and sharing via QR code with the password shown on request, even when they are not connected. |
| **Internet access** | See status and traffic of each connection, use WiFi, Ethernet and USB tethering, configure failover, load balancing and multi-WAN rules. |
| **Captive portals** | Detect the captive portals of hotels and public networks and open the login flow in the browser. |
| **Local network** | Configure IPv4 address, DHCP and DNS, choose how IPv6 is announced to devices, change the role and MAC address of the Ethernet ports, and see connected devices with the port or access point they come from. |
| **VPN** | Manage Tailscale, pick an exit node, save several named WireGuard configurations and activate one at a time, and enable the kill switch with a temporary pause to get through captive portals. |
| **System** | Save connection-mode profiles, export and restore configuration backups, turn the status LED on and off, choose what the physical switch does, manage USB, clock and scheduled reboot. |
| **Language** | Use the interface in English or Italian. On first access the language follows the browser (English if it is neither English nor Italian); it can be changed from the menu on the login page or in Settings, and the choice is remembered by the browser. |

For example, at a hotel you can connect the router to the hotel WiFi, complete
the portal login and keep using your personal network. If you have configured a
second connection, failover lets you use it when the main one is no longer
available.

## Project status and current limitations

The features listed above are implemented; the project is under development and
needs on-device testing across different network scenarios.

- **IPv6** is handled end to end: dual-stack WANs, RA/DHCPv6 announcements on
  the LAN, firewall, VPN, WireGuard and multi-WAN failover. There is no global
  switch; the choice is made per WAN. The **captive portal** check is the only
  IPv4-only part, on purpose: portals are an IPv4 mechanism. Details and tables
  are in the architecture document.
- Multi-WAN load balancing, using a remote Tailscale exit node and an active
  WireGuard tunnel are mutually exclusive modes. The UI enforces these
  constraints.
- WireGuard stores several configurations, each with one peer, and keeps one
  active at a time; it offers neither split tunneling nor multiple active
  tunnels.
- The kill switch blocks forwarding from the LAN to the WAN; its scope and
  limits are described in the architecture document.
- The UI does not configure WiFi Enterprise networks or isolated guest
  networks. Hidden SSIDs are added by hand from the WiFi tab, giving name,
  bands and security type.
- The simulator helps exercise the flows but does not replace testing on
  OpenWrt. An automated Vitest suite covers frontend logic, the translations
  and the router shell helpers; there is no CI pipeline yet.

Technical details, rollback behaviour and missing pieces are described in
[Architecture and implementation status](docs/architettura.md) (in Italian).
For when something goes wrong on the road, see the
[recovery guide](docs/recovery.md) (in Italian).

## Try the interface without a router

With Node.js and npm installed, from the project folder:

```powershell
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173/travel/**. When the `VITE_ROUTER` variable is not
set, the development server enables the simulator and the login accepts any
password. You can explore the screens and try WiFi networks, connection drops,
captive portals and VPNs without a device.

The simulated data and scenarios are in
[`frontend/src/lib/mock.ts`](frontend/src/lib/mock.ts).

To develop against a real router, from the `frontend` folder:

```powershell
$env:VITE_ROUTER = "https://192.168.10.1"
npm run dev
```

In this mode the actions you take in the interface change the router you point
it at.

## Installing on the router

You need a PC with **PowerShell, Node.js, npm, SSH and tar**, a router with
OpenWrt already installed, and administrative SSH access. The router is expected
to provide the basic OpenWrt services, including uhttpd with ubus access,
rpcd/UCI and ucode with its modules; the full list is in the
[architecture document](docs/architettura.md#build-installazione-e-dipendenze).
Installing missing dependencies requires Internet access from the router.

From the repository root:

```powershell
.\tools\deploy.ps1 -Router 192.168.10.1
```

Replace the address with your router's. The script builds the frontend on the
PC, copies the files over SSH and runs the setup. The router only serves static
files; Node.js is needed on the PC only.

To also install the optional web terminal:

```powershell
.\tools\deploy.ps1 -Router 192.168.10.1 -WithTtyd
```

Then open **https://192.168.10.1/travel/**, if HTTPS is configured on the
router, and sign in with the root password. A self-signed certificate triggers a
browser warning. Adapt the example addresses to your own LAN.

| Option | Purpose |
|---|---|
| `-Router <ip>` | Router address; default `192.168.10.1` |
| `-User <user>` | SSH user; default `root` |
| `-SkipBuild` | Use the build already in `frontend/dist/` |
| `-WithTtyd` | Also install `luci-app-ttyd` |

The setup installs services and dependencies, initialises network and firewall
configuration, and sets the router's start page to open `/travel/`. **LuCI
stays reachable at `/cgi-bin/luci/`.** Any dependency warnings must be resolved
to use the related features.

Creating the access points in the first place is separate from the deploy: the
[`tools/setup-ap.ps1`](tools/setup-ap.ps1) script configures SSID and password
on both radios, disables the other WiFi interfaces and reloads wireless.

## Structure and development

```text
frontend/              Preact, TypeScript and Vite interface
  src/i18n/            UI texts in English and Italian
  src/lib/             ubus client, application logic and simulator
  src/screens/         Application screens
package/travel/files/  rpcd backend, ucode daemon, services and setup scripts
tools/                 Deploy and device tools
docs/                  Architecture and operational documentation (Italian)
```

The browser talks to the router through `/ubus`. The `travel` plugin exposes
the management operations; the `traveld` daemon handles reconnection, traffic
sampling and automations. OpenWrt keeps doing the actual connection and
configuration management.

To type-check, test and build, from the `frontend` folder:

```powershell
npm run typecheck
npm test
npm run build
```

On Windows, the tests of the shell helpers need Git Bash at the standard path
`C:/Program Files/Git/bin/bash.exe`.

### Languages

UI texts live in `frontend/src/i18n/`, one file per area, with Italian and
English side by side (`defineText`). The English type is derived from the
Italian one: a missing key is an `npm run typecheck` error, and
`tests/i18n.test.ts` checks that both languages have the same keys.

The router writes its messages in English, next to a stable code
(`error_code`, `error_params`): the interface rebuilds the message in the chosen
language from `frontend/src/i18n/backend.ts`, and falls back to the router's
English sentence when it does not know the code. A new backend error is written as
`fail_code code "sentence" key value`; `tests/backend-codes.test.ts` fails until
the code has its translation.

## Contributing

Bug reports, on-device testing and improvement proposals are welcome. When
reporting a problem, include the router model, OpenWrt version and build,
project version, steps to reproduce and the expected behaviour. Remove
passwords, keys and any other private data from attached logs.

To find your way around the code and the areas still to be completed, start
from [`docs/architettura.md`](docs/architettura.md) (in Italian). Comments in
the source code are written in Italian as well.

This README also exists in [Italian](README-it.md); the two files are kept in
sync.
