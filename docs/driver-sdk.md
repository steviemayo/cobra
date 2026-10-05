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
- **`transport`**: one of
  - `tcp`: text lines. Set `keepOpen` to hold one connection and hear the device's unsolicited messages. `terminator` ends what is sent and `replyTerminator` ends what comes back when it differs (Shure ends replies with `>` and sends nothing after a command: `"terminator": "", "replyTerminator": ">"`).
  - `udp`: one datagram per command. A reply is waited for only when the command has `expect`, or for a polled action when there are feedback patterns. With nothing to poll, the device stays "unknown" until a command is answered.
  - `websocket`: one open socket (`secure`, `path`, `headers`). `send` is a text message, and every message received is read for feedback.
  - `http`: `https`, `headers`, `port`, and `allowSelfSigned` (with `https`: accept the device's own certificate, which most AV devices have).
- **Binary devices** (`tcp` and `udp`): give an action `hex` instead of `send`: pairs of hex digits, with values filled in as hex (`"AA 11 {setting.displayId} 01 01 {checksum}"`). No terminator is added. `{checksum}` is the check byte of the bytes before it, set on the transport as `"checksum": { "type": "sum8" | "xor8", "from": 1 }` (`from` is the first byte counted: 0 is the first, 1 skips a header byte). Set `"binary": true` on the transport and each reply is shown to feedback patterns as hex pairs (`"AA FF 00 03 41 11 01 13"`), so a pattern can match `"AA FF [0-9A-F]{2} 09 41 00 01 "`. A reply is whatever one read returned, so a pattern should not anchor to the very start of a long stream. `{levelHex}` is two hex digits and `{levelHexAscii4}` is four hex digits written as ASCII characters and then as hex bytes (NEC writes 50 as the bytes `30 30 33 32`).
- **`inputCodes`**: the device's own code for each input port, read by `select_input` as `{inputCode}` (`"inputCodes": { "in1": "21", "in2": "23" }`). An input with no code is refused, not sent as a short frame.
- **`make`, `model`, `categories`**: who makes the device and which categories it suits. They label the driver in the picker (Category – Make Model) and filter it to the right devices; with no category it is offered for every one.
- **`settings`**: what someone fills in per device (`host` and `port` always exist). Types: `string`, `number`, `boolean`, `secret`. Use them in templates as `{setting.password}`.
- **`commands`**: any of `power.on`, `power.off`, `mute.on`, `mute.off`, `volume`, `select_input`, `route`, `preset`, `camera_preset`, `scene`, `record.on`, `record.off`, `blank.on`, `blank.off`, or `command.<name>` for anything device specific.
  - TCP action: `send` (and optionally `expect`, a regular expression the reply must match).
  - HTTP action: `method`, `path` (starts with `/`), `body`, `expect`.
- **Placeholders**: `volume` gets `{level}`; `select_input` gets `{input}` `{inputNumber}`; `route` gets `{input}` `{output}` `{inputNumber}` `{outputNumber}`; `preset`, `camera_preset` and `scene` get `{name}`. A port id such as `in2` gives `inputNumber` 2.
- **`volumeScale`**: maps the room's 0-100 to the device's range, and back when reading feedback.
- **`feedback`**: `poll` actions run on a timer; `patterns` are regular expressions tried on every line (TCP) or reply body (HTTP). `set` is one of `power`, `muted`, `volume`, `input`, `preset`, `blanked`, `online`, `firmware` (the device's firmware or software version, shown on the Firmware page; a room with such a driver needs a gateway that reports the `firmware` feature), `model`, `serial` or `mac` (what the device says about itself; they fill the asset register); `value` is a literal (`on`, `off`, `true`, `false`) or `$1` for the first group.

## Class, features and setting scope

Plan: `docs/driver-classes.md`. Built so far: the fields, their checks, and the class table.

- **`class`** (optional): the kind of device the driver is for: `projector`, `display`, `video_switching`, `avoip_switching`, `point_based`, `camera`, `conference_system`, `reinforcement_mic`, `conferencing_mic`, `recorder`, `presentation_source`, `environmental`, `relay`, `sensor`, `infrastructure`
- **`features`** (optional): the optional parts of that class this driver supports (a display: `remote_keys`, `apps`; a projector: `lens`, `light_source_hours`). Checked against the class when the driver is saved. Features need a class
- **Setting `scope`** (optional, per setting): `design` (what the room is: component names, preset names), `binding` (where this room's device is: address, port) or `secret` (logins and keys). Left out, it is worked out from the type and the name: `secret` type or a name like `password` is secret, `host` and `port` are binding, the rest is design
- A driver that leaves `class`, `features` and `scope` out is unchanged, and so is its hash
- Screens are now two device categories, `display` and `projector`. Rooms saved with the older `video_destination` still load and behave as before

## Added by the driver classes work

- **Class contract.** A driver that names a `class` must define the commands the class needs, and the commands each feature it declares needs. The check runs when a driver is saved (portal, command line and bundled drivers alike). For example a `display` needs `power.on`, `power.off` and `select_input`; its feature `blank` needs `blank.on` and `blank.off`, `remote_keys` needs `key.up`, `key.down`, `key.left`, `key.right`, `key.ok` and `key.back`, `apps` needs `app.launch`, `builtin_audio` needs `volume`. The table is `CLASS_CONTRACT` in `packages/model/src/room/driver-classes.ts`
- **New commands:** `key.<name>` (`up`, `down`, `left`, `right`, `ok`, `back`, `home`, `menu`, `play`, `pause`, `stop`, `forward`, `rewind`) and `app.launch` (gets `{appId}`)
- **Per-command `headers`** (HTTP): headers for that request only, over the driver's own. Used for an action that needs a different content type
- **`replyTerminator`** (TCP transport): what ends a reply, when it differs from the terminator that ends a command (LG commands end in CR and replies in `x`)
- **Hex placeholders:** `{levelHex}` (a level as two hex digits, for `volume`) and `{inputHex}` (HDMI n as an LG input code, for `select_input`)
- A keep-open TCP driver reads its `feedback.poll` actions once as soon as it connects, then on their intervals
- Bundled examples: `lib:sony-bravia` (HTTP, keys and apps), `lib:lg-signage` (TCP, reply terminator, hex), `lib:kramer-p3000` (TCP routing)

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
