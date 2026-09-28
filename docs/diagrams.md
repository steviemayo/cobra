# Kestrel — Workflow & Pipeline Diagrams (Mermaid)

> Brought up to date with what is built on 2026-09-28 (sections 2, 3, 4, 8, 9, 23 and 25 were rewritten; 27 to 30 are new). **[A]** marks an assumption or something not built. Renders in GitHub/VS Code Mermaid preview. Decisions behind each diagram: `docs/decisions.md`; build status: `docs/plan.md`.

## 1. System Components

```mermaid
flowchart LR
  subgraph Cloud
    WEB[Next.js Web Portal<br/>Vercel]
    API[tRPC API<br/>Vercel functions]
    DB[(Supabase Postgres)]
    AUTH[Supabase Auth]
    STORE[(Supabase Storage<br/>release bundles)]
    RT[Supabase Realtime]
    STRIPE[Stripe]
  end
  subgraph Site["Customer Site (LAN)"]
    GW[Gateway<br/>container: Linux/Windows]
    RUN[Room Runtimes<br/>1 per room]
    UI[Panel Web UI<br/>served by gateway]
    DEV[Room Devices<br/>displays, DSP, matrix, etc]
    PANEL[Touch Panels<br/>Crestron/tablet browser]
  end
  WEB --> API --> DB
  WEB --> AUTH
  API --> STORE
  API --> STRIPE
  STRIPE -- webhooks --> API
  GW -- outbound HTTPS/WSS only --> API
  GW <-. WSS push [A, not built] .-> RT
  GW --> STORE
  GW --- RUN --- DEV
  GW --- UI
  GW --- LOCAL[Gateway pages<br/>status + admin code]
  PANEL -- HTTP/WS on LAN --> UI
  TECH[Person on site] -- HTTP on LAN --> LOCAL
  UI --> RUN
```

## 2. Gateway Enrollment (provisioning)

Two ways in. Both end with the ordinary one-time-token enrolment; the second exists so an install with no token is visible instead of silently failing (`docs/decisions.md` T-1 to T-5).

```mermaid
sequenceDiagram
  actor Admin
  actor Staff
  participant Portal
  participant API
  participant GW as Gateway (new)
  Note over Admin,GW: A. The customer has a token
  Admin->>Portal: Create gateway in Site
  Portal->>API: gateway.create
  API-->>Portal: one-time enrolment token
  Admin->>GW: Install + set token (env, installer or /admin page)
  GW->>API: enroll(token, hostname, version)
  API->>API: validate token, bind to org/site, burn token
  API-->>GW: gateway id + long-lived credential + public keys
  Note over Admin,GW: B. Installed with no token (or a used or expired one)
  GW->>API: announce(installId, secret, hostname, os, local IPs) every minute
  API->>API: store as unclaimed, hash the secret, note the public IP
  Staff->>Portal: Staff > Unclaimed gateways, confirm with the customer
  Staff->>API: assign to org, site and name (staff audit + org audit)
  API->>API: make a pending gateway and a sealed enrolment token
  GW->>API: announce again (same install secret)
  API-->>GW: token, repeated until the gateway has enrolled
  GW->>API: enroll(token) as in A
  Note over Admin,GW: Either way
  GW->>API: heartbeat (status=online)
  API-->>Portal: gateway shows Online
```

## 3. Deploy Pipeline (authoring → live room)

```mermaid
sequenceDiagram
  actor Dev
  participant Portal
  participant API
  participant Store as Storage
  participant GW as Gateway
  participant RT as Room Runtime
  Dev->>Portal: Edit room program (draft)
  Dev->>Portal: Validate / lint / simulate
  Dev->>Portal: Publish release vX.Y.Z (immutable)
  Portal->>API: release.create
  API->>API: build bundle (program + UI + manifest), hash, sign
  API->>Store: upload bundle
  Dev->>Portal: Deploy release to Room/Gateway (opt: channel/schedule)
  Portal->>API: deployment.create (status=pending)
  API-->>GW: next heartbeat reply (WSS push is not built)
  GW->>Store: download bundle
  GW->>GW: verify hash + signature
  GW->>GW: stage alongside current version
  GW->>RT: start new runtime (staged)
  GW->>GW: health check (device connect, self-test)
  alt room starts (unreachable devices only warn: they become a monitoring incident)
    GW->>RT: switch traffic, stop old runtime
    GW->>API: report deployment=active
  else bad signature or hash, missing addresses, gateway too old, room cannot start
    GW->>GW: keep the previous version
    GW->>API: report deployment=failed or rolled_back + reason
  end
  API-->>Portal: status + logs shown to Dev
```

