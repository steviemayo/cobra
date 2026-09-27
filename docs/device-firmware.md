# Device firmware reporting

Status: built, read only. Kestrel shows the firmware version a device reports about itself. It never changes a device's firmware.

## What you see

- **Firmware page** (Monitoring plan; sidebar and Ctrl K): every device with its driver, the version it reported and when that version was first seen. A summary by driver shows how many devices report a version, which versions are in use, and flags **Mixed versions** when one driver's devices run more than one.
- **Room monitoring page:** "Firmware 1.07" beside each device that reported one.
- A device shows **Not reported** when its driver cannot ask for a version, or it has not answered yet.
- Site-limited service providers see only their own sites' devices.

## Which devices report

| Driver                           | How                                                                                               | Notes                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| PJLink (projectors and displays) | Class 2 `SVER ?` (software version), read once after the device first answers, then every 6 hours | A class 1 device answers "not supported" once and is not asked again      |
| Biamp Tesira                     | `DEVICE get version` over the text protocol, every 6 hours                                        |                                                                           |
| Custom drivers                   | A feedback pattern with `"set": "firmware"` (see `docs/driver-sdk.md`)                            | The poll that returns the version must be in the driver's `feedback.poll` |

**Not yet:** the other bundled drivers (Q-SYS, cameras, Extron, Kramer, LG, Sony, Cisco, NVX and the rest). Each needs its vendor's documented query, and a real device to check it against. The PJLink (`SVER`) and Tesira (`DEVICE get version`) queries were written from what I know of those protocols and tested against fake devices only. They were **not checked against the vendors' documents or real hardware**: confirm both on a real projector and a real Tesira before relying on them.

## How it works

- The driver puts the version in the device state (`firmware`). The gateway adds `driver` and `firmware` to each device in its heartbeat.
- The cloud keeps them on the device's status row (`DeviceStatus.driver`, `firmware`, `firmwareSince`). A heartbeat that leaves the version out (a gateway that just restarted) keeps the last version instead of forgetting it.
- Versions are shown as the device wrote them (printable characters, up to 100).
- Reporting is part of monitoring, so it needs a plan with monitoring.

## Deploy

- Apply migration `20260927150000_device_firmware` (three nullable columns on `DeviceStatus`).
- Web first, then gateways. An older gateway simply reports nothing.
- A room whose **custom driver** uses a `firmware` pattern will not deploy to a gateway that does not report the `firmware` feature (it would refuse the driver format); the portal says to update the gateway first.

## Not built

- **Updating firmware.** Not planned: it needs per-vendor tooling and is risky.
- Alerts when a device runs an old version, or a list of known-good versions to compare against.
- A history of version changes (only the current version and when it was first seen).
- Firmware for the simulator's devices.
