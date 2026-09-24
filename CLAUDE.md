# Kestrel — Project Memory (repo folder still `cobra`; product name = Kestrel)

## What This Is

- Cloud-based AV control system deployment tool
- Primary: devs build/version/deploy room programs to on-prem **gateways** (Linux/Windows PC, container-first) with network access to room devices + touch panels/tablets
- Secondary (parity): live monitoring of deployed systems via gateway
- Tertiary: customer-facing management/support tooling
- Fully standalone, separate from any Avrus branding: no Avrus/avisor names, packages, domains, assets, or code/data coupling anywhere in this repo (package scope `@kestrel/*`)

## Stack

- **Frontend:** Next.js (App Router) + Tailwind CSS
- **API:** tRPC
- **DB/ORM:** Prisma → Supabase Postgres (AU/Sydney region)
- **Auth:** Supabase Auth
- **Billing:** Stripe
- **Hosting/CI-CD:** Vercel (web). Gateway = Docker image via GitHub Actions → GHCR
- **Gateway:** Node/TypeScript, container first, Windows installer later
- **Repo:** Turborepo monorepo. Git: `main` (prod) / `dev` + feature branches, PRs only, conventional commits

## Core Domains

1. **Deployment** — author room programs in portal, immutable signed releases, deploy per room (on-demand or scheduled), drift/out-of-sync detection, rollback
2. **Monitoring** — device/room health, events, incidents, alerts, built in parallel with deploy
3. **Customer tools** — customer dashboard, room status, control from portal, tickets/support requests
4. **Billing** — Stripe, per-room tiers (see Decisions)

## Room Program Format (DECIDED: declarative system model, no hand-written room code)

- Devs architect room logically; Kestrel derives routing/logic/UI from model
- Flow: new room → template or Room Type (initial: Meeting, Training) → type supplies default behaviours
- Model: devices (by category), ports, connections, groups, states, activities, triggers, rules, room combinations
- Device categories: video/audio sources, conf/fixed/PTZ/auto-framing cameras, reinforcement + voice-capture mics, conference systems (MTR/Codec), video matrix (virtual/physical — same model), audio matrix/DSP, video + audio destinations, conference outputs, environmental (lighting/HVAC/blinds), mechanical (lifters/screens)
- Groups: Display Group = members + allowed sources + mode (follow | independent)
- States: Off / On / custom = ordered actions (routes, DSP presets, device cmds, env scenes)
- **Combined rooms:** a room can be Combined; behaviour is configurable: primary vs secondary role; secondary video follows|blanks; secondary audio follows|blanks; on uncombine revert to Off
- Target: 90% rooms = 1–2 laptop inputs → 1–2 displays + speakers. Custom logic hooks (sandboxed scripts) DEFERRED; edge cases via rules
- Runtime on gateway = generic interpreter of a signed manifest (same engine package also runs in-browser simulator)
- Devices without driver: generic TCP/serial (and PJLink/REST templates) allowed in v1
- Drivers: in-house v1, versioned separately from room programs; future third-party/dev subscription + marketplace
- Multiple UIs per room allowed; they mirror/follow each other (state lives in runtime, broadcast to all)
- Conference systems: default = routing + basic API control later
- Control = purely IP-based; no Crestron processors in loop. Panels/tablets = browser URL only
- See `docs/diagrams.md`

## Generated UI Principles (DECIDED: intent-based, not device-based)

- UI exposes **Activities/intents**, never device functions (no "Display Power", "HDMI 2", "Matrix Out 1")
- Assume user has zero AV knowledge; goal = 1–2 taps from walking in to done
- Nest similar grouped controls using a left-hand or top nav menu (e.g. Video, Microphones, Cameras grouped)
- Volume: always + / − (tap to bump, press-and-hold to ramp). If feedback available show numeric 0–100 scaled from source (e.g. -40dB…0dB → 0…100). Default 50% unless overridden in room config
- Each Activity = named intent → runtime auto-executes ordered/parallel actions (power on, route, DSP preset, camera preset, mic unmute, lights/blinds/screen)
- v1 activity library (Meeting + Training): Present (Laptop/Wireless), Video Call, Record, Room Off; devs can add/rename/hide
- Source select is functional: implies display on + route + audio follow + correct input; no separate power buttons
- Signal detect → auto-select source + auto-power on. 2nd source plugged in while active → prompt, auto-switch after 10s
- Auto-off: on idle (occupancy + signal detection), warn 30s before. If room cannot detect signal → never auto-off
- Advanced/tech controls (device-level controls/tests e.g. screen up/down) in separate view: PIN on panel, role in portal
- Feedback in plain language, no device jargon. Deterministic: proceed the moment all devices are ready, no fixed waits
- Minimal user controls: Volume + Mute; extras (lights/blinds/camera) only if room config enables
- Responsive UI (fixed panels, tablets); QR-to-phone later. Generated from model with editable elements + per-org themes (logo/colours) + multilingual
- Panel auth: open on LAN v1, optional PIN, trusted-device bypass by verified IP (MAC only if same L2 subnet — see Risks)
- Activities derived from Room Type + model; only offered if required capabilities exist in room