## 4. Deployment State Machine

The gateway reports `downloading`, `verifying`, `staging`, `health_check`, `active`, `failed` and `rolled_back` (`DeploymentStage`); the cloud adds the states that need no gateway.

```mermaid
stateDiagram-v2
  [*] --> Pending
  Pending --> Downloading: gateway takes it (next heartbeat)
  Downloading --> Verifying
  Verifying --> Staging: hash + signature ok
  Verifying --> Failed: bad hash/sig, missing addresses, gateway too old
  Staging --> HealthCheck
  HealthCheck --> Active: room starts (devices that did not answer only raise an incident)
  HealthCheck --> RolledBack: room cannot start, previous release kept
  Pending --> Cancelled: user cancels
  Pending --> Expired: gateway offline > TTL
  Active --> Superseded: newer deploy active
  Failed --> [*]
  RolledBack --> [*]
  Cancelled --> [*]
  Expired --> [*]
  Superseded --> [*]
```

## 5. Runtime: Panel Interaction (LAN, works offline)

```mermaid
sequenceDiagram
  actor User
  participant Panel as Touch Panel (browser)
  participant UI as Gateway Panel UI Server
  participant RT as Room Runtime
  participant Dev as Device Driver
  participant HW as Room Hardware
  Panel->>UI: GET /room/{id} (URL loaded on panel)
  UI-->>Panel: web UI bundle
  Panel->>UI: open WebSocket
  User->>Panel: tap "Display On"
  Panel->>UI: event {join: display.power, value: on}
  UI->>RT: dispatch event
  RT->>Dev: power(on) via driver
  Dev->>HW: protocol cmd (TCP/serial/IP/PJLink…)
  HW-->>Dev: feedback
  Dev-->>RT: state update
  RT-->>UI: state broadcast
  UI-->>Panel: UI updates (feedback)
```

## 6. Monitoring / Telemetry

```mermaid
sequenceDiagram
  participant RT as Room Runtime
  participant GW as Gateway Core
  participant Buf as Local Buffer (SQLite) [A]
  participant API
  participant DB
  participant Portal
  loop every N sec
    RT->>GW: device states, health scores, events
    GW->>Buf: append
  end
  loop heartbeat (30s) [A]
    GW->>API: heartbeat(states, events, versions, sysinfo)
    API->>DB: upsert state, insert events
    API->>API: evaluate alert rules
    API-->>GW: pending commands (deploy, diag, config)
  end
  API-->>Portal: live status (Realtime subscription)
  Note over GW,Buf: Cloud unreachable → buffer locally, replay on reconnect. Rooms keep running.
  API->>API: threshold breach → incident
  API-->>Portal: alert (email/Teams/webhook/ITSM stub)
```

What a heartbeat carries per device: online, driver, **feedback** (power, input, mute, ... each change also logged for the history chart), **firmware**, and **details** (see 30). A gateway is never sent a reply it cannot read: it advertises `features` in the heartbeat (`bindings`, `self-update`, ...).

## 7. Remote Command / Diagnostics

```mermaid
sequenceDiagram
  actor Support
  participant Portal
  participant API
  participant GW
  Support->>Portal: Run diagnostic / reboot device / fetch logs
  Portal->>API: command.create (audited)
  API-->>GW: command via WSS or next heartbeat
  GW->>GW: execute (allowlisted actions only)
  GW->>API: result + output
  API-->>Portal: result shown
```

A gateway **update** is not a command (commands are room-scoped and an older gateway cannot read new types): it is desired state on the gateway record, see 27.

## 8. Core Domain Model (main entities as built)

