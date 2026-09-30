# Pivot: Kestrel v2, monitoring, configuration, support, analytics (decided 2026-09-30)

> **Status: plan, nothing built yet.** Decisions are PV-1..PV-n in `docs/decisions.md`. Items marked **[proposed]** are my defaults, waiting for confirmation. Diagrams: `docs/diagrams.md` part "v2".

## The delineation

- **Before (v1, "control platform first")**: design a room program, sign it, deploy it to a gateway that runs it, generate a touch panel. Everything in `plan.md` phases 0-7 and steps B-Y up to 2026-09-29
- **After (v2, "monitor and manage first")**: know every room and device (active or passive), watch the active ones, hold them to a configuration, support the people using them, learn how the rooms are used
- **Control** (room programs, activities, generated panel, simulator) is **not cancelled, it is deferred**: it comes back later as a separate add-on that sits on top of v2's device model. We do not ship a subpar version in the meantime
- Git: tag the last v1 commit `control-platform-v1` before any removal. History keeps it; the tree does not have to

### Keep / change / remove

| Keep as is | Change | Remove (after tag) |
|---|---|---|
| App shell, IBM Plex/shadcn look, accent colour, org switcher, command menu | Estate tree gains **Areas** | Room designer, drafts, releases-as-room-programs |
| Auth, orgs, members, invites, roles, audit log, staff portal | **Device** becomes a first-class record (was inferred from a room design) | Engine, simulator, panel app, panel-ui, `packages/engine` |
| Gateway: enrolment, unclaimed, portal-ordered updates, local pages, Windows installer, Docker | Gateway runs **device pollers**, not a room runtime; can be assigned **per device** | Room groups / combining, activities, triggers, calendar triggers, phone control, hook secrets |
| Drivers framework and library, credentials, sealed secrets | Deployments become **configuration deploys** (profiles, snapshots) | Templates and marketplace (as room templates), `ControlGate`, control sessions/intents |
| Incidents, alerts, tickets, SLA, email, staff escalation, providers (MSP) | Tiers and billing rethought (below) | Custom-driver marketplace path (custom drivers stay) |
| Usage/reports, device history, watch points, firmware, details | Overview, nav, room page rebuilt around devices | Any code only the removed items used |

- **Staged removal (confirmed):** hide control UI first (M0), remove code once M1-M2 land, so `dev` never sits broken. Migrations drop tables last

## Hierarchy

- **Estate (org) → Site → Area (optional, nestable) → Room → Device**
- **Area** = whatever the customer calls it: building, level, floor, wing, campus zone. One `Area` table, self-parented, max depth 3, org-defined level labels ("Building", "Level") **[proposed]**
- A room sits in a site, and optionally in one area. Tags on rooms (free labels, e.g. "boardroom", "VIP") for cross-cutting groups. Area = where it is; tag = what it is
- Room groups (combined rooms) disappear with control

## Devices: active and passive

- **Active**: networked, has a driver, polled by a gateway, has status/feedback/history/config
- **Passive**: an asset record only. Fixed video source, laptop, camera, media player, cable box, touch panel not yet supported. Never shows online/offline
- Shared fields: name, room (or "shared across rooms", replaces Shared devices), category, make, model, serial, asset tag, install date, warranty end, supplier, notes, attachments/photos (later), tags
- Active adds: driver, address, credential set, **gateway**, polling state
- Passive extras: **manual checks** (a "last physically verified" date, optional reminders), warranty/end-of-life reminders
- Category list stays (video/audio source, cameras, mics, conference system, matrix, DSP, displays, environmental, mechanical), plus computer, media player, network gear, panel
- A passive device can be **upgraded to active** later (add a driver) keeping its history and asset data

## Gateways: one per room or one per device

- **Decision (confirmed): gateway is chosen per device, with a default per room and per site.** Resolution order: device gateway → room gateway → site default gateway. One-per-room is just the case where nothing overrides
- Gateway stays tied to **one site**. Several gateways per site allowed (network segregation, VLANs, AV VLAN vs building VLAN)
- Device state gets a third value: **online / offline / unknown (its gateway is unreachable)**. A gateway outage marks only its devices unknown and raises one gateway incident, not a device incident per device
- Room status is an aggregate over its devices across gateways. The room list shows gateway status as "2 gateways, 1 offline" with the worst state coloured
- Gateway config bundle = list of devices assigned to it (address, driver, credentials, profile, watch points). Signed and hash-checked as now
- Moving a device between gateways is a reassignment, no redesign or release

