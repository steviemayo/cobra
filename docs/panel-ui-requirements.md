# Panel UI requirements (draft for review)

Status: slice 1 built (see Build status). Rest is draft. Applies to the generated panel served by the gateway on the LAN (`apps/panel`, `packages/panel-ui`), also shown in the portal simulator.

Sources: reference screenshots from another vendor's panel (layout ideas only, no branding or assets copied) plus the rules already decided in `CLAUDE.md` (intent-based UI, Activities, volume, auto-off).

## Goals

- A non-technical person walks in and reaches "working" in 1 to 2 taps
- Clean and calm: show less by default, detail one tap deeper
- Readable and tappable at arm's length on wall or table panels
- Themed per organisation (logo, accent colour, language)

## Targets

- Panels: 10" and 7" touch panels or tablets, landscape. Crestron touch panels are 1280x800 (16:10) at a 1.5 pixel ratio, so the browser sees about 853x533 CSS px. Other panels and tablets are typically 1920x1080 (16:9) or 1920x1200 (16:10); their pixel ratio is not known yet
- Also opened in a laptop or phone browser: must not break, but full mobile design is post-MVP
- Dark theme only for MVP
- Touch targets: min about 9 mm on the physical panel. That is about 76 physical px (about 51 CSS px) on a 7" 1280x800 panel, and about 112 px on a 7" 1920 px panel. Size the UI with viewport-relative units (scale from width, design for CSS widths from about 850 to 1920) so 7" and 10" both work

## Layout

**Room off:** minimal. Room name at top left, the start options (Present, Video call, Record...) centred in the middle of the screen, and nothing else: no nav, no bottom bar, no quick actions, no status.

**Room on:** three zones:

- **Top bar:** room name at top left with what the room is doing in small print underneath (e.g. "Showing Laptop 1."; progress and problems show in their own colour). In the middle, the activities as one glass pill with a highlight that slides to the one being shown. At the right, the Power button. No Home button and no full-width status banner
- **Content area:** the current activity: big tiles, plain language
- **Bottom bar:**
  - left: clock and room name
  - centre: volume (see below) and mute
  - right: up to 3 quick actions, supplied by drivers (see Quick actions), plus a Quick Actions sheet for the rest. Each shows an on/off state

**Power:** a Power button in the top bar once the room is on. It opens "Power off system?" with Cancel and Power off. Cancel, Escape, or a touch outside go back. Room Off is not a nav item or tile.

**Look:** gradient background tinted by the accent colour; translucent, blurred "glass" surfaces with a light edge and soft shadow. Blur is the main cost on weak panel hardware: check on real panels and add a lite mode if needed.

## Screens

1. **Idle** ("Touch to begin"): logo, clock, room name, optional support text and QR. Touch runs the configured action (see Idle behaviour)
2. **Start** (room off): the activities as big centred tiles. Picking one turns the room on and goes to it. Activities come from the room type (Present from laptop, Video call, Record; devs can add, rename, hide)
3. **Activity** (room on): shown under the top nav; switching is one tap on the nav
4. **Function pages** (behind the top nav): sources, microphones, cameras (presets, pan/tilt, zoom, tracking), recorder, room linking (combine/split), room controls (lights, blinds, screen)
5. **Quick Actions sheet**: extra one-tap actions the room enables
6. **Tech view**: device-level controls and tests; PIN on the panel
7. **Notices**: second source plugged in (auto-switch after 10 s), auto-off warning 30 s before, room or gateway offline, plain-language errors
8. **Volume HUD**: see below

## Volume (decided)

- Two large buttons, − and +, in the bottom bar. Tap = one step. Press and hold = ramp
- **No slider** anywhere in the end-user UI
- On any change, show a short overlay (about 1.5 s) with the level, like a phone. It is not always on screen
- Level is shown as 0 to 100 (scaled from the device range, e.g. -40 dB to 0 dB). If the device gives no feedback, hide the number and show only a brief icon pulse
- Mute button beside it with a clear on/off state. Default level 50 unless the room config overrides it

## Idle behaviour (new room setting)

"Touch to begin" runs one configurable action:

- Wake the panel only (room stays as it was) (default)
- Run an activity (choose which, e.g. Present)
- Run the room's On state

Also configurable: idle timeout back to the Idle screen, and whether the support text and QR show.

## Theming

- Per org: logo, one accent colour, language. The accent colour also themes the portal (same setting, same contrast check) Base is a neutral dark palette with the accent for active states and primary actions
- Default accent: try green and blue, pick the one with the better contrast on the dark base. Red is not the default
- Contrast rules: body text 4.5:1 or better, large text and controls 3:1 or better against their background, including the accent. Text on the accent uses an auto-chosen dark or light colour. If an org's accent cannot reach the ratio, the portal warns and adjusts it (or refuses)
- Never rely on colour alone for state: pair it with an icon or label

## Quick actions (supplied by drivers)