```mermaid
erDiagram
  ORG ||--o{ MEMBER : has
  ORG ||--o{ SITE : owns
  ORG ||--|| ORG_BILLING : billed_by
  SITE ||--o{ GATEWAY : hosts
  SITE ||--o{ ROOM : contains
  SITE ||--o{ SITE_DEVICE : shares
  GATEWAY ||--o{ ROOM : runs
  ROOM ||--o{ ROOM_DRAFT : edited_as
  ROOM ||--o{ RELEASE : versions
  RELEASE ||--o{ DEPLOYMENT : deployed_as
  ROOM ||--o{ DEPLOYMENT : targets
  DEPLOYMENT ||--o{ DEPLOYMENT_EVENT : stages
  ROOM ||--o{ DEVICE_STATUS : reports
  GATEWAY ||--o{ GATEWAY_EVENT : emits
  ROOM ||--o{ INCIDENT : raises
  INCIDENT ||--o{ ALERT_DELIVERY : notifies
  ORG ||--o{ ALERT_CHANNEL : configures
  GATEWAY ||--o{ REMOTE_COMMAND : receives
  ROOM_GROUP ||--o{ ROOM : joins
  ROOM_GROUP ||--o{ ROOM_DIVIDER : has
  ORG ||--o{ TICKET : opens
  ORG ||--o{ AUDIT_LOG : records
  ORG ||--o{ MSP_GRANT : grants_to_provider
  UNCLAIMED_GATEWAY }o--o| GATEWAY : claimed_as
  STAFF_USER ||--o{ STAFF_AUDIT : writes
  ORG ||--o{ JOIN_REQUEST : receives
  ORG ||--o{ CUSTOM_DRIVER : owns
```

Devices, ports, connections, groups and activities live inside the room's draft and signed release (the model, diagram 12), not as tables.

## 9. Kestrel's Own CI/CD (Vercel + Supabase + Gateway image)

```mermaid
flowchart LR
  PR[Feature branch PR] --> CI[CI: lint, typecheck, test, prisma validate]
  CI --> PREV["Vercel Preview Deploy<br/>+ Supabase preview branch [A]"]
  PREV --> REVIEW[Review] --> MERGE[Merge to main]
  MERGE --> MIG[prisma migrate deploy run by hand<br/>never in the Vercel build]
  MIG --> PROD[Vercel Production]
  MERGE --> BUMP[version-bump check:<br/>gateway, panel or bundled package changed<br/>means GATEWAY_VERSION changed]
  BUMP --> IMG[Build gateway image + Windows bundle<br/>GitHub Actions]
  IMG --> REG[(GHCR image + release asset)]
  REG --> CH[Gateway release channel<br/>stable / beta]
  CH --> GWUP[Portal orders the update<br/>see 27]
```

Deploy the web app before gateways. Gateway image and bundle builds skip changes that only touch `packages/db`.

## 10. Billing Flow

```mermaid
sequenceDiagram
  actor Owner
  participant Portal
  participant API
  participant Stripe
  Owner->>Portal: Choose plan
  Portal->>API: billing.checkout
  API->>Stripe: create Checkout Session
  Stripe-->>Owner: hosted checkout
  Stripe-->>API: webhook checkout.completed
  API->>API: activate subscription, set limits (rooms/gateways)
  Stripe-->>API: webhook invoice.paid / payment_failed
  API->>API: update status, enforce limits / grace period
```

---

# Room Modelling (system-architecture-driven)

## 11. Room Authoring Workflow

```mermaid
flowchart TD
  A[New Room] --> B{Start from?}
  B -->|Template| C[Pick Room Template<br/>e.g. Std Meeting Room]
  B -->|Blank| D[Pick Room Type<br/>Meeting / Training]
  C --> E
  D --> E[Type supplies default behaviours<br/>+ suggested device slots]
  E --> F[Add devices logically<br/>sources, destinations, DSP, matrix, conf, env, mech]
  F --> G[Define connection points<br/>Laptop→VidIn1, Display→Out1 ...]
  G --> H[Define groups<br/>Display Group 1 = Disp1+Disp2<br/>follow / independent, allowed sources]
  H --> I[Define states<br/>Off / On / custom: routes, DSP presets, actions]
  I --> J[Validate model graph<br/>unconnected ports, invalid routes, missing drivers]
  J -->|errors| F
  J -->|ok| K[Derived logic preview<br/>auto-generated routing + panel UI]
  K --> L[Optional: override rules / custom logic hooks]
  L --> M[Publish release] --> N[Deploy to gateway]
```

