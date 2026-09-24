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

Real drivers today: PJLink and generic ASCII-over-TCP. Serial, REST and the Crestron/Q-SYS drivers are not built yet; a room that needs one reports that device by name.
