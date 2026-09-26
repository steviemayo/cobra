# Driver classes (proposal, for review before building)

Status: **slices 1, 2 and 3 built** (decisions in `docs/decisions.md`, "Driver classes"); the rest is plan. Written 2026-09-26. Extends `docs/driver-sdk.md` (which describes today's driver format). Once agreed, decisions move to `docs/decisions.md` and the driver SDK doc is updated as each slice lands.

## Why

- Devices of one kind behave alike even when their protocols differ. The engine, activities and panel should talk to a **class**, and each vendor driver should fill in how
- Today addresses and passwords sit inside each device's `settings`, so they are copied into templates, signed into releases and duplicated into combined rooms. That does not scale to "add 10 of the same room", shared equipment or credential rotation
- Open-architecture devices (DSP) cannot be modelled by category alone: the program inside them decides what exists

## Decisions

From the user (2026-09-26):

| #    | Decision                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DC-1 | Driver **classes** group devices by behaviour. A vendor driver implements one class                                                                                                   |
| DC-2 | **Projector** and **Display** are separate classes. A smart display has navigation keys, apps and more; a driver declares which of these it supports, and the user interfaces follow |
| DC-3 | **Video switching (physical)** and **Video switching (AVoIP)** are separate classes. The AVoIP virtual switcher works out stream locations and sends them to decoders                |
| DC-4 | DSP and similar open-architecture devices use **control points**: the device is added, then the points to control (a gain block, a mute, a router) are added one by one              |
| DC-5 | Templates store **no addresses or credentials**. Bulk creation of many rooms from one template pre-fills them                                                                        |
| DC-6 | Bindings (addresses) live **outside the signed room model**, versioned, with sealed credentials                                                                                       |
| DC-7 | Shared devices are **site-level assets** that rooms reference                                                                                                                         |
| DC-8 | Shared devices that can only serve one room at a time get an **in-use lock** in v1                                                                                                    |
| DC-9 | Vendor order: see "Vendor order"                                                                                                                                                      |

Proposed while planning (open to change): DC-10 the AVoIP encoders and decoders are ordinary devices in the room, not settings of the switcher (see AVoIP). DC-11 the extra display functions live on one opt-in panel page, never on the start or activity screens. DC-12 credentials are stored sealed in the database first, and sealed to each gateway's own key in a later slice.

## Words used here

- **Class**: the contract for a kind of device: commands it accepts, feedback it reports, features it may declare
- **Feature**: an optional part of a class that a driver declares it supports (Display: remote keys, apps)
- **Vendor driver**: one implementation of a class for one protocol. Declarative JSON where possible, coded (TypeScript) where the protocol needs state
- **Design data**: what the room is (driver, ports, component names, preset names). Lives in the template and the signed model
- **Binding**: where this room's copy of a device is (host, port, which physical port it uses). Per room
- **Credential**: a login or key. Kept in a credential set (org or site) or on one binding. Never shown again after it is entered
- **Control point**: one named thing inside a programmable device that Kestrel controls (a gain block, a mute, a router)
- **Site device**: one physical device known to a site, referenced by any number of rooms

## The classes

| Class                        | Commands                                                       | Feedback                                       | Covers                                                          |
| ---------------------------- | -------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| **Projector**                | power, input, blank                                            | power (with warm-up and cool-down), input, lamp hours, fault | Projectors of every technology                                  |
| **Display**                  | power, input, blank, volume and mute; optional keys, apps      | power, input, signal; optional current app     | Flat panels, LED processors, smart and professional displays   |
| **Video switching (physical)** | route in to out, output mute                                 | routes, signal per input                       | Matrix and presentation switchers (Extron, Kramer, Crestron HD-PS) |
| **Video switching (AVoIP)**  | route in to out (works out stream locations)                   | routes, per-decoder stream state               | Virtual switcher over AVoIP endpoints (Crestron NVX, others)    |
| **AVoIP encoder**            | input select, stream on or off                                 | stream location, signal, resolution            | NVX and other encoders                                          |
| **AVoIP decoder**            | set stream, output blank, output mute                          | stream connected, output state                 | NVX and other decoders                                          |
| **Point-based**              | set or recall a control point                                  | point value, meter                             | DSP, lighting processors, building automation (BACnet, KNX)    |
| **Camera**                   | preset recall, pan/tilt/zoom, standby, tracking                | preset, online                                 | PTZ, auto-framing, fixed                                        |
| **Conference system**        | wake or standby, mute, volume, camera, content, hang up        | call state, mute                               | MTR, RoomOS, Poly, Zoom Rooms                                   |
| **Reinforcement microphone** | mute, volume                                                   | mute, level, battery, RF                       | Wireless handheld, lapel and lectern mics that people hear through the room speakers. User-controlled |
| **Conferencing microphone**  | privacy mute (where supported)                                 | mute, battery, RF, fault                       | Ceiling, table and boundary mics that feed the call only. Fixed level, never user-controlled |
| **Recorder or streamer**     | start, stop, pause                                             | state, storage                                 | Lecture capture, encoders                                       |
| **Presentation source**      | wake or standby                                                | connected, sharing                             | Wireless presenters, media players                              |
| **Environmental**            | scene recall, zone level, setpoint                             | scene, temperature                             | Lighting, blinds, HVAC                                          |
| **Relay or mechanical**      | up, down, stop, on, off                                        | position where known                           | Screens, lifters, power outlets, contact closures               |
| **Sensor**                   | none                                                           | occupancy, presence                            | Occupancy sensors, signal detect                                |
| **Infrastructure**           | none                                                           | online, SNMP or HTTP health                    | Switches, PDUs, UPS. Monitoring only                            |

- Classes fold into today's 21 device categories. `reinforcement_mic` and `voice_capture_mic` already exist and map one to one onto the two microphone classes. `video_destination` splits into `display` and `projector` (the old value keeps working and reads as display until a device is edited). The three camera categories map to Camera
- Every class ships with a **simulated device** and a **conformance test** every vendor driver must pass
- Transports a driver may use: TCP, HTTP, serial over IP, WebSocket, SNMP, MQTT. Auth types: none, password, user and password, token or key, digest
- One driver, one class. A protocol used by both kinds (PJLink is used by NEC displays as well as projectors) is registered under its main class, with an alias in the other where the feature set differs
- Existing built-in drivers map as: PJLink to Projector; Cisco RoomOS to Conference system; VISCA to Camera; Extron SIS to Video switching (physical); NVX to Video switching (AVoIP) plus endpoints; Q-SYS to Point-based; Shelly relay to Relay; Lutron to Environmental

## Traits shared across classes

- Projector, Display and the two switching classes share **traits**: power, input select, route, blank, signal detect, volume, mute
- A **Display Group** (members, allowed sources, follow or independent) only ever uses the shared traits, so it can mix projectors and displays
- Extra features (keys, apps, lens) act on **one chosen device**, never a whole group

## Projector

- Power is a state machine: off, warming, on, cooling. The engine already has these states. A projector that is cooling cannot power on: the engine waits for it, without a fixed timer
- Features a driver may declare: `blank` (AV mute or shutter), `freeze`, `lens` (zoom, focus, shift, named lens memories), `light_source_hours`, `filter`, `temperature`, `signal_detect`, `builtin_audio`
- Mostly technical: lens memory recall is an action a dev can add to an activity; hours and faults feed monitoring, not the panel

## Display

- Everything a projector has, without warm-up, plus these features:
  - `remote_keys`: up, down, left, right, OK, back, home, menu
  - `media_keys`: play, pause, stop, forward, rewind
  - `apps`: the list of apps and a launch by app
  - `builtin_audio`: volume and mute of the display's speakers
  - `signal_detect`, `blank`, `wake` (from network standby)
- The driver declares the features. Nothing shows for a feature the driver does not declare, and the room's dev can also switch a feature off
- **Built-in apps are a source.** A smart display gets an internal input port, "Apps", from the driver, so source select, display groups and activities treat it like any other input
- **Apps**: the driver reads the display's app list where the device offers one, or the dev lists them in settings. Kestrel keeps a friendly name, icon and order per app (dev can rename, hide, reorder). Stock icons for known apps, first letter otherwise
- **Sony Bravia (professional)** is the reference driver: REST calls for power, input, apps and volume, plus remote-key codes, authenticated by a pre-shared key. Protocol details to be checked against Sony's documentation at build time

### What the interfaces need

- **Panel:** one new function page, **Display**, behind the top nav. Only present when the room turns it on and a display declares keys or apps. Contents: direction pad with OK, Back, Home, Menu; media keys; app tiles. Arrow keys repeat while held (same idea as volume ramp). With more than one such display, a target chooser at the top ("Left screen", "Right screen") uses the display names
- **Principle carve-out:** the panel rule "activities, never device functions" stays true for the start and activity screens. Keys and apps are device functions, allowed only on this opt-in page. Advanced device tests stay in the tech view
- **Activities:** two new action types, **Launch app** and **Press key**, so a dev can build an activity such as "Digital signage" (power on, launch the signage app)
- **Quick actions:** unchanged. Blank Screen still comes from the driver's `blank`
- **Portal control page, phone page, simulator:** these render the same panel, so they get the page for free. The simulator gets a simulated smart display with a few apps and a key echo
- **Model:** new commands `key`, `media` and `launch_app`; new feedback `activeApp`; a display port for the built-in apps
- **Deploy order:** the gateway runs the engine, so it must be new enough before a release uses new commands. The portal blocks or warns for an older gateway (same lesson as C-14 in `docs/decisions.md`)

## Video switching (physical)

- Everything that switches signals inside one box: matrices (any input to any output) and presentation switchers (few inputs, one or two outputs). Both are `route`; a presentation switcher simply has one output
- Features: `route`, `output_mute`, `signal_detect`, `auto_switch`, `edid`, `audio_embed`
- **Auto-switch conflict:** many switchers pick an input on their own when a signal appears. Kestrel does that itself (signal detect, then choose source, with the prompt and 10 second rule). A driver that declares `auto_switch` must turn the device's own auto-switching off when the room takes control, so the two do not fight
- **Crestron HD-PS series** (presentation switchers) belongs here. Control protocol and models to be confirmed against Crestron documentation before its driver is written

## Video switching (AVoIP)

The mental model, agreed in outline: a virtual switcher that reads the streams the encoders make and points the decoders at them.

- **Endpoints are ordinary devices in the room**: an AVoIP encoder (a laptop's HDMI plate feeds it) and an AVoIP decoder (feeds a display), each with its own binding and login. Encoders and decoders connect to the **virtual switcher** by their network-side ports. The wiring in the room design then reads like the real system: source, encoder, switcher, decoder, display
- The virtual switcher has **no address of its own** (unless a vendor has a controller, in which case the controller's address is its binding). It owns the routing logic only
- **Route in to out** does this, in order:
  1. Ask the encoder for its current stream location (multicast address or stream URL)
  2. Give that location to the decoder
  3. Wait until the decoder reports it is receiving the stream (no fixed wait), then report ready
- Stream locations are **read live and cached**, never typed in. If an encoder's location changes or the encoder comes back after a reboot, the switcher re-points every decoder currently routed to it ("follow the stream")
- The switcher keeps a **desired routes table** and re-applies it after a decoder reboots or a network drop. This also feeds drift detection
- The engine sees a switcher exactly like a matrix (`route` command, `routes` state), so activities and display groups need no change. Encoders and decoders are pass-through hops: the activity generator must walk through them. **To verify in the engine** before building (it is not known whether it handles pass-through devices today)
- **Family:** an encoder, decoder and switcher must come from the same family (`crestron-nvx`, and so on). The validator blocks mixing families. Each family provides three drivers that share the stream-location handshake
- **Transceivers** (a unit that is either encoder or decoder, such as some NVX models): added as an encoder or a decoder, with a setting for the mode
- **Fan-out:** one encoder to several decoders (multicast) needs nothing extra. A driver declares limits (maximum decoders per encoder for unicast systems)
- **Controller-based systems**: some vendors route by name through a controller. Same class, the driver just calls the controller instead of each decoder
- **Crestron NVX today:** the built-in driver is one device whose settings list the encoder and decoder addresses. That works, but hides the endpoints from the design, from signal detect, from sharing and from monitoring. It keeps working for existing rooms (releases pin the driver) and is replaced by the three-driver form for new rooms
- **Shared use:** endpoints are the natural shared devices (an encoder feeding two rooms). Because the switcher is only logic, each room, and each combined room, can have its own switcher over the same site endpoints
- **Creating one:** an "Add AVoIP system" step: choose the family, say how many encoders and decoders, and the switcher plus endpoints are created and wired. Bindings then come from the bulk grid

## Point-based devices (DSP and similar)

- The device is added first (its address and login). The dev then **adds control points**, one at a time
- Kestrel defines a small set of vendor-neutral **point types**:
  - level (min, max, step, and the scale to and from the panel's 0 to 100)
  - mute
  - select (a router block: one of N)
  - crosspoint
  - preset or snapshot recall
  - meter (read-only)
  - generic control
- Each vendor driver declares the **address form** for each point type. Examples to confirm at build time: Q-SYS asks for a named component and its control; Tesira for an instance tag, attribute and index; Soundweb for a node and object; Symetrix and Extron for a control or ID number
- A point gets a **role** in the room: room volume, privacy mute, reinforcement mic level, reinforcement mic mute, conferencing mic privacy mute, program mic, zone select, signal detect for input 1, and so on. Roles are how points connect to activities and to the panel's volume and mute
- **Verify on add:** the gateway reads the point, confirms it exists, and returns its range and current value (to fill min and max). Where a vendor lets the device list its components, the form offers a pick-list. A later read failure raises "control point missing", which catches someone changing the DSP program
- **Templates:** component names belong to the DSP program design. Ten rooms on the same DSP file share the same names, so points are **design data** and travel with the template. Only the DSP address and login are bindings
- Record which DSP program version a point map was made for
- The gateway holds **one connection per DSP**, subscribes to points in a batch, and fans feedback out to the rooms (this matters once a DSP serves several rooms)
- The same shape suits lighting processors, BACnet, Modbus and KNX group addresses. The class is Point-based; DSP is its main member
- Not built: importing a component list from a file

## Microphones: reinforcement and conferencing

Two classes, because they are used by different people for different reasons. Both share the monitoring basics (mute state, battery, RF, fault).

| | **Reinforcement** (wireless, lectern) | **Conferencing** (ceiling, table) |
| --- | --- | --- |
| Heard in the room | Yes, through the room speakers | No. Feeds the call only |
| Level | **Volume control for the user**, per mic | **Fixed**, set when the room is commissioned. No user control |
| Mute | User mute, per mic | **Privacy mute** only, where supported |
| On the panel | Microphones page, each mic under a friendly label | Only through the Privacy Mute quick action. Never listed as a mic |
| With the system | **Muted when the system is off, unmuted when it is on** (default) | Left as it is. Privacy mute is the user's choice |

### Reinforcement microphones

- **Volume and mute are the user's.** Volume follows the panel rules: − and + (tap, hold to ramp), no slider, 0 to 100 from the device range where there is feedback, default 50 unless the room says otherwise
- **Friendly labels** are set in the portal ("Lectern mic", "Handheld 1"), separate from the technical device name. The label is what the panel and phone page show. The portal also sets the order and can hide a mic. Labels are translatable later, with the rest of the room's text
- **Muted with the system off, unmuted with it on**, as a default. Two per-mic settings can change it: what happens when the room turns on (unmute, the default; leave; mute) and when it turns off (mute, the default; leave). An activity can override the mic for its own run (for example, keep reinforcement mics muted during a video call). When a room resumes from a suspended combined state it re-reads the device first (C-8), so the default only applies to real on and off changes
- **How a mic is controlled** is a per-mic choice:
  - through its **own driver** (a wireless system that can mute and report battery and RF), or
  - through **DSP control points** with the roles "reinforcement mic level" and "reinforcement mic mute" (the usual case: the receiver is not touched, the DSP channel is)
- Battery and RF feed monitoring and alerts either way ("Lectern mic battery low"), even when the mic is not user-controllable
- Mic level and mute state show on the panel only when there is feedback; otherwise the mute button shows the last thing Kestrel sent and a short note in the tech view says it is unconfirmed

### Conferencing microphones

- **Fixed level.** The level is a design setting (or a DSP point set once), never a user control and not on the panel
- **Never sent to the room speakers.** The validator warns when a conferencing mic is routed to a room audio output. They may feed the DSP's echo reference and the conference system only
- **Privacy mute** is a driver feature (`privacy_mute`), from the mic's own driver, a DSP point with the role "conferencing mic privacy mute", or the conference system's own mic mute. The **Privacy Mute quick action** acts on every conferencing mic that supports it, plus the conference system where its driver declares `mic_mute`, and shows their combined state. If nothing in the room supports it, the button does not appear (as today)
- A conferencing mic that cannot mute is still monitored (fault, battery, online). It just adds nothing to Privacy Mute
- Level drift is a monitoring signal: if a fixed level changes, the portal can flag it

### Effect on what exists

- The categories `reinforcement_mic` and `voice_capture_mic` already exist. Today the panel's Microphones page lists **both** with a mute button (`packages/engine/src/runtime/functions.ts`), and Privacy Mute already looks only at `voice_capture_mic`
- After this change the Microphones page lists **reinforcement mics only**. A conferencing mic that used to have a button there will disappear from that page and act only through Privacy Mute. The engine is not pinned by a release, so this changes running rooms when their gateway updates. Call it out in the release notes
- The catalog gains `volume` for reinforcement mics and a `privacy_mute` feature for conferencing mics. The existing `volume` and `mute` commands and the `volume` and `muted` feedback already cover the rest. Per-mic labels, order, hidden flag and the on and off behaviour are new room-model fields, all with defaults, so old rooms are valid
- `docs/panel-ui-requirements.md` (Microphones page, Privacy Mute) needs updating when this is built

## Conference system (Cisco RoomOS and Webex)

- Cisco Webex Room, Board and Desk devices run RoomOS, so **Webex and RoomOS are one driver family**. The existing built-in driver (`lib:cisco-roomos`) uses the HTTP `/putxml` API for standby, microphone mute, volume and hang up. The plan is to **extend it to the xAPI** (xCommand, xStatus, xConfiguration) rather than add a second driver
- The xAPI is well documented, so this is the reference driver for the class. It suits both **control** (xCommand: standby, dial, hang up, volume, mute, camera presets, content share) and **monitoring** (xStatus: call state, registration, peripherals, microphone and camera health, and xFeedback for changes without polling)
- Access is local, from the gateway to the device's own address, with a local user account. That fits the outbound-only rule. A device registered to the Webex cloud is still controlled locally. Cloud-side APIs (Control Hub) are out of scope
- Features the class may declare: `standby`, `mic_mute`, `volume`, `dial`, `hangup`, `camera_control`, `content_share`, `call_state`, `registration_status`, `peripheral_health`. The panel's Privacy Mute already comes from `mic_mute`
- Transport choice (HTTP, WebSocket or SSH) and which xAPI calls to use are decided when the driver is built, from Cisco's documentation

## Monitoring-only mode (proposed, pending the tier decision)

The user is considering swapping the tiers: **monitoring only** in the low or free tier, **control plus monitoring** in Pro, so an organisation with an existing AV installation can use Kestrel just to watch it. That is a big change to a rule in the code today (control is never switched off by billing, and monitoring is the Pro extra: `packages/model/src/billing.ts`). This section only records what it would mean for drivers and classes. Billing itself is **not** changed by this plan.

- **A monitored room is a light room:** devices with drivers and bindings, no ports, connections, activities or panel. No signed manifest or deploy is needed, just the device list, the bindings and the alert rules
- **Every class needs a read-only mode.** Feedback and health always work; commands are refused. The refusal is enforced **in the gateway**, not only hidden in the portal, so a monitored room can never send a command by any route (panel, trigger, webhook, API)
- **Existing control system, existing sessions.** The installation being watched is usually run by someone else's control system (Crestron, Extron, a Q-SYS design). Two dangers:
  - Devices that allow one session (codecs, some matrices) could be **kicked off** by Kestrel's connection. Each driver declares `sessions` (single or multiple), and a single-session device is monitored by polling with short connections, or is flagged "cannot be monitored alongside another controller" so it is not connected by surprise
  - Polling adds load. Each driver declares a minimum polling interval, and the gateway enforces it
- **Read-only credentials.** Where a device supports a read-only account (RoomOS does), the setup step asks for it and says why
- **Devices with no useful feedback** (a projector with no network port) cannot be monitored. The class shows what each driver can report so the portal can say so before someone adds it
- **Control points become read-only points** (the meter and value types). A DSP can be monitored without anyone deciding what its roles are
- **Discovery matters more.** Monitoring an existing installation starts from "what is on the network", so the discovery slice (currently "later") moves up if this tier goes ahead
- **Upgrading a room** from monitored to controlled means adding the design (ports, connections, activities) on top of the same devices and bindings. Devices are not re-entered. This favours the site device model (slice 6), so it should be designed with it
- **Downgrading** (Pro to monitoring only) is the mirror of the note in `CLAUDE.md` about Trial: control switches off per room without disturbing monitoring. Rooms keep their design; commands are refused until control is licensed again
- **Code that would change if this goes ahead** (not part of this plan): `entitlementsFor` (control is typed as always true), `PLAN_FEATURES`, `FEATURE_PLAN`, the trial and lapse fallbacks, the staff licence override (it can force monitoring but not control), the `CLAUDE.md` tier text, and the gateway's command path
- **Open questions for the tier decision:** what the low tier is called and costs (free or cheap); room limits and telemetry retention per tier (90 days today); whether alert channels are limited on the low tier; where the marketplace and custom drivers sit; what a lapsed Pro organisation falls back to

## Design, binding and credential data

- Every driver setting is tagged with a **scope**: `design`, `binding` or `secret`
  - design: component names, preset names, scale (goes in the template and the signed model)
  - binding: host, port, serial number, which physical port (per room)
  - secret: passwords, keys, tokens (sealed, write-only)
- Today's state (checked in the code): `Device.settings` is one free-form bag, stored as-is in the room model, copied into releases (signed but **not encrypted**), and stripped only by marketplace publishing. Org templates appear to copy the model as-is (the save-as-template path is **to verify**)

### Where each thing lives

| Data       | Where                                                                                       | Reaches the gateway as                        |
| ---------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Design     | Room model, in the release, in templates                                                    | The signed manifest, as today                 |
| Binding    | New per-room **binding set** (versioned). A device references a site device where shared    | A separate signed binding message             |
| Credential | **Credential sets** (org or site) or on one binding, sealed with `KESTREL_SECRETS_KEY` (`packages/crypto/src/seal.ts`) | Inside the binding message, sealed |

- The gateway merges binding over design to build each device's settings. If a binding does not cover something, an old inline setting is the fallback, so existing releases keep working
- **New publishes leave binding and secret settings out of the manifest.** An older gateway would then have no address, so the portal must refuse to deploy such a release to a gateway older than the build that understands bindings
- Changing an IP or rotating a password becomes a binding push: **no new release**, no change to the release hash. The gateway reports its binding version in the heartbeat so the portal can show "binding pending" next to the existing "pending deploy" and "drifted"
- Credential sets: change one, and every device using it gets the new value on the next sync
- Credentials are **write-only**: the browser is never sent one, only "set" or "not set"
- **Later slice (DC-12):** each gateway makes a key pair when it enrols, and the cloud seals credentials to that key, so a database leak or a Kestrel-side breach alone reveals nothing usable. First version relies on database sealing plus TLS to an authenticated gateway

### When things are entered

| Moment                        | What is entered                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| Designing a room or template  | Nothing about addresses. Devices appear as **slots** with the binding fields their driver needs          |
| Creating a room from template | The room starts as **Needs setup**. Bindings are entered in the setup step or in the bulk grid           |
| Deploying                     | The validator blocks deploy until every required binding is set                                          |
| Commissioning                 | **Test connection** per device: the gateway connects and runs the driver's identify (and verifies control points). It informs, it does not block saving |

- Per-device status: unbound, bound and untested, verified, failing

### Templates

- A template stores **slots**, not values: driver, class, ports, design data, and the list of binding fields required (with non-secret defaults such as port 4352)
- **Save as template** strips binding and secret values by default (as marketplace publishing already does)
- **Duplicate room** copies the design and clears bindings
- A template is a copy: a room created from it is not linked to it afterwards (as today)

### Bulk creation ("add 10 of the same room")

- A **Create rooms from template** wizard with a grid: one row per room, one column per slot (display host, DSP host, camera host, and so on) plus a name column
- Fill options: name pattern ("Room {n}"), start address with a step per room for each slot, a default credential set for each slot
- **Paste from a spreadsheet** or **import CSV**. The wizard offers a blank CSV for whoever holds the IP schedule
- Checks before creating: duplicate addresses, addresses the gateway cannot reach, missing required columns. **Test all** runs the connection test for every row
- Re-importing the CSV matches rooms by name, so it can update existing rooms instead of creating new ones
- For an AVoIP system the grid gets one row per encoder and decoder
- Later: discovery from the gateway (mDNS, PJLink, Q-SYS, NVX) proposing addresses for the slots

## Shared devices

Cases: shared control (a matrix or DSP serving two rooms), shared monitoring only (a network switch), and combined rooms.

### What is true today

- A combined room copies its member rooms' devices in with prefixed ids (`docs/room-groups.md`). The same physical device therefore has several room definitions and, since a suspended room keeps its connections open (C-7), several connections
- Devices that allow only one connection are not supported in that case (C-7 says so)
- The group simulator gives every room its own simulated equipment, so sharing is not modelled (C-23)

### The model

- **Site device** = the physical device: identity, class, driver and pinned version, address, credential, health. One per physical device
- A room device is either **room-private** (a site device with one referrer) or a **reference** to a site device, plus the room's slice of it:
  - a port mapping (this room uses matrix outputs 3 and 4, or DSP zone 2)
  - its own control points, which are design data of that room
- In a template a shared slot is filled by **picking an existing site device**, then giving the port mapping. That is a binding, so nothing shared leaks into templates
- Combined rooms **reference** the same site devices instead of copying them, which removes the duplicate connections

### Gateway

- One driver instance and one connection per site device (a "device host"). Rooms attach to it. Commands are queued. Feedback fans out to every referencing room
- A room's commands are only accepted for the ports and points in its slice
- All rooms sharing a device must run on the **same gateway** (same rule as room groups, C-5). The validator enforces it

### Conflicts and locks

- Slices are partitioned per room, so most conflicts cannot happen
- Two rooms declaring the same control point or output: the validator warns, and blocks unless the point is read-only (a meter)
- A slot marked **exclusive** (a shared codec or recorder) gets an **in-use lock** (DC-8): while one room is using it, another sees "In use by Room B" and is refused. Not exclusive by default. A dev can override the lock from the tech view. Locks are held in the gateway, in memory, like the restore state (C-10)

### Versioning, monitoring, billing

- The shared device's driver version is pinned at **site** level. Changing it marks every referencing room "pending deploy"; deploy them together (the existing group deploy pattern)
- Health is attached to the site device once. One incident, listed against each referencing room
- Billing stays per room. A shared device is not an extra charge
- Editing or deleting a site device shows the rooms that reference it first

## Vendor order

Starting suggestion (DC-9). Built ones in bold.

| Class                          | First                                                        | Then                                            |
| ------------------------------ | ------------------------------------------------------------ | ----------------------------------------------- |
| Projector                      | **PJLink**                                                   | Epson, NEC, Panasonic                           |
| Display                        | Sony Bravia professional                                     | Samsung MDC, LG                                 |
| Video switching (physical)     | **Extron SIS**, Crestron HD-PS                               | Kramer                                          |
| Video switching (AVoIP)        | **Crestron NVX** (reshaped into encoder, decoder, switcher)  | Others by demand (Q-SYS AV, Just Add Power, Extron NAV, SDVoE) |
| Point-based                    | **Q-SYS** (extended to control points), Biamp Tesira         | Extron DMP, BSS Soundweb                        |
| Camera                         | **VISCA over IP**, Panasonic, Sony                           | PTZOptics                                       |
| Conference system              | **Cisco RoomOS and Webex** (extend to the full xAPI), Poly   | Zoom Rooms, Teams rooms where an API exists     |
| Environmental, relay           | **Lutron**, **Shelly**                                       | Others by demand                                |

## Build order

Each slice is additive, keeps signed releases valid, and ships behind tests. Slices 2 and 3 are the ones that answer the template and bulk questions.

1. **Foundations.** `class` and `features` on drivers, `display` and `projector` categories, `scope` on driver settings. No behaviour change
2. **Bindings and credentials.** Binding sets, credential sets, merge in the gateway, "Needs setup", test connection, template stripping, deploy-order guard
3. **Bulk create.** Grid, spreadsheet paste, CSV, auto-increment, test all
4. **Display extras and microphones.** Display: new commands and feedback, apps as an internal source, Sony Bravia driver, panel Display page, Launch app and Press key actions, simulator. Microphones: the reinforcement and conferencing split, labels and order in the portal, volume and mute on the Microphones page, mute with the system state, Privacy Mute across mics and the conference system, simulator
5. **Point-based.** Control points, roles, verify, Q-SYS refactored onto points, Tesira
6. **Shared devices.** Site devices, references and port mappings, gateway device host, in-use lock, combined rooms reference instead of copy
7. **AVoIP split.** Encoder, decoder and switcher drivers, live stream locations, desired-routes table, "Add AVoIP system", Crestron NVX reshaped, engine pass-through if needed
8. **Vendor drivers** from the table above, each passing its class conformance test
9. **Later:** gateway-sealed credentials (DC-12), discovery, DSP component import

## Risks

- **Deploy order.** New commands and binding-only releases need an updated gateway. Gate on gateway version, as in C-14
- **Engine pass-through.** AVoIP endpoints only work if the activity generator can route through devices that have no route command. Check first
- **Migration.** Existing rooms have addresses inline. Reads must keep working until each room is re-published
- **Microphone page change.** Conferencing mics leave the Microphones page in rooms that already show them (see "Effect on what exists")
- **Unmute on start.** A reinforcement mic that unmutes whenever the room turns on can surprise a lecturer whose mic is live and open. The panel should show mic state clearly on the activity screen, and the per-mic setting lets a dev choose "leave" instead
- **Auto-switch.** A switcher's own auto-switching fights Kestrel's signal-detect logic unless the driver turns it off
- **Protocols not yet checked.** Crestron HD-PS control, Sony Bravia app and key calls, and every "examples to confirm" above are from general knowledge, not from vendor documents, and must be checked before each driver is built
- **One-connection devices.** Solved only for devices that go through the shared device host (slice 6). Until then C-7 still applies

## Not in this plan

- Custom logic hooks, third-party driver marketplace, Windows installer timing
- Inbound remote access to devices (the gateway stays outbound-only)
- Import of DSP programs

## For review: things to confirm

1. AVoIP endpoints as ordinary devices (DC-10), instead of settings of the switcher. Yes
2. The Display page placement and the carve-out from the intent-only principle (DC-11). Yes
3. Slot and binding wording in the portal ("Needs setup", "binding pending"). Needs setup
4. First release of vendors (table above). Anything to add or drop. Go
5. Should **Duplicate room** also offer "keep addresses" for the case where someone genuinely wants the same equipment (for example a spare room)? Proposed: no 
6. Monitoring-only mode: is the section above the right shape, and should discovery move up if the tier swap goes ahead
7. Microphones: the on and off defaults (unmute on, mute off) and the per-activity override, and that conferencing mics disappear from the Microphones page