- A quick action is offered only when the room has what it needs. The **driver** declares which quick actions its device supports, and the room model decides whether they appear
- **Blank Screen**: only if the room has a display device and that display's driver supports blank. Acts on the display group
- **Privacy Mute**: only if the room has conferencing microphones and a conference system. Mutes the conferencing mics and shows state
- Same action on several devices (e.g. two displays) is one button acting on all of them
- Driver-declared quick actions can be toggles (with on/off state from feedback) or one-shot buttons
- Order of the bottom bar: fixed order from the room type, devs can hide or reorder, max 3 in the bar and the rest in the Quick Actions sheet
- Driver format: see `docs/driver-sdk.md` (Quick actions). Built: Blank Screen and Privacy Mute. Order is fixed (Blank, then Privacy Mute); hide/reorder by devs is not built

## Room Linking (parked, to redesign)

The current "Combining Rooms" implementation is not what is wanted. Do not build panel UI for it yet. Intent captured for the redesign:

- Combining is defined when a room group is first created, not afterwards
- Create the large "all combined" room, then each independent room in the group, so every room is state-aware and knows the intended behaviour when combined
- Build every combination for 2, 3, 4 or 5 rooms, and each separate room
- Panels show the room they belong to, or the combined room when combined
- Open points are listed under Open questions

## Language and feedback

- Plain language, no device names or jargon on end-user screens
- Feedback is deterministic: move on the moment devices are ready, no fixed waits; show "Getting ready..." only while actually waiting
- Multiple panels per room mirror each other

## Changes this needs

- **Model (`packages/model`):** room settings for idle action, idle timeout and support text; org theme accent colour; new capabilities (e.g. `blank`) and driver-declared quick actions
- **Drivers (`packages/drivers`):** `quickActions` in the driver format, and blank/mute support in the built-in drivers that can do it (PJLink has AVMT for blank)
- **Panel UI (`packages/panel-ui`):** bottom bar, volume HUD, sliding-highlight nav, power dialog, idle screen, tokenised theme
- **Portal:** room settings form for the above, org accent colour picker with contrast check (applies to portal and panel)
- **Simulator:** shows the same panel, at 7" and 10" preview sizes

## Out of scope for MVP

- Mobile-specific layout and QR-to-phone polish beyond what exists
- Light theme
- Custom logic hooks
- Third-party UI themes or layouts

## Open questions

1. How does the browser on non-Crestron panels and tablets report size and pixel ratio? Check on real devices
2. Quick action defaults beyond Blank and Privacy Mute (e.g. Freeze, Lights)? Otherwise none
3. Room Linking, for the redesign session:
   - DECIDED: only physically possible combinations. Do not assume rooms sit in a simple line or that walls are equal: e.g. 4 rooms in a line plus 1 large room that can open onto the middle 2. Model the room group as a graph of which rooms/spaces can physically join (and which sets of them can be open together), and generate combinations from that. No assumed upper limit on rooms or combinations
   - is each combined room authored separately, or derived from its member rooms with overrides? (proposed: derived, so nobody hand-builds 26 rooms)
   - must all member rooms run on the same gateway? YES all must be on same gateway (note in portal)
   - what happens to the existing `RoomCombination` data and UI (primary/secondary, follow/blank)? Remove this as it was incorrect

## Build status

Slice 1 (built, on branch `feat/panel-ui-redesign`):

- Theme: default blue accent, contrast checked; org accents are lightened/darkened until legible (`legibleAccent`)
- Layout: top bar, content, always-visible bottom bar; sizes scale from panel width (em units)
- Volume: no slider; - / mute / + buttons; HUD overlay on change; number hidden when no device gives feedback
- "Touch to begin" (wake / activity / room on, timeout, support text and QR) as room settings, editable in the room editor
- Minimal off state (start options centred, no bars); on state has a top nav pill with a sliding highlight, status in small print under the room name, and a Power button with a confirmation
- Glass styling on a gradient background
- The earlier "home screen mode" setting was removed: activities are always in the top nav while the room is on
- Quick actions: bottom bar and sheet are built and tested. Supplied by drivers (see Slice 2)

Slice 2 (built, branch `feat/quick-actions`): quick actions from drivers

- Driver format: `quickActions` (standard ids `display.blank`, `mics.privacy_mute`), commands `blank.on`/`blank.off`, feedback field `blanked`; validated on save
- Bus: `DeviceBus.quickActions(deviceId)`; real drivers report what they declare, the simulator derives it from the device's driver setting (`driverQuickActions`)
- Engine: offers Blank only with a display whose driver supports it, Privacy Mute only with a voice-capture mic plus a supporting conference system; `quickaction.run` acts on every supporting device, state comes from device feedback; powering a display off clears the blank
- PJLink blanks with AVMT; Cisco RoomOS library driver privacy-mutes and polls mic mute state
- Panel: labels translated by action id (en/es/fr/de)
- Not done: a failed action is silent (the button just does not turn on); blank is not cleared by changing source; a model `blank` capability was not added (support lives in the driver, as decided); the browser simulator does not see an org's custom drivers, so their quick actions only show on the gateway

Next slices:
- Function pages: cameras, microphones/audio, recorder, room controls
- Org accent colour setting applied to the portal (same contrast check)
- Room linking redesign
- Check on real 7" and 10" panels
