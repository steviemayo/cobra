# Kestrel — Workflow & Pipeline Diagrams (Mermaid)

> Draft. Assumptions marked **[A]** — confirm/adjust. Renders in GitHub/VS Code Mermaid preview.

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
  GW <-- WSS [A] --> RT
  GW --> STORE
  GW --- RUN --- DEV
  GW --- UI
  PANEL -- HTTP/WS on LAN --> UI
  UI --> RUN
```

## 2. Gateway Enrollment (provisioning)

```mermaid
sequenceDiagram
  actor Admin
  participant Portal
  participant API
  participant GW as Gateway (new)
  Admin->>Portal: Create gateway in Site
  Portal->>API: gateway.create
  API-->>Portal: one-time enrollment token
  Admin->>GW: Install container + set token (env)
  GW->>API: enroll(token, hw info, pubkey)
  API->>API: validate token, bind to tenant/site, burn token
  API-->>GW: gateway_id + long-lived credential + config
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
  API-->>GW: notify (Realtime push, or next heartbeat)
  GW->>Store: download bundle
  GW->>GW: verify hash + signature
  GW->>GW: stage alongside current version
  GW->>RT: start new runtime (staged)
  GW->>GW: health check (device connect, self-test)
  alt healthy
    GW->>RT: switch traffic, stop old runtime
    GW->>API: report deployment=succeeded
  else failed / timeout
    GW->>GW: keep/rollback to previous version
    GW->>API: report deployment=failed + logs
  end
  API-->>Portal: status + logs shown to Dev
```

## 4. Deployment State Machine

```mermaid
stateDiagram-v2
  [*] --> Pending
  Pending --> Downloading: gateway acks
  Downloading --> Verifying
  Verifying --> Staging: hash+sig ok
  Verifying --> Failed: bad hash/sig
  Staging --> HealthCheck
  HealthCheck --> Active: pass
  HealthCheck --> RolledBack: fail/timeout
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
  API-->>Portal: alert (email/Teams/webhook) [A]
```

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

## 8. Core Domain Model (draft)

```mermaid
erDiagram
  ORG ||--o{ MEMBER : has
  ORG ||--o{ SITE : owns
  ORG ||--|| SUBSCRIPTION : billed_by
  SITE ||--o{ GATEWAY : hosts
  SITE ||--o{ ROOM : contains
  ROOM ||--o{ DEVICE : has
  GATEWAY ||--o{ ROOM : runs
  PROGRAM ||--o{ RELEASE : versions
  PROGRAM }o--|| ORG : authored_in
  RELEASE ||--o{ DEPLOYMENT : deployed_as
  ROOM ||--o{ DEPLOYMENT : targets
  GATEWAY ||--o{ DEPLOYMENT : executes
  DEVICE ||--o{ DEVICE_STATE : reports
  DEVICE ||--o{ EVENT : emits
  EVENT }o--o| INCIDENT : groups
  ORG ||--o{ DRIVER : uses
  GATEWAY ||--o{ COMMAND : receives
  ORG ||--o{ AUDIT_LOG : records
```

## 9. Kestrel's Own CI/CD (Vercel + Supabase + Gateway image)

```mermaid
flowchart LR
  PR[Feature branch PR] --> CI[CI: lint, typecheck, test, prisma validate]
  CI --> PREV[Vercel Preview Deploy<br/>+ Supabase preview branch [A]]
  PREV --> REVIEW[Review] --> MERGE[Merge to main]
  MERGE --> MIG[Prisma migrate deploy<br/>to prod Supabase]
  MIG --> PROD[Vercel Production]
  MERGE --> IMG[Build gateway image<br/>GitHub Actions]
  IMG --> REG[(Container Registry<br/>GHCR)]
  REG --> CH[Gateway release channel<br/>stable / beta]
  CH --> GWUP[Gateways self-update<br/>pull + swap + rollback]
```

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

```mermaid
stateDiagram-v2
  [*] --> Separate
  Separate --> Combined: combine trigger (tap / sensor / schedule)
  Combined --> Separate: uncombine
  state Combined {
    [*] --> Primary_Secondary
    Primary_Secondary: Primary drives; Secondary per config
    Primary_Secondary: video follows | blanks
    Primary_Secondary: audio follows | blanks
  }
  Separate --> Off_Reverted: on uncombine, secondary reverts to Off
```

- Combination config lives on the room set: roles, follow/blank per signal type, revert-to-off flag
- Secondary panel UIs mirror primary or show "Room combined — use {Primary}"

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
  TR[Trial<br/>5 rooms · 30d · control+monitoring] -->|expires| BA
  TR -->|upgrade| PRO
  BA[Basic<br/>per room · control only<br/>buy marketplace templates] -->|upgrade| PRO
  PRO[Pro<br/>per room · control + monitoring<br/>publish to marketplace · driver creation]
  ENT{{Entitlement check<br/>tRPC middleware + gateway config}} --- BA
  ENT --- PRO
  ENT --- TR
```

- Monitoring off ⇒ gateway stops sending/cloud stops ingesting for that room; control unaffected

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
