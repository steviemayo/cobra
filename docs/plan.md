# Kestrel — Build Plan (phased)

> Proposed. Each phase ends in something demoable. MVP = Phases 0–4 (+ thin slice of 5).

## Key Architectural Bets

- **One engine, two hosts:** `packages/engine` (pure TS, no IO) runs on gateway AND in browser simulator → what you simulate is what deploys
- **Model → Manifest → Runtime:** authoring model (DB) compiles to a signed JSON manifest; gateway only ever interprets manifests
- **Drivers behind a contract:** `connect / send / parse / feedback (incl. signal-presence) / health`; simulated devices implement same contract
- **Protocol in `packages/model`:** versioned zod schemas for heartbeat, commands, deploy, telemetry
- **Panel UI is static SPA + manifest:** gateway serves it, WS for state; multiple panels follow room state

## Phase 0 — Foundations

- Turborepo + pnpm, TS strict, eslint/prettier, vitest, GitHub Actions CI (lint/typecheck/test)
- Supabase project (Sydney) + Prisma; Vercel project; env/secret handling
- Supabase Auth, org/membership/roles, tRPC context with tenant scoping
- Base Prisma schema: Org, Member, Site, Gateway (stub), Room (stub), AuditLog
- **Done when:** sign up → create org → site → room record; deployed on Vercel preview

## Phase 1 — Room Modelling (portal)

- `packages/model` schemas: Device, Port, Connection, Group, State, Action, Activity, Trigger, RoomCombination
- Catalog of device categories + Room Types (Meeting, Training) + starter templates
- Authoring UI: add devices, define ports/connections, groups, states, activities (list + graph view)
- Validator: unconnected ports, illegal routes, missing capabilities, missing drivers
- Versioned drafts (autosave), template create/clone (org-level)
- **Done when:** build the "90% room" in portal, validator passes, model saved

## Phase 2 — Engine + Simulator + Generated UI

- `packages/engine`: routing graph resolver, group modes, activity generator (capability-filtered), action executor (parallel + dependency-aware, deterministic readiness), auto-behaviours (signal detect, conflict prompt 10s, idle warn 30s)
- Simulated devices (display, matrix, DSP, camera, source, recorder) in `packages/drivers`
- `packages/panel-ui`: generated intent UI (nav groups, volume +/-, plain-language status, themes, i18n scaffolding)
- Browser simulator: panel UI beside animated signal-flow/device-state view
- **Done when:** demo "Present Laptop" and "Record" in browser; multi-panel follow works

## Phase 3 — Gateway

- `apps/gateway`: enrollment (token → credential), heartbeat 30s, WSS push w/ HTTPS fallback, config sync
- Room runtime host (per-room isolation), driver loader, generic TCP/serial + PJLink, panel UI server (WS), optional PIN + trusted IP
- SQLite buffer for events/telemetry + offline boot from local manifest cache
- Dockerfile + GHCR build; Windows installer deferred
- **Done when:** container enrols, runs a room against simulated + 1–2 real devices, panel on LAN works offline

## Phase 4 — Releases & Deployments

- Release = immutable snapshot → manifest → hash + signature → Supabase Storage
- Deployment per room: on-demand + scheduled; state machine (download → verify → stage → health check → active/rollback)
- Drift/pending detection (cloud vs desired vs reported), rollback to previous release
- Deploy UI: status, logs, diff between releases
- **Done when:** publish → deploy → panel changes live; break it → auto rollback; drift flagged

## Phase 5 — Monitoring & Support

- Telemetry ingest, device/room health scoring, events, incidents, 90-day retention job
- Portal live status (Supabase Realtime), room/site/gateway dashboards
- Alerts: email, Teams, webhook, ITSM placeholder; rules + noise control
- Remote commands (allowlist) + audit log; tech/support view in portal; tickets/support requests
- **Done when:** unplug a device → incident + alert; run diagnostic remotely

## Phase 6 — Billing & Customer Portal

- Stripe: per-room subscription, Trial (5 rooms/30d) → downgrade logic, Basic, Pro; webhooks; entitlements middleware
- Customer viewer role + customer dashboard (status, control, tickets)
- Org theming (logo/colours), language packs

## Phase 7 — Expansion

- Triggers: schedule, calendar (Graph/Google), occupancy, webhook/API
- Combined rooms behaviour
- Marketplace (publish/buy templates), driver SDK + dev subscription
- Gateway self-update channels, Windows installer, QR-to-phone control
- Additional drivers (conference systems API control, cameras, env, mechanical)

## MVP Proposal (confirm)

- 1 gateway (Docker), 1 Meeting room: 2 laptops → matrix → 2 displays + DSP
- Present Laptop / Room Off activities, auto signal-detect (fake or simulate)
- Deploy + rollback, live status, simulator in browser
- Real hardware: generic TCP/serial + PJLink + Crestron DM-NVX virtual matrix (1 DM-NVX-E30 encoder and 1 DM-NVX-D30 decoder) + ONE DSP (1 x Qsys Core with a gain component with script name 'gain')

## Suggested Tech Picks [A — confirm]

- pnpm + Turborepo, zod, Vitest, tRPC v11, TanStack Query, shadcn/ui (Tailwind)
- Gateway: Fastify + ws + better-sqlite3 + pino
- Panel UI: Vite + React (or Preact for small footprint), served statically by gateway
- Signing: Ed25519 (node crypto); private key in Vercel secret/KMS, public key baked into gateway
- Graph editor: React Flow (device/connection view)
- i18n: next-intl (portal) / i18next (panel)

## Immediate Next Steps (on go-ahead)

1. Scaffold monorepo + CI (Phase 0)
2. Write `packages/model` first draft (Phase 1 schemas) — this is the contract everything else depends on
3. Prisma schema v1