## Triggers (all in v1)

- Tap, signal-detect, schedule, occupancy sensor, calendar (Graph/Google), external API/webhook

## Gateway

- Outbound-only secure comms to cloud (HTTPS heartbeat + WSS push, WSS optional/fallback). No inbound ports, no remote tunnelling v1
- Up to ~50 rooms per gateway
- Rooms run fully offline; telemetry buffered locally (SQLite) and replayed
- Self-update via separate release channel (stable/beta) from room programs
- Enrollment via one-time token; bundles verified by hash + Kestrel-held signature on every deploy
- Heartbeat 30s; telemetry retention 90 days
- Remote commands: allowlisted only, full audit log

## Deployment & Releases

- Deploy target: per room; on-demand or scheduled
- Drift detection: flag "pending deploy" (cloud changed, not deployed) and "drifted" (gateway state ≠ cloud release)
- Single release stream + rollback v1
- Simulator: browser/cloud demo of a room showing device responses graphically alongside the generated UI (high value)

## Monitoring & Support

- Alerts v1: email, Teams, webhook, generic ITSM placeholder
- Customer portal v1: read-only status, control from portal, tickets/support requests

## Tenancy, Auth, Billing

- Multi-tenant: org → sites → rooms → devices. MSP/reseller tier later
- Roles v1: owner / dev / support / customer viewer
- Billing (per room/month): **Trial** 5 rooms, full control+monitoring 30d then control only · **Basic** control only + can purchase marketplace templates · **Pro** control + monitoring, marketplace upload/download, driver creation
- Templates: Kestrel-global + per-org (shareable in org); marketplace (Pro publishes, Basic buys)
- Data region: AU

## Repo Layout

```
/
├── apps/
│   ├── web/              ← Next.js portal (tRPC routers, Tailwind)
│   ├── gateway/          ← Node/TS gateway service + Dockerfile, docker-compose.yml, windows/ installer
│   └── panel/            ← Vite panel SPA (built into the gateway image/bundle)
├── packages/
│   ├── db/               ← Prisma schema + client
│   ├── crypto/           ← signed manifests, tokens, PIN hashing, sealed secrets, phone-access tokens
│   ├── model/            ← zod schemas: room model, manifest, activities, protocol messages
│   ├── engine/           ← room interpreter + activity generator + validator (shared: gateway + browser simulator)
│   ├── drivers/          ← driver framework, in-house + declarative drivers, bundled library, simulated devices
│   ├── panel-ui/         ← generated panel SPA (served by gateway)
│   └── config/           ← eslint/tsconfig/tailwind presets
├── docs/                 ← diagrams.md, plan.md, driver-sdk.md, phase-4-preread.md (status source)
└── CLAUDE.md
```

## Risks / Notes

- Browsers cannot reveal MAC; gateway can only learn panel MAC via ARP on same L2 subnet. Use IP allowlist as primary, MAC best-effort
- Prisma connects as DB owner and bypasses Supabase RLS → enforce tenant scoping in tRPC context middleware (every query), use RLS as defence-in-depth
- 50 rooms/gateway → isolate rooms (worker threads or per-room event loops), cap device connections, bound telemetry buffer
- Signal-detect/occupancy auto-off needs driver contract to expose signal-presence feedback
- Trial → downgrade must disable monitoring per-room without breaking control
- Marketplace = IP/licensing/review process; keep out of MVP

## Conventions

- TypeScript strict everywhere, zod as single source of truth for shared schemas (model, protocol, manifest)
- API responses via tRPC types; gateway↔cloud protocol versioned and defined in `packages/model`
- Never omit `orgId` scoping; never hardcode secrets
- Status: Phases 0-7 built (PR #9 for Phase 3 open; phases 4-7 are stacked local branches `feat/phase-4-deployments` → `feat/phase-5-monitoring`, unpushed). **Read `docs/phase-4-preread.md` first** (status table, verified-vs-untested list, ops setup, rules learned, next steps). Progress lives there, not in plan.md
- Pins: TypeScript ^6 (typescript-eslint lacks TS7 support), Prisma 7.x (CLI must match client), pnpm 12, Next 16 (`proxy.ts` replaces middleware)
- Env: see `.env.example`; Prisma CLI reads `DIRECT_URL`, runtime uses `DATABASE_URL`
- Every org-scoped tRPC procedure uses `orgProcedure` (membership check) and filters by `ctx.orgId`

## Still Open

- MVP definition (proposed in `docs/plan.md`, needs confirmation)
- MVP driver list: which matrix / DSP / display / camera vendors to target first
- Windows installer timing; domain purchase (check `kestrel` availability — spelled "Kestrel")