## 12. Room Model (class diagram)

```mermaid
classDiagram
  class RoomType { +id; +name (Meeting|Training); +defaultBehaviours; +slotSuggestions }
  class RoomTemplate { +id; +roomType; +baseModel }
  class Room { +id; +name; +roomType; +templateId? }
  class Device { +id; +category; +driverId; +address/credentials; +config }
  class Port { +id; +direction (in|out); +signal (video|audio|control|usb); +label }
  class Connection { +fromPort; +toPort; +signal }
  class Group { +id; +kind (DisplayGroup|AudioZone|...); +mode (follow|independent); +members[]; +allowedSources[] }
  class State { +id; +name (Off|On|custom); +trigger }
  class Action { +type (route|dspPreset|deviceCmd|delay|env); +params }
  class Rule { +when; +then[]; +priority }
  class Driver { +id; +version; +capabilities; +match() }
  RoomType "1" --> "*" RoomTemplate
  RoomTemplate "1" --> "*" Room : seeds
  Room "1" *-- "*" Device
  Device "1" *-- "*" Port
  Room "1" *-- "*" Connection
  Room "1" *-- "*" Group
  Room "1" *-- "*" State
  State "1" *-- "*" Action : ordered
  Room "1" *-- "*" Rule
  Device --> Driver
  Group --> Device : members
```

Device categories: video source, audio source, conf camera, fixed camera, PTZ camera, auto-framing camera, reinforcement mic, voice-capture mic, conference system (MTR/Codec), video matrix (virtual/physical), audio matrix/DSP, video destination (display/projector/recorder/output), audio destination (speaker/output), conference output, environmental (lighting/HVAC/blinds), mechanical (lifter/screen).

## 13. Example Signal Graph (the "90% room")

```mermaid
flowchart LR
  L1[Laptop 1] --> V1((Vid In 1))
  L2[Wireless Presenter] --> V2((Vid In 2))
  subgraph MX[Video Matrix]
    V1 --> R{Routing}
    V2 --> R
    R --> O1((Out 1))
    R --> O2((Out 2))
  end
  subgraph DG1[Display Group 1 — follow / independent]
    O1 --> D1[Display 1]
    O2 --> D2[Display 2]
  end
  L1 -. embedded audio .-> DSP[DSP]
  L2 -. embedded audio .-> DSP
  MIC[Mics] --> DSP
  DSP --> SPK[Speakers]
```

- Groups own source-select logic; matrix routes are _derived_ from the model, not hand-written.

## 14. Model → Logic Compile Pipeline

```mermaid
flowchart LR
  M[Room Model<br/>devices, ports, connections, groups, states] --> V[Validator<br/>graph checks]
  RT[Room Type behaviours<br/>Meeting / Training] --> G
  V --> G[Logic Generator<br/>derive route tables,<br/>source-select, group modes,<br/>power sequencing, auto-mute]
  R[Custom Rules / hooks] --> G
  DRV[Driver capabilities] --> G
  G --> P[Room Program<br/>JSON manifest + generated UI]
  P --> B[Signed Release Bundle]
```

- Runtime = generic interpreter of the room program (no code-gen of per-room source)
- Edge cases handled by: custom rules → custom logic hook (sandboxed script) → escape hatch **[A]**

## 15. Runtime: Source Select on a Display Group

```mermaid
sequenceDiagram
  actor User
  participant Panel
  participant RT as Room Runtime
  participant MX as Matrix Driver
  participant D1 as Display 1
  participant D2 as Display 2
  User->>Panel: select Laptop 1 on Display Group 1
  Panel->>RT: selectSource(group=DG1, src=L1)
  RT->>RT: group mode? follow → apply to all members
  RT->>MX: route(In1 → Out1, Out2)
  RT->>D1: power on + input (if needed)
  RT->>D2: power on + input (if needed)
  MX-->>RT: route feedback
  RT-->>Panel: state update
  Note over RT: independent mode → only target member routed
```

