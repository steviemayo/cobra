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
- **`commands`**: any of `power.on`, `power.off`, `mute.on`, `mute.off`, `volume`, `select_input`, `route`, `preset`, `camera_preset`, `scene`, `record.on`, `record.off`, or `command.<name>` for anything device specific.
  - TCP action: `send` (and optionally `expect`, a regular expression the reply must match).
  - HTTP action: `method`, `path` (starts with `/`), `body`, `expect`.
- **Placeholders**: `volume` gets `{level}`; `select_input` gets `{input}` `{inputNumber}`; `route` gets `{input}` `{output}` `{inputNumber}` `{outputNumber}`; `preset`, `camera_preset` and `scene` get `{name}`. A port id such as `in2` gives `inputNumber` 2.
- **`volumeScale`**: maps the room's 0-100 to the device's range, and back when reading feedback.
- **`feedback`**: `poll` actions run on a timer; `patterns` are regular expressions tried on every line (TCP) or reply body (HTTP). `set` is one of `power`, `muted`, `volume`, `input`, `preset`, `online`; `value` is a literal (`on`, `off`, `true`, `false`) or `$1` for the first group.

## Planned: quick actions (not built yet)

Drivers will declare which panel quick actions their device supports, so the panel only offers what the room can actually do (for example Blank Screen only when a display's driver supports blank).

```json
"quickActions": [
  { "id": "display.blank", "label": "Blank Screen", "icon": "blank", "kind": "toggle",
    "on": "command.blank.on", "off": "command.blank.off", "stateFrom": "blanked" }
]
```

- `id` is a standard id (`display.blank`, `mics.privacy_mute`, ...) so the same action on several devices becomes one button acting on all of them
- `kind` is `toggle` (state from feedback) or `button` (one shot)
- `stateFrom` is a new feedback field (`blanked`), added alongside `power`, `muted`, `volume`, `input`, `preset`, `online`
- Whether an action shows also depends on the room: Privacy Mute needs conferencing microphones and a conference system in the model
- Requirements: `docs/panel-ui-requirements.md`

## Safety

- Values placed into a command are cleaned for where they land: control characters are removed from text sent to a device (so a preset name can't add a second command), URL path values are percent-encoded, and values inside a JSON body are JSON-escaped.
- Drivers cannot run code, read files, or open connections anywhere except the device's own address.
- Unknown fields are rejected, so a typo doesn't silently do nothing.
- A published marketplace template has its device settings stripped, so passwords and addresses never leave the publisher.

## Limits

Up to 30 settings, 40 feedback patterns, 10 poll actions, 50 drivers per organisation and 100 versions per driver.