## Overview

- **Estate/environment tree** on the left (site → area → room), filters by site, area, tag, status
- **KPI cards** (each clickable to a filtered list):
  - Live incidents (by severity)
  - Rooms needing attention (has an active incident)
  - Rooms online % · Devices online n / m · Gateways online n / m
  - Rooms in use now (from the in-use definition)
  - Config drift (devices out of profile)
  - Open tickets and SLA at risk
  - 30-day availability %
- **Room list** (like today): live status, room, site / area, devices online n/m, gateway status, in use now, open incident, drift flag, last change
- Room page: devices (active and passive), incidents, config and drift, usage, tickets, history

## Configuration and deployment

Uses the driver methods that exist today (control points, feedback, details, firmware).

- **Config surface per driver [to verify per driver]**: each driver declares which points are **readable**, **writable**, and **volatile** (ignored by drift, e.g. uptime, temperature). Drivers without it are monitor-only for config
- **Configuration profile**: a named set of desired values for a device model or category ("Meeting room display: input lock off, standby 15 min, CEC off"). Applied to many devices. Org-level, shareable, with a provider library
- **Per-parameter mode**:
  - *Watch*: alert if it changes, do nothing
  - *Enforce*: put it back automatically (with retry limit, then an incident), audit every correction
  - *Apply once*: set at deploy, then leave
- **Snapshot**: capture everything readable (config points, firmware, details, IP table) as a versioned record. Manual, scheduled, and automatic before/after a deploy
- **Baseline and drift**: mark a snapshot as the baseline; drift = live vs baseline (or vs profile). Diff view per parameter, "accept as new baseline" or "revert to baseline"
- **Change detection**: a value changed outside Kestrel raises a "changed" event (who/when unknown, when seen) and, if enforced, is reverted
- **Configuration deploy**: push a profile to one/many devices, dry-run diff first, staged (canary room, then rest), rollback to previous snapshot. Deploy history replaces today's Deployments page
- Firmware and driver versions stay tracked here (Firmware page moves under Configuration)

## Analytics

- **Signals**: every point a driver reports that says something about use (power state, input/signal present, occupancy, mute, call active, lamp hours, temperature, usage counters). Change events stored as today's device history (raw retention 90 days), plus rollups kept longer **[proposed 13 months]**
- **"In use" definition** (per room, defaulted per room type, editable, org-wide defaults):
  - A small rule tree: conditions on a device point (`equals`, `above`, `below`, `present`), combined with AND / OR / NOT
  - Example: `display power = on OR occupancy = detected OR video signal = present`
  - **Two named states** [proposed]: **Occupied** (people) and **AV in use** (equipment). Either or both can be defined; the more useful one becomes the room's headline
  - Debounce: minimum on time, and a hold-off before "off" (a 3 minute gap does not end a meeting)
  - Definitions are evaluated in the cloud from stored history, so changing a definition **recomputes** past sessions
- **Derived**: room sessions (start, end, duration), per device on-time
- **Per room**: utilisation % of a working-hours window, sessions per day, average and median length, peak hours heatmap, after-hours use, availability, incidents, MTTR
- **Per device**: on-hours, lamp/filter life, availability, reboots, firmware history, flapping score
- **Insights** (rule based, no AI needed for v1): under-used rooms, always-on after hours (energy waste), devices nearing lamp end of life, recurring faults, rooms with high incident rate
- **Later**: booking overlay (booked vs used, "ghost meetings", from `docs/room-booking.md` and calendar connections), comparisons across sites, scheduled reports (exists)
- Availability and KPI maths must count **unknown** (gateway down) separately from **offline**, so a gateway outage does not read as every device failing

## Support

Keep: incident → ticket, escalate to Kestrel staff or handle internally, assignees, SLA, provider handling, email.