## 16. State Recall (Off / On / custom)

```mermaid
stateDiagram-v2
  [*] --> Off
  Off --> Starting: user/schedule/occupancy → On
  Starting --> On: actions done (displays on, route default, DSP preset, env scene)
  On --> Stopping: user/schedule/timeout → Off
  Stopping --> Off: actions done (mute, routes cleared, displays off, blinds/lights)
  On --> Custom: recall named state (e.g. Presentation, VC, Split)
  Custom --> On
  Starting --> Fault: action failed
  Stopping --> Fault: action failed
  Fault --> Off: recover
```

- State = ordered Action list (route, DSP preset, device cmd, delay, env), each with success/fail + timeout

---

# Functional (Intent-Based) UI

## 17. UI Layering

```mermaid
flowchart TB
  U[User UI<br/>Activities only: Present, Record, Call, Off] --> AE[Activity Engine<br/>intent → ordered actions]
  AE --> RM[Room Model<br/>groups, routes, states, presets]
  RM --> DRV[Device Drivers]
  T[Tech / Support View<br/>PIN/role gated, per-device controls] --> RM
  TR[Triggers<br/>tap, signal-detect, schedule, occupancy, calendar] --> AE
```

## 18. Activity Definition → Generated UI

```mermaid
flowchart LR
  RT[Room Type<br/>Meeting / Training] --> LIB[Activity Library]
  MODEL[Room Model<br/>available capabilities] --> FILTER{Required capabilities present?}
  LIB --> FILTER
  FILTER -->|yes| ACT[Activity enabled<br/>label, icon, action sequence, defaults]
  FILTER -->|no| HIDE[Activity hidden]
  ACT --> DEVEDIT[Dev can rename / hide / reorder / tweak defaults]
  DEVEDIT --> UIGEN[Generated Panel UI<br/>big buttons, plain language]
```

## 19. Example: "Present from Laptop" (1 tap)

```mermaid
sequenceDiagram
  actor User
  participant Panel
  participant AE as Activity Engine
  participant D as Displays
  participant MX as Matrix
  participant DSP
  User->>Panel: tap "Present Laptop"
  Panel-->>User: "Starting… ready in ~20s"
  par in parallel
    AE->>D: power on + set input
    AE->>MX: route Laptop → Display Group
    AE->>DSP: recall "Presentation" preset, laptop audio on
    AE->>D: lower screen / projector lift (if present)
  end
  AE-->>Panel: ready (or plain-language fault)
  Note over AE: no signal? → "Plug in your laptop HDMI cable"
```

## 20. Example: "Record Lecture" (1 tap, or auto)

```mermaid
sequenceDiagram
  actor Lecturer
  participant Panel
  participant AE as Activity Engine
  participant CAM as Camera(s)
  participant DSP
  participant PRJ as Projector + Route
  participant REC as Recorder
  Lecturer->>Panel: tap "Record Lecture"
  par
    AE->>CAM: recall default preset / enable auto-framing
    AE->>DSP: recall "Lecture" preset, unmute lectern + voice-capture mics
    AE->>PRJ: power on, route presenter source
    AE->>REC: route mix (camera + content + audio)
  end
  AE->>REC: start recording
  AE-->>Panel: "Recording — mics live" + Stop / Pause
  Lecturer->>Panel: tap Stop
  AE->>REC: stop + finalise
  AE-->>Panel: "Recording saved"
```

## 21. Auto Source Detection (walk-in)

```mermaid
stateDiagram-v2
  [*] --> RoomOff
  RoomOff --> Starting: signal detected on input [A] / tap
  Starting --> Presenting: display on + routed
  Presenting --> Prompt: 2nd source detected
  Prompt --> Presenting: keep current / switch to new (user choice)
  Presenting --> IdleWarn: no signal + no activity for T
  IdleWarn --> Presenting: user touches panel / signal returns
  IdleWarn --> RoomOff: countdown expires (auto-off)
```

