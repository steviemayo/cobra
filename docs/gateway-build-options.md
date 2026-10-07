# Gateway build options (plan, 2026-10-07)

Status: reference only. Docker stays the supported Linux route for now. What customers are told to prepare is in `docs/gateway-requirements.md`.

## Where we are

| Target | Built today | Tested |
|---|---|---|
| Docker (Linux image, `linux/amd64`) | Yes. `node:26-slim`, runs from TypeScript through `tsx`, 894 MB | Yes: 2026-10-07 on Docker Desktop. Check-in, crash and SIGTERM restart (credential kept), 45 s cloud outage, revoked credential (re-enrols) |
| Windows x64 bundle + installer | Yes. Node 22, WinSW service, Inno Setup installer | Windows 10/11 only. **Not tested on Windows Server or in a VM** |
| Native Linux (`.deb`, `.rpm`, systemd) | No | No |
| Linux arm64 | No | No |

Findings from the 2026-10-07 review:

- Docker image runs Node 26, while `.nvmrc` and the Windows bundle use Node 22. Pick one (Node 22 LTS is the safer default) so the shipped runtime is the tested one
- Docker image runs from source through `tsx`; Windows runs the compiled `dist/main.mjs`. Running `dist` in the image would start faster and shrink it a lot
- `restart: unless-stopped` restarts on process exit only. A gateway that hangs but stays alive is flagged `unhealthy` and nothing restarts it. Fix: an `autoheal` sidecar, or the gateway exiting itself when its own loop stalls
- Trusted-IP panel access needs host networking. That does not work on Docker Desktop (Windows or Mac), and Linux containers do not run natively on Windows Server
- Serial devices need `--device` passthrough into the container
- Image is `amd64` only, so a Raspberry Pi or ARM mini PC cannot run it

## Windows Server and virtual machines

- Service mode needs no desktop, so Server 2019, 2022 and 2025 (including Server Core) should work. Node 22's own floor is Windows 10 / Server 2016
- The tray icon needs an interactive session, so it is not available on Server Core. Item 2 of the local-access work (service only, optional tray viewer) removes the dependency
- A VM is fine. Hardware-bound pieces are the network mode (ARP-based address tracking and discovery need the VM on the device VLAN, bridged) and serial (COM or USB passthrough)
- To do: run the installer on Server 2019, 2022 and 2025 (GUI and Core) and on Hyper-V and VMware guests, then publish the result as a supported-platforms table

## Options for Linux later

| Option | What it is | Good for | Cost |
|---|---|---|---|
| A. Docker only (now) | Image from GHCR, compose with Watchtower | Servers, NUCs, anything that can run Docker Engine | Customers need Docker. No Linux Server support story for corporate Windows shops |
| B. Native package | `.deb` and `.rpm` bundling Node, a systemd unit, a `kestrel` service user, `/var/lib/kestrel-gateway` | Locked-down corporate Linux with no Docker, ARM boxes | Two package formats, signed repo, a Linux update path (apt or our own updater) |
| C. Static bundle + install script | `tar.gz` with Node and a script that makes the unit | Fastest way to a native route | Customers run a script as root; no package manager updates |
| D. Docker plus arm64 | Multi-arch image | Raspberry Pi, ARM mini PCs | Longer CI build (QEMU or an ARM runner) |

Recommendation when we move: D first (cheap, widens hardware), then B (`.deb` first, then `.rpm`) reusing the Windows bundle's signed-update flow. C only if a customer needs it before B is ready.

What B needs:

- Compiled `dist` plus the panel app and a pinned Node runtime, as the Windows bundle does
- systemd unit: `Restart=on-failure`, `User=kestrel`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/kestrel-gateway`, `NoNewPrivileges`, `After=network-online.target`
- Updates through the existing portal-ordered flow (signed bundle checked by the gateway and an updater unit), as on Windows
- Native modules built per architecture (`serialport`)
- CI matrix on Ubuntu 22.04 and 24.04 and Debian 12, plus RHEL 9 / Rocky 9 for `.rpm`

## Local access (order of work)

1. Sign in with Kestrel on the gateway's local page (done, gateway 0.7.0; see `docs/gateway-local-access.md`)
2. Windows: one install mode (a service), tray icon as a viewer (done, gateway 0.7.0)
3. Gateway page: web-app styling, troubleshooting content
4. Platform requirements published (`docs/gateway-requirements.md`), Linux native options above kept for later
