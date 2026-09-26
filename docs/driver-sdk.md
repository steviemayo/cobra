# Kestrel driver SDK

A driver teaches Kestrel to talk to one kind of device. It is a **JSON file**, not code: it lists what to send for each thing a room can ask for, and how to read the device's replies. Every gateway runs every driver with the same interpreter, so a driver can only ever talk to its own device using the moves the format allows.

Custom drivers need the **Pro** plan. Kestrel ships built-in drivers for PJLink, Crestron DM NVX (virtual matrix) and Q-SYS Core; anything else can be a custom driver.

## The flow

1. Write a driver in the portal (**Custom drivers**) or in a file, and check it: `pnpm --filter @kestrel/drivers driver validate my-driver.json`
2. See what it would send: `pnpm --filter @kestrel/drivers driver render my-driver.json --level=50 --input=in2`
3. Save it. Every save is a new **version**. Versions are immutable.
4. In a room design, set a device's control to **Driver** and pick `custom:<id>`.
5. Publish the room. The release **pins** the exact driver version (it is inside the signed manifest), so editing a driver never changes a room that is already running.

## Format

```json
{
  "id": "my-projector",
  "name": "My projector",
  "transport": { "type": "tcp", "port": 4352, "keepOpen": false, "terminator": "\r\n", "timeoutMs": 2000 },
  "settings": [{ "key": "password", "label": "Password", "type": "secret", "required": true }],
  "commands": {
    "power.on":  { "send": "PWR ON",  "expect": "^OK" },
    "power.off": { "send": "PWR OFF", "expect": "^OK" },
    "volume":    { "send": "VOL {level}" },
    "select_input": { "send": "SRC {inputNumber}" }
  },
  "volumeScale": { "min": 0, "max": 30 },
  "feedback": {
    "poll": [{ "action": { "send": "STATUS?" }, "everyMs": 5000 }],
    "patterns": [{ "match": "^POWER=(ON|OFF)", "set": "power", "value": "$1" }]
  }
}
```

- **`id`**: lowercase letters, numbers and dashes. Devices refer to it as `custom:<id>`.
- **`transport`**: `tcp` (text lines; set `keepOpen` to hold one connection and hear the device's unsolicited messages) or `http` (`https`, `headers`, `port`).
- **`settings`**: what someone fills in per device (`host` and `port` always exist). Types: `string`, `number`, `boolean`, `secret`. Use them in templates as `{setting.password}`.
- **`commands`**: any of `power.on`, `power.off`, `mute.on`, `mute.off`, `volume`, `select_input`, `route`, `preset`, `camera_preset`, `scene`, `record.on`, `record.off`, `blank.on`, `blank.off`, or `command.<name>` for anything device specific.
  - TCP action: `send` (and optionally `expect`, a regular expression the reply must match).
  - HTTP action: `method`, `path` (starts with `/`), `body`, `expect`.
- **Placeholders**: `volume` gets `{level}`; `select_input` gets `{input}` `{inputNumber}`; `route` gets `{input}` `{output}` `{inputNumber}` `{outputNumber}`; `preset`, `camera_preset` and `scene` get `{name}`. A port id such as `in2` gives `inputNumber` 2.
- **`volumeScale`**: maps the room's 0-100 to the device's range, and back when reading feedback.
- **`feedback`**: `poll` actions run on a timer; `patterns` are regular expressions tried on every line (TCP) or reply body (HTTP). `set` is one of `power`, `muted`, `volume`, `input`, `preset`, `blanked`, `online`; `value` is a literal (`on`, `off`, `true`, `false`) or `$1` for the first group.

## Quick actions

A driver declares which panel quick actions its device supports, so the panel only offers what the room can actually do.

```json
"quickActions": ["display.blank"],
"commands": {
  "blank.on":  { "send": "BLANK 1" },
  "blank.off": { "send": "BLANK 0" }
},
"feedback": { "patterns": [{ "match": "^BLANK=(1|0)$", "set": "blanked", "value": "$1" }] }
```

- `quickActions` is a list of standard ids. Labels and icons are fixed by Kestrel (and translated by the panel), so the same action on several devices becomes one button acting on all of them
- Standard ids and the commands each needs (checked when the driver is saved):
  - `display.blank` (Blank Screen): `blank.on`, `blank.off`. Feedback field `blanked` shows the button's state
  - `mics.privacy_mute` (Privacy Mute): `mute.on`, `mute.off`. Uses `muted` feedback. For a conference system driver
- A driver with no `quickActions` (all existing ones) offers none. The field is left out of the driver rather than defaulted, so existing signed releases keep their hash
- Whether an action shows also depends on the room: Blank Screen needs a display device whose driver declares it; Privacy Mute needs conferencing microphones and a conference system whose driver declares it
- Built in: PJLink declares `display.blank` (AVMT picture mute; a projector that does not know AVMT stays usable and refuses the blank in plain words); the Cisco RoomOS library driver declares `mics.privacy_mute`
- Requirements: `docs/panel-ui-requirements.md`

## What the panel's extra pages use

The panel's Cameras, Microphones and Room controls pages (see `docs/panel-ui-requirements.md`) drive devices through commands a driver already has, so a custom driver gets them by supplying:

- **Microphone mute**: `mute.on` and `mute.off`
- **Camera views**: `camera_preset` (`{name}`); the device's `presets` setting lists the names
- **Lighting scenes**: `scene` (`{name}`); the device's `scenes` setting lists the names
- **Blinds**: `command.open` and `command.close`. **Screens and lifters**: `command.down` and `command.up`
- **Camera pan, tilt and zoom**: not expressible in the driver format yet; only the built-in VISCA over IP driver does it

A page is only offered when the room turns it on and the device has a driver.

## Safety

- Values placed into a command are cleaned for where they land: control characters are removed from text sent to a device (so a preset name can't add a second command), URL path values are percent-encoded, and values inside a JSON body are JSON-escaped.
- Drivers cannot run code, read files, or open connections anywhere except the device's own address.
- Unknown fields are rejected, so a typo doesn't silently do nothing.
- A published marketplace template has its device settings stripped, so passwords and addresses never leave the publisher.

## Limits

Up to 30 settings, 40 feedback patterns, 10 poll actions, 50 drivers per organisation and 100 versions per driver.