- Timings: 2nd-source prompt auto-switches after 10s; idle warning 30s. No signal/occupancy detection → never auto-off.

---

# Sync, Combining, Access, Tiers

## 22. Deployment Sync / Drift Detection

```mermaid
stateDiagram-v2
  [*] --> InSync
  InSync --> PendingDeploy: cloud draft/release changed, not deployed
  PendingDeploy --> Deploying: deploy (now or scheduled)
  Deploying --> InSync: gateway reports active = desired
  Deploying --> Failed: verify/health fail → rollback
  Failed --> PendingDeploy: fix + redeploy
  InSync --> Drifted: gateway reports version/hash ≠ desired
  Drifted --> Deploying: re-deploy desired
  InSync --> Unknown: gateway offline
  Unknown --> InSync: gateway returns, hash matches
  Unknown --> Drifted: gateway returns, hash differs
```

- Desired (cloud) vs Reported (gateway heartbeat: release id + manifest hash) compared every heartbeat

## 23. Combined Rooms

Built as room groups with movable walls (`docs/room-groups.md`, decisions C-1 to C-14). A combined room is an ordinary room with its own program; the gateway decides which one runs.

```mermaid
stateDiagram-v2
  [*] --> Separate
  Separate --> Combined: a wall opens (panel "Link rooms", portal, sensor later)
  Combined --> Separate: the wall closes
  state Combined {
    [*] --> Live
    Live: the combined room runs, members suspended
    Live: each wall has open and close settings
    Live: off, on, follow or restore
  }
  Combined --> Combined: another wall moves, a different combined room runs
```

- The gateway owns which walls are open (saved locally, works with no cloud); the cloud sends the group in the config and the heartbeat reports open walls
- Every member's panel mirrors the live combined room; a group deploys as one action; the browser simulator runs the same `GroupController`
- Not built: sensors, disconnecting a suspended room's devices, keeping "restore" across restarts

## 24. Panel Access

```mermaid
flowchart TD
  P[Panel/Tablet loads room URL] --> T{Source IP in trusted list?<br/>MAC match best-effort}
  T -->|yes| U[User UI, no auth]
  T -->|no| C{Room PIN enabled?}
  C -->|no| U
  C -->|yes| PIN[PIN prompt] --> U
  U --> TECH[Tech view tap] --> PIN2[Tech PIN always required] --> TV[Tech/support view]
```

## 25. Tiers & Entitlements

```mermaid
flowchart LR
  TR[Trial<br/>5 rooms · 30 days · control + monitoring] -->|ends| BA
  TR -->|upgrade| PRO
  BA[Basic<br/>per room · monitoring only<br/>email alerts · up to 500 rooms] -->|upgrade| PRO
  PRO[Pro<br/>per room · control + monitoring<br/>all alert channels · marketplace · custom drivers]
  PRO -->|lapses| BA
  ENT{{Entitlement check<br/>tRPC middleware}} --- BA
  ENT --- PRO
  ENT --- TR
  ENT -->|control flag in every heartbeat reply| GATE[Gateway ControlGate<br/>refuses every command when control is off]
```

- Without control a room is a monitored room: devices, bindings, watch points and alert rules; publishing and deploying stay open so monitoring can start (TM-14, TM-15)
- An ended trial is monitoring only: no alerts, no analytics, no new rooms (TM-5)
- Control is enforced on the gateway, not only hidden in the portal

## 26. Simulator (browser)

```mermaid
flowchart LR
  MODEL[Room model draft] --> ENG[engine package<br/>same code as gateway]
  ENG <--> SIM[Simulated device drivers]
  ENG <--> PUI[Generated Panel UI]
  SIM --> VIZ[Signal-flow / device state visualiser]
  PUI -. user taps .-> ENG
  VIZ -. inject faults: no signal, device offline .-> SIM
```

---

# Gateway operations

## 27. Portal-driven Gateway Update

Decisions S-1 to S-8. An update is desired state on the gateway record (`updateNotBefore`, `updateVersion`, `autoUpdate`), not a command.

