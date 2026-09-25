# Panel UI requirements (draft for review)

Status: draft. No code until confirmed. Applies to the generated panel served by the gateway on the LAN (`apps/panel`, `packages/panel-ui`), also shown in the portal simulator.

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

Three fixed zones on every screen except Idle:

- **Top nav:** icon + label per function group, active item marked with the accent colour and an underline. Only groups the room supports appear. Typical: Sources (video), Audio, Cameras, Recorder, Room Linking, Room Controls
- **Content area:** one function group at a time, big tiles, plain language
- **Bottom bar (always visible):**
  - left: clock and room name
  - centre-left: volume (see below) and mute
  - right: up to 3 quick actions, supplied by drivers (see Quick actions), plus a Quick Actions sheet for the rest. Each shows an on/off state

## Screens

1. **Idle** ("Touch to begin"): logo, clock, room name, optional support text and QR. Touch runs the configured action (see Idle behaviour)
2. **Home**: either Activity tiles or the last-used activity with the top nav, chosen per room (see Home screen mode)
3. **Activity picker**: "What's happening today?" list, each with a short plain description. Set from the room type (Present from laptop, Video call, Record, Room off; devs can add, rename, hide)
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

## Home screen mode (new room setting)

- `Activity tiles` (default): Home is the tile grid. Picking one runs it and moves to that activity's view
- `Top nav`: Home is the last-used activity (or the room's default) with the top nav visible; the picker is one tap from a header button

## Idle behaviour (new room setting)

"Touch to begin" runs one configurable action:

- Wake the panel only (unlock, go to Home; room stays as it was) (proposed default)
- Run an activity (choose which, e.g. Present)
- Run the room's On state
- Do nothing beyond dismissing Idle

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
- Planned driver format change: see `docs/driver-sdk.md` (planned section)

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

- **Model (`packages/model`):** room settings for home screen mode, idle action, idle timeout; org theme accent colour; new capabilities (e.g. `blank`) and driver-declared quick actions
- **Drivers (`packages/drivers`):** `quickActions` in the driver format, and blank/mute support in the built-in drivers that can do it (PJLink has AVMT for blank)
- **Panel UI (`packages/panel-ui`):** new bottom bar, volume HUD, activity picker, idle screen, tokenised theme
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