- **ITSM integration**: per-org connector, outbound create/update and inbound status/comment sync, ticket keeps an `externalRef` and a sync log
  - Now (settled): generic webhook + email-in (works with anything), and one built-in **demo connector** to show the round trip
  - Later, on customer demand: ServiceNow, Jira Service Management, Freshservice, Zendesk, HaloITSM, ConnectWise
  - Kestrel stays the source of truth for the incident, the ITSM for the ticket lifecycle, or the reverse per org
- **Improvements [proposed]**:
  - Auto-ticket rules (severity, kind, site, duration open) instead of manual only
  - Grouping: one ticket for a room or gateway outage, not one per device
  - **Maintenance windows**: suppress alerts and tickets for a site/room/device on a schedule (also excluded from availability)
  - **Routing**: who handles a ticket (Internal / Provider / Kestrel) decided by rule per site, area, category, severity, instead of per ticket
  - Escalation ladder with time steps and on-call contact
  - Internal notes vs customer-visible notes
  - Ticket ↔ asset link, so a device shows its repair history
  - Root cause tag and a short post-incident note, feeds analytics (top causes)

## Service providers

Today: a provider org holds `MspGrant`s to customer orgs (role + optional sites), can white label, has a support queue. Keep all of that.

- **Two estates in one provider account**:
  - **Internal estate**: the provider's own sites and rooms (their offices, demo rooms). Monitored under their own plan, exactly like any customer
  - **Customer estates**: one per customer org the provider has an active grant to. Data stays in the customer's org, the provider sees what the grant allows
  - The estates are never mixed unless the person picks "All customers"
- **Provider portal layout [proposed]**:
  - Top of the org switcher: *Internal*, then *Customers*, then each customer by name
  - **Customers** = portfolio home: one row per customer: rooms, devices online, live incidents, rooms needing attention, tickets and SLA at risk, drift count, health score. Sort/filter by account manager, tag, region
  - Picking a customer scopes the whole app to it (same UI as a normal org, banner "Working in Customer X", already there as the via-provider banner)
  - **All customers** views for Incidents, Tickets (the support queue) and Alerts: one list with a Customer column and filter, saved views
  - Internal estate never appears in Customers rollups, and customer data never appears in Internal
- **Grants improvements**: scope by site **and area or room**, optional end date, customer sees a log of what the provider did (audit shown to customer), a customer can have **more than one provider** (e.g. AV vs network) with routing by category/site, per-customer SLA and alert routing at the provider side
- **Provider tools**: provider-level profile library (config profiles reused across customers, copied not shared, so a customer keeps its own), per-customer branding (exists), provider creates a customer org on its behalf and hands over ownership
- **Billing (settled)**: each org pays for its own rooms. Provider's internal estate is on the provider's own plan

## Asset register and preventative maintenance (added 2026-09-30)

### Asset register

- **One register per org**, filterable and groupable by site, area, room, category, make, status, tag. It is the Assets page over the device records, not a second copy
- **Field provenance**: every field remembers where its value came from
  - *Discovered*: read from the device by its driver (serial, MAC, model, firmware, hostname, IP table, programs). Refreshed on every poll
  - *Manual*: typed by a person (any field, and the only source for passive devices)
  - *Override*: a person typed a value that **disagrees** with a discovered one. The register shows the mismatch, keeps both, and lets someone accept the discovered value
  - A manual value fills a gap and is never overwritten by discovery; a discovered value never silently replaces a manual one
