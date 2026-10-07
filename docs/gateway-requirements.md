# Gateway requirements and prerequisites

What to have ready before installing a Kestrel gateway. "Tested" means we ran it; "expected" means it should work and has not been tried yet.

## What a gateway needs, on any platform

| | Requirement |
|---|---|
| Network out | HTTPS (TCP 443) to your Kestrel address. Nothing inbound from the internet, no tunnels. A proxy that rewrites or inspects TLS may need the Kestrel address excluded |
| Network in (LAN) | TCP 8080 (or the next free port up to 8089) from the machines that open the gateway's page. Allow it in the host firewall only for your management network |
| Reach to devices | The gateway must be able to open connections to every device it watches (their IP and port: PJLink 4352, Crestron, Q-SYS, SNMP 161/UDP, HTTP/HTTPS, serial and so on). Put it on, or route it to, the AV VLAN |
| Name resolution | DNS for the Kestrel address |
| Clock | Correct time (NTP or the hypervisor's time sync). A clock that is far out makes signed releases and tokens fail |
| Disk | 2 GB free (the Docker image alone is about 900 MB), plus the data folder. The data folder holds the gateway's identity, its device list, logs and a telemetry buffer capped at 20,000 events (offline buffer) |
| Memory | Planning figure, not yet measured under load: 1 GB free for up to about 50 devices. We will replace this with a measured number |
| Enrolment | A one-time token from the portal (Gateways, then Add gateway), or no token: an unclaimed gateway announces itself and Kestrel staff assign it |
| Updates | The gateway asks the portal when to update; Windows downloads a signed bundle from a link the portal gives it (GitHub release storage), Docker pulls the image through Watchtower from `ghcr.io` |

## Docker (supported on Linux)

| | |
|---|---|
| Host | Linux x86-64 (`linux/amd64`). ARM is not published yet |
| Docker | Docker Engine 24 or newer with Compose v2 (`docker compose`). Tested on Docker 28 |
| Image | `ghcr.io/<org>/kestrel-gateway:stable` (or `:beta`). About 900 MB. The host must be able to reach `ghcr.io` |
| Networking | `network_mode: host` (as `docker-compose.yml` sets) if you use trusted-IP panel access. Behind the default bridge network every client looks like one address |
| Volume | A named volume or folder mounted at `/data`. Keep it: it is the gateway's identity |
| Serial devices | Pass them through, for example `--device /dev/ttyUSB0`, and add the container user to the device's group |
| Time zone | Set `TZ` (for example `Australia/Sydney`) so log lines show local time |
| Auto-update | The compose file runs Watchtower. A container started with a plain `docker run` cannot update itself |
| Restarts | `restart: unless-stopped`. Tested: restarts after a crash and after SIGTERM, keeps its identity. It does not restart a gateway that is running but unresponsive |

Not supported: Docker Desktop on Windows or macOS for production (no host networking, so trusted IPs and device discovery are limited), and Linux containers on Windows Server. Use the Windows installer on Windows.

## Windows (installer)

| | |
|---|---|
| OS | Windows 10 or 11, x64. Windows Server 2019, 2022 and 2025 are expected to work (Server 2016 is the minimum for the bundled Node) but have not been tested yet |
| Virtual machine | Expected to work on Hyper-V and VMware with a bridged adapter on the device network. Not tested yet |
| Rights | An administrator to install. The gateway then runs as its own service account, `NT SERVICE\KestrelGateway` |
| PowerShell | Windows PowerShell 5.1 (built in) |
| Disk and memory | As above. The installer is self-contained (its own Node), nothing else to install |
| Running as | A Windows service that starts at boot, before anyone signs in, plus a tray icon at login and Start menu and desktop shortcuts that open its page (the tray is only a viewer, so Server Core simply has no tray) |
| Silent install | `KestrelGatewaySetup.exe /VERYSILENT /CloudUrl=https://... /Token=...` |
| Firewall | Allow inbound TCP 8080 on the management network |
| Serial devices | Use the COM port name |

## What is not offered yet

- Native Linux packages (`.deb`, `.rpm`, systemd): see `docs/gateway-build-options.md`
- Linux arm64
- A published list of tested Windows Server and VM versions (to come from the test matrix in the build options plan)
