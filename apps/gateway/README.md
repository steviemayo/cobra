# Kestrel gateway

Runs on-site next to your rooms. It talks to the cloud over outbound HTTPS only (no inbound ports, no tunnels), runs every room locally, and serves the touch-panel web app on the LAN. Rooms keep working with no internet.

## Run it

```sh
docker run -d --name kestrel-gateway --restart unless-stopped \
  -p 8080:8080 -v kestrel-data:/data \
  -e KESTREL_CLOUD_URL=https://<your kestrel app> \
  -e KESTREL_ENROLL_TOKEN=<token from the portal> \
  ghcr.io/<org>/kestrel-gateway:stable
```

The token is only needed the first time. After enrolment the credential lives in the `/data` volume; keep the volume to keep the gateway's identity and its cached room releases.

Panels open `http://<gateway>:8080/room/<room id>`. Use `:beta` for the beta channel.

### Automatic updates

Gateways update themselves from a release channel, separately from room programs. `main` publishes `stable` and `dev` publishes `beta`. A room keeps running from its cached release while the gateway restarts.

- **Docker:** use `docker-compose.yml` (next to this file). It runs the gateway and Watchtower, which pulls a new image for the channel in `KESTREL_CHANNEL` every 10 minutes and restarts only the gateway.
- **Windows:** in an elevated PowerShell, `.\install.ps1 -CloudUrl https://<your kestrel app> -EnrollToken <token> [-Channel beta]`. The installer downloads a self-contained bundle (it brings its own Node), starts the gateway at boot with a scheduled task, opens the panel port on private/domain networks, and adds a daily task that updates from the channel and puts the old version back if the new one does not start. `uninstall.ps1` removes it all (`-RemoveData` also removes the gateway's identity). The scripts are in `windows/`; CI builds the bundle on `windows-latest` and publishes it to the rolling `gateway-stable` and `gateway-beta` releases.

The portal shows each gateway's version, its channel, and "Update available" when it is behind. That comparison uses the newest version per channel from the server's `GATEWAY_LATEST_STABLE` and `GATEWAY_LATEST_BETA` settings, so set them when you release, and bump `GATEWAY_VERSION` in `src/config.ts`.

## Configuration

| Variable                                       | Default        | Purpose                                                                                       |
| ---------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| `KESTREL_CLOUD_URL`                            | required       | Base URL of the Kestrel cloud                                                                 |
| `KESTREL_ENROLL_TOKEN`                         | -              | One-time enrolment token                                                                      |
| `KESTREL_DATA_DIR`                             | `./data`       | Credential, cached releases, telemetry buffer (SQLite)                                        |
| `KESTREL_PANEL_PORT` / `KESTREL_PANEL_HOST`    | `8080` / `0.0.0.0` | Where panels connect                                                                      |
| `KESTREL_SIMULATE`                             | `off`          | `all`: simulate every device (demo). `missing`: real drivers where configured, simulated for the rest |
| `KESTREL_PUBLIC_KEY`                           | -              | Optional pinned signing key (PEM), trusted in addition to the cloud's                         |
| `KESTREL_LOG_LEVEL`                            | `info`         | `debug`, `info`, `warn`, `error`                                                              |

## How it stays safe

- **Signed releases.** Every release is checked before it runs: its hash must match, its Ed25519 signature must be valid for a trusted key, and it must be the room and release the cloud assigned. Anything else is refused and reported; the previous release keeps running. Cached releases are re-verified on every boot.
- **Panel access.** Per room: open, or a PIN (salted scrypt hash, locks an address out for a minute after 5 wrong tries), with an optional list of trusted IPs that skip the PIN. Behind Docker's default bridge network every client looks like the bridge address, so use `--network host` (or a macvlan) if you rely on trusted IPs.
- **Backpressure.** Panels are limited to 20 intents a second, and messages are size-capped and validated.
- **Offline.** Telemetry is buffered in SQLite (capped at 20,000 events, oldest dropped first) and replayed in order with its original timestamps.

## Develop

```sh
pnpm --filter @kestrel/panel-app build   # the panel web app the gateway serves
pnpm --filter @kestrel/gateway demo      # fake cloud + real gateway + simulated devices
```

The demo prints a panel URL and a `curl` command to plug a laptop cable in. `DEMO_PIN=1234` turns on the PIN pad; `DEMO_TEMPLATE=meeting-2-laptops` picks a different room.

Real drivers: PJLink, Crestron DM-NVX, Q-SYS, generic TCP/serial/REST, VISCA-over-IP cameras, custom declarative drivers, and a bundled library (Extron, Cisco RoomOS, Lutron, Shelly). A serial device needs the port passed into the container (`--device /dev/ttyUSB0`); on Windows use the COM port name. A room that needs a driver the gateway does not have reports that device by name.

### Phone control

Each room panel has a phone button that shows a QR code. It holds a link signed by the gateway that works for ten minutes (the panel replaces it every five); scanning it opens a control page on the Kestrel server that trades the link for a two hour session. It needs `KESTREL_SECRETS_KEY` set on the server.