- **IP address** is the configured address (from the binding) unless the driver reports its own. **MAC** and **serial** depend on the driver; where a driver cannot report one it stays blank for manual entry **[to verify per driver]**
- **Fields**: name, category, make, model, serial, MAC, IP, firmware, asset tag, room/area/site, status (in service, spare, in repair, retired), install date, warranty end, end-of-life date, supplier, cost (optional), notes, photos (later). Custom fields per org later
- **Gaps view**: "assets missing a serial / warranty / asset tag", so completeness can be chased. Completeness % is a KPI
- **Import and export**: CSV/XLSX import to seed a register from an existing spreadsheet (match on serial or asset tag), export any filtered view
- **Register issues (signed and published)**
  - A **register issue** is a frozen, numbered copy of the register (or one site/area) at a moment: R1, R2, ... taken on a schedule (monthly, quarterly, annually) or on demand
  - Signed with Kestrel's Ed25519 signing (`packages/crypto`, same mechanism as manifests, a separate key purpose), hash stored, immutable, kept for as long as the subscription (not the 90 day telemetry window)
  - Download as PDF (human) and CSV/JSON (data), with the signature and a **verify page** (paste or upload, it confirms the hash and signature)
  - **Diff between two issues**: added, removed, moved, changed firmware/serial/status
  - The signature proves Kestrel issued this content at that time. It does not prove the data is true (manual fields are the customer's word), and the issue records which fields were discovered vs manual
- Not the same as a **config snapshot** (device settings, PV-8). A register issue is what the assets are; a config snapshot is how a device is set up

### Preventative maintenance (PM)

- **PM template**: a checklist for a room type or device category. Item types: pass/fail/n-a, number with unit and limits (e.g. "speaker level"), text, photo, sign-off. Kestrel starter library (Meeting room, Training room, Display, Camera, DSP...), org templates, provider libraries copied to customers
- **PM schedule per room** (or per device): interval (monthly, quarterly, six-monthly, annual, or every N days), first due date, assignee (a member or a provider), reminder lead time. Stored on the room; a room can have several schedules
- **Auto-filled items**: items that monitoring can answer are pre-filled from live data with the reading and time (device online, firmware matches profile, no drift, last incident, lamp hours). The technician confirms the physical items (clean filters, test audio, check cables) and can override an auto item with a note
- **PM run** = one completed check. Records who, when, every result, notes, photos, the template version used, and a sign-off (typed name; drawn signature later). **Immutable once signed**; corrections are a new run or an addendum
- **Failed item**: one click to raise a ticket linked to the room and device (reuses the support flow); optionally set the asset status to "in repair"
- **Organisation-wide PM record**: every run for every room, filter by site/area/room/assignee/result/date, export PDF/CSV, and a monthly or annual **PM report issue signed like a register issue**. Room page shows its own PM history and next due
- **KPIs**: PM due soon, overdue, on-time % on the Overview and in Reports. Overdue can raise an info-level incident and email (uses maintenance windows so the visit does not alert)
- **Technician use**: the run form is responsive for a phone or tablet in the room. Offline capture is a later item
- **Providers**: a provider can run PMs on customer rooms in its grant. The customer sees the runs and the provider name (grant audit, PV-12)

## Device detail page (added 2026-09-30)

- **One page per device**, opened from the Assets register or by clicking a device in a room. Same page either way (`/o/[orgId]/devices/[id]`), with the room, site and area as breadcrumbs. Builds on the current device details cards
- **Header**: name, active/passive badge, status (online / offline / unknown), room, site, area, gateway, last seen, quick actions
- **Sub-cards / tabs** (a passive device shows only the ones marked *):
  - **Overview**: live status and the key readings now
  - **Details***: identity and asset fields with provenance (discovered / manual / override), plus what the device reports about itself (serial, MAC, IP, firmware, programs, IP table)
  - **History**: charts (below). Active only
  - **Configuration**: profile, enforced parameters, snapshots, drift. Active only
  - **Maintenance***: PM runs this device appeared in, pass/fail per item, next due
  - **Asset history***: the device's timeline (below)
  - **Incidents and tickets***: everything raised against it
- **History charts only for what the driver can report**
  - A driver declares its **history metrics**: which points are worth charting, their type (number, on/off, enum), unit, label and range **[per-driver audit, extends what device history (TM-19) logs today]**
  - The page draws exactly those. A display shows power, input, lamp hours; a DSP shows level and mute; a camera without feedback shows none. No empty or irrelevant charts, and passive devices have no History tab
  - Every active device always gets the **availability bar** (online / offline / unknown over time), since that applies to all drivers
  - Numbers as line charts, on/off and enums as state timelines, range picker (24h, 7d, 30d, 90d, then rollups to 13 months)
- **Asset history (device timeline)**: an append-only log of everything that happened to the device, newest first, filterable by type
  - Field changes with old > new, source (discovered or manual) and who: serial, MAC, IP, model, firmware, name, status, warranty
  - Moves: room, area, site, gateway reassignment, active/passive upgrade, profile change
  - Events from other areas: incidents, tickets, config drift and corrections, PM runs and failed items, register issues it appears in
  - **Possible swap detection**: a changed serial (or MAC or model) is flagged "Serial changed, device may have been replaced". Someone then picks **Replaced** (records the old serial as retired with the date, keeps the slot's history and starts a new identity line) or **Correction** (it was a typo, no swap). Until chosen it shows as an info notice on the room and Overview. Manual edits of these fields raise the same flag
  - A failed PM item appears here and on the Maintenance tab
  - Kept for the life of the device record (an audit trail, not the 90 day telemetry window). Included in register issues as the change list between issues

## Navigation (replaces the current groups)

- **Overview**
- **Estate**: tree (site → area → room), All sites, All rooms
- **Monitor**: Incidents, Alerts, Maintenance windows, Gateways
- **Assets**: Register (all devices, active and passive), Register issues, Shared logins, Firmware
- **Maintenance**: Schedule, PM records, PM templates
- **Configuration**: Profiles, Snapshots and drift, Changes (deploy history)
- **Analytics**: Usage, Room definitions ("what counts as in use"), Reports
- **Support**: Tickets, Integrations (ITSM)
- **Organisation**: Team, Settings, Billing
- **Provider group** (as today, expanded): Customers, All-customer incidents, Support queue
- Gone: Design and deploy group, Templates, Marketplace, Room groups, Shared devices (folded into Assets)
- Custom drivers move under Assets **[proposed]**

## Tiers (unit settled, names and split open)

- Control is gone, so "Basic = monitoring, Pro = control + monitoring" no longer holds
- **Proposed**: Trial (30 days, everything, 5 rooms) · **Essentials** (monitoring, assets, incidents, email alerts, basic usage) · **Pro** (adds config enforcement + drift, full analytics and definitions, all alert channels, ITSM, API, custom drivers)
- Unit (settled): **per monitored room per month**; a room is chargeable only if it has an active device; passive devices free and unlimited
- Keep existing plumbing (Stripe, licence overrides, staff adjustments); the plan model changes, not the mechanism

## Build order

| Step | What | Notes |
|---|---|---|
| M0 | Tag `control-platform-v1`, delineation docs, hide control UI, new nav skeleton | Docs done with this pivot |
| M1 | Data model: Area, Device (active/passive), device gateway, in-use definition tables; gateway becomes device-centric | Biggest change; migration plan first |
| M2 | Overview, estate tree, room list, room page, asset screens, device detail page shell and asset history timeline | Look and feel kept. Timeline needs the M1 device event log |
| M2b | Asset register: field provenance, manual entry, gaps, import/export, signed register issues and verify page | Uses the M1 device model |
| M3 | Analytics: definitions, sessions, room/device pages, driver-declared history metrics and device History charts | History already captured, so early value |
| M4 | Configuration: config surface per driver, profiles, snapshots, drift, enforce | Needs driver audit first |
| M5 | Support: maintenance windows, routing, auto-ticket, ITSM webhook, email-in and demo connector | |
| M5b | Preventative maintenance: templates, schedules, runs with auto-filled items, org PM record, signed PM report | Needs maintenance windows and tickets from M5 |
| M6 | Providers: Internal vs Customer estates, portfolio, all-customer views, grant scopes | |
| M7 | Tiers and billing, removal of parked control code, launch readiness | Tiers, billing and web clean-up built. Left: run the legacy device migration, remove the gateway room runtime and v1 tables (M7-6), launch readiness and security review |

## Settled 2026-09-30

1. **Per-device gateway** with room then site defaults. Confirmed
2. **Billing: per monitored room per month. A room is chargeable only if it has at least one active device**; passive devices are free and unlimited, and a room of only passive assets costs nothing
3. **Each org pays for its own rooms.** No provider-pays option for now
4. **ITSM: generic webhook plus email-in, and one built-in demo connector** (a mock ITSM that shows create/sync/status round trips). Real adapters (ServiceNow, Jira SM, etc.) wait until a customer needs one
5. **Removal is staged** (M0 hide, delete code as M1-M2 land, drop tables last)

Still open: which tier gets signed register issues and PM (proposed: register on Essentials, issues and PM on Pro), Essentials/Pro names and the exact feature split; whether Occupied and AV in use are both shown as headline states.