```mermaid
sequenceDiagram
  actor Owner as Owner / dev
  participant Portal
  participant API
  participant GW as Gateway (0.2.5+)
  participant Host as Release host (GitHub)
  participant Inst as Installer (Windows task or Watchtower)
  Owner->>Portal: Update now, at a time, cancel, or policy Automatic
  Portal->>API: store the request (audited)
  Note over API: Automatic makes the request itself when the channel has a newer version
  GW->>API: heartbeat (features include self-update)
  API-->>GW: updateOrder {version, bundle sha256 + size} once due and behind
  alt Windows
    GW->>API: GET /bundle
    API-->>GW: short-lived signed asset link + digest
    GW->>Host: download
    GW->>GW: check SHA-256 against the order, stage, refresh update.ps1
    GW->>Inst: schtasks /Run
    Inst->>Inst: stop service, swap, start, wait for /health
    Inst-->>GW: result (old version put back if it does not answer)
  else Docker
    GW->>Inst: Watchtower HTTP API (localhost)
  else no updater configured
    GW->>API: state=unsupported with a reason
  end
  GW->>API: progress in heartbeats: downloading, staged, applying, failed
  Note over API: success = the reported version reaches the target, a failure is not retried in a loop
```

- Older than 0.2.5: one manual update first ("needs one manual update"). Manual by default, so a fleet never changes unasked
- Trust gap (S-7): whoever can publish to `gateway-stable` can put code on gateways. Independent signing is not built

## 28. Unclaimed Gateway

The state machine behind diagram 2, path B (decisions T-1 to T-5).

```mermaid
stateDiagram-v2
  [*] --> Open: first announcement
  Open --> Claimed: staff assign org, site and name
  Claimed --> Open: staff take back (never connected)
  Open --> Dismissed: staff dismiss (announces hourly)
  Claimed --> Enrolled: gateway presents its secret, gets the token, enrols
  Open --> Removed: staff remove, or not seen for 30 days
  Claimed --> Removed: enrolled claims are deleted after 7 days
  Enrolled --> [*]
```

- Guardrails on an endpoint anyone can reach: 4 KB payload, secret stored hashed, 500 rows at most, 10 new installs a day per public address
- Unclaimed gateways cannot be updated from the portal: no organisation owns them (T-5)

## 29. Gateway Local Pages

Decisions U-1 to U-6. Served by the gateway on its panel port; plain HTML, no scripts.

```mermaid
flowchart TD
  ANY[Anyone on the LAN] --> ST["/ status page<br/>connected or not, version, last contact,<br/>rooms with panel links, install ID if unclaimed"]
  ADM[Person on site] --> CODE{"/admin: admin code<br/>(admin-code.txt in the data folder)"}
  CODE -->|5 wrong: locked 1 min| CODE
  CODE -->|right| SESS[30 minute session]
  SESS --> TOK[Enter enrolment token]
  SESS --> RST[Reset: type RESET]
  TOK --> TRY{Cloud accepts it?}
  TRY -->|no| KEEP[Nothing changes, reason shown]
  TRY -->|yes| WIPE
  RST --> WIPE[Forget the old organisation:<br/>rooms, releases, addresses, phone secrets,<br/>groups, unsent events]
  WIPE --> NEWID[Reset only: new install ID] --> ANN[Announce as unclaimed, diagram 28]
  WIPE --> ENR[Token path: enrolled in the new organisation]
```

## 30. Device Details, Feedback and Firmware

Decisions R-1 to R-8, TM-18 to TM-20 and the firmware step.

```mermaid
flowchart LR
  DRV[Driver read-backs<br/>power, input, mute, level, occupancy] --> HB
  DRV --> DET[Details: titled sections, rows, tables<br/>serial, MAC, program, IP table, stream status]
  DRV --> FW[Firmware version]
  DET -->|on change and every 5 min, dropped if invalid| HB[Heartbeat]
  FW --> HB
  HB --> API[API keeps the last details, feedback and firmware<br/>DeviceStatus]
  HB -->|each change| EV[device.feedback event, 90 day retention]
  API --> ROOMMON[Room monitoring page: click a device to expand]
  API --> FWPAGE[Firmware page: mixed versions flagged]
  EV --> HIST[History chart: minutes per value per day]
```
