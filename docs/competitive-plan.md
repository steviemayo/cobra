# Competitive feature plan (drafted 2026-10-01)

> **Status 2026-10-01:** P1 and P2 built on branch `feat/meeting-aware-incidents` (uncommitted, tests pass, browser pass not done). P3 re-scoped, not built (below). P4 to P8 not started

> Source: a three-agent review against Q-SYS Reflect, Crestron XiO Cloud and Innomate (Innomesh), then checked against this repo. The agents read public marketing pages only, so "competitor lacks X" is low confidence. **Their claims about what Kestrel lacks were partly wrong**; this plan uses the repo check, not the agents' view of us.
> Note: "Inanimate" was read as **Innomate** (AU, Sydney). Confirm.

## 1. What the repo check changed

| Idea | Agent assumption | What already exists | Real delta |
|---|---|---|---|
| 2 Calendar-aware incidents | Missing | `Room.calendarConnectionId`, `RoomSchedule`, `refreshSchedules` in the sweep. Alerts already say which meetings a fault "may affect" (`alerts.ts`, `room-schedule.ts` `affectedForRooms`) | **Small**: severity bump and faster escalation when a meeting is on now; "meetings disturbed" counted in reports and analytics |
| 6 On-call and escalation | Missing | `alert-rules.ts`: channel windows (rota per person), delay, repeat, ack-cancels. Webhook and Teams channels | **Small**: PagerDuty and Opsgenie as channel types (payload and dedup key), no native app |
| 12 SLA/QBR reports | Missing | `monthly-report.ts`, `report-delivery.ts`, `ReportSchedule` (monthly email per org) | **Medium**: PDF output, quarterly cadence, per-site or per-customer recipients, SLA attainment section. Check what the email renders today first |
| 15 Runbooks | Missing | `RemoteCommand` with allowlist and audit log; MaintenanceWindow; TicketRule | **Medium**: runbook text and action buttons attached by incident kind |
| ITSM | Stub | `ItsmConnector` (webhook, demo, email_in), `ItsmLink`, inbound route | **Adapter only** (ServiceNow). Pivot PV-10 says "on demand" |
| 3 Correlation | Missing | `Incident.roomIds` (shared device), gateway outage marks devices "unknown" and raises one gateway incident | **Real gap**: no parent/child grouping beyond the gateway case |
| 1 Self-tests | Missing | Driver readable/writable points, remote commands | **Real gap** |
| 9 Booking vs actual | Missing | `usage-analytics` (in-use from device points) and `RoomSchedule` | **Medium**: schedule is a rolling copy, bookings are overwritten, so no history to compare |
| 8 Teams Rooms health | Missing | `CalendarConnection` pattern (Microsoft 365 profile, cloud-side polling) | **Real gap**, cloud-side |
| 4 SNMP | Missing | None (no SNMP in repo) | Real gap, large |

## 2. Plan, in order

### P1. Meeting-aware severity (BUILT)
- When an incident opens for a room with a meeting **on now** or starting within N minutes: raise severity one step, tag "meeting impacted", skip the alert `delayMinutes` of rules that would hold it
- Record `meetingsAffected` on the incident at open and resolve so reports can count it
- Add "meetings disturbed" to the monthly report and Overview
- Scrutiny: private meetings carry no title (already handled); a stale schedule copy (>15 min) must not raise severity, it should say "unknown"
- Needs: no migration if stored in `Incident.detail`/JSON; a nullable column is cleaner. Decide before building

### P2. Incident correlation (BUILT, v1)
- Model: `parentId` on `Incident` (nullable, self-relation) plus `groupKey`. Children stay individually visible, tickets and alerts attach to the **parent** only
- Deterministic rules first, no AI: (a) same gateway down, (b) same site, same kind, N devices within M minutes, (c) same device shared across rooms (exists), (d) later: same switch/subnet once P7 gives topology
- Open questions
  - What is the grouping key without a network layer? Same IP subnet from device addresses is cheap and usually right; confirm that devices hold addresses
  - Does a parent resolve when all children do, or can it be closed manually? **Proposed**: auto-resolve, manual override
  - Existing alert dedupe (`kind,subject,status`) and flap logic must keep working per child
  - Auto-ticket and SLA clocks run on the parent only; confirm SLA reporting counts the parent once
- Scrutiny: wrong grouping hides a real separate fault. Keep a "ungroup" action and show children inline. Never group across severity critical vs warning

### P3. Pre-meeting self-tests (re-scoped after checking the code, **not built**)
- Checked against the repo: a read-only check made from live state would only repeat what already exists. Open incidents already list "may affect" meetings in alerts, and `monitoring.roomImpact` already shows the meetings a room's open incidents may disturb on its card. P1 now raises severity as a meeting nears. A "ready / not ready" built from the same state adds a second alert for the same fault
- What would be new is an **active** check: ask the device now (power, input, signal, mute, camera answering), shortly before the first booking, rather than trusting the last heartbeat. That needs three things that are not verified:
  1. A per-driver list of which feedback fields are real and trustworthy (`DeviceFeedback`: power, input, muted, volume, occupied, recording). Drivers marked "never tested on real hardware" cannot be trusted for this
  2. A gateway "check now" request and reply (protocol change, a `features` flag, a gateway version bump, web deployed first)
  3. A device on a gateway to run it against
- Proposed slice when we do it: one rule per room reusing the usage rule engine (`UsageRule`, so no new rule language), run at T-30 min for the first booking of the day, results shown on the room card, and an incident (`room_not_ready`) only for a failure that no open incident already covers
- Decision needed: pick 2 to 3 drivers with real devices to prove it on. Until then P3 stays off the build list

### P4. Reporting upgrade (medium)
- Build on `monthly-report`: add PDF, quarterly option, per-site or per-customer recipients (provider customers), SLA attainment and meetings-disturbed from P1
- Scrutiny: data retention is 90 days, so quarterly reports need figures **frozen at month end** (store the monthly snapshot). Otherwise a quarter cannot be rebuilt

### P5. PagerDuty and Opsgenie channels (small)
- Two channel types over the existing delivery code: Events API v2 routing key with dedup key = incident id, resolve on clear. Opsgenie alias = incident id
- No native mobile app. Mention PWA push as a possible later item only

### P6. Runbooks (medium)
- Per incident `kind` (and optionally per driver): short steps text and up to N allowlisted actions (reuse `RemoteCommand`), visible on the incident and on the ticket
- Scrutiny: every action must stay allowlisted and audited (CLAUDE.md rule). Org-editable runbooks are user content, so render as plain text or sanitised markdown only

### P7. Conferencing platform health (re-scoped 2026-10-01 after checking the vendor APIs)
- **Teams Rooms: do not build on Microsoft Graph.** `/beta/teamworkDevice` began retiring 8 Dec 2025 with no replacement ("no plans to support Graph APIs for Teams Devices"). Teams admin center device health rules and alerts retire by late Sept 2026, and monitoring moves to the Teams Rooms Pro Management portal, which has no supported API. Whether the old endpoint still answers today is **unverified** and can stop without notice, so it is not a foundation for a paid feature
- **Teams Rooms, what we can use:**
  - Crestron Flex UC-Engine: already covered. `crestron-flex.ts` reads the Teams Rooms app state and peripherals over the secure console (41797, reserved joins). Verified against a real unit
  - Other Teams hardware: a per-vendor driver (Logitech, Poly, Yealink cloud or local APIs; not investigated), or Intune Graph (inventory and compliance only, Intune-enrolled devices only). Treat as demand-led
  - Scan of the Flex UC-Engine (2026-10-01, TCP connect, all ports): open 80/443 (default IIS page), 7680 (Windows Delivery Optimization), 41794 and 41797 (Crestron CIP and secure console), 49400, 49500, 49501 (Crestron-specific, undocumented; 49501 is HTTPS and answers OPTIONS with a custom `x-sessioncookie` header, GET and POST return 405). RDP, WinRM and SMB are closed. **No generic Teams Rooms health API was found on the box.** UDP and authenticated paths were not tested
- **Webex first (best documented):** Devices and Workspaces APIs plus Workspace Integrations (fine-grained xAPI, webhooks or a message queue for selected statuses, one admin authorisation per workspace in Control Hub). Two routes: cloud-side polling like the calendar connection, or a gateway driver over the device's local xAPI. The LAN route needs no per-customer cloud consent and fits the gateway model. Verify rate limits and the auth flow before building (the docs page could not be read in full)
- **Zoom Rooms second:** REST API gives room list, status (Offline, Available, InMeeting, UnderConstruction), device lists and configuration, but no device health endpoint. Mic, camera and battery faults arrive only as Zoom Rooms Alert webhooks, so Kestrel would hold state and could miss events during downtime. Also a Zoom Rooms Control System API that has not been assessed
- Sources: MC1183294 (https://mc.merill.net/message/MC1183294), Microsoft Q&A on the teamworkDevice replacement, m365admin.handsontek.net on the Teams admin center retirement, developer.webex.com (Workspace Integrations, xAPI Query Status), developers.zoom.us (Rooms APIs) and the Zoom developer forum thread on device health

### P8. Quick wins to schedule alongside
- **QR report-a-problem**: per-room signed token URL, no login, creates a ticket with room and device state. **Security gate**: unauthenticated write, so rate limit per token and IP, length caps, no PII, honeypot or captcha, revocable token, and an entry in the security audit. Do not build before that is designed
- **CSV import and room stamping**: extends the device discovery flow just built (`feat/find-devices`); bulk validation and a dry run
- **Booking vs actual**: add a `RoomBookingDay` history table (daily summary per room, kept with the 90-day rule) so ghost-meeting and right-sizing can be computed. Needs P1's schedule trust handling first

### Built notes (P1, P2)
- **P1:** an incident that opens (device_offline, room_fault, point_alert, latency_high, network_degraded) while a meeting is on or starts within 30 minutes is raised one severity step and records `meetingsAffected` and `severityRaised` (migration `20261001120000_incident_meeting_impact`). A stale or missing calendar raises nothing. Shown as a badge on the Incidents page and counted in the monthly report. Not done: skipping an alert channel's delay for these
- **P2:** three or more `device_offline` incidents on one gateway and one IPv4 /24 within 10 minutes become one `group_outage` incident (critical, no room, owned by the gateway). Devices keep their own incidents with `parentId` set, are shown under the group, and their alerts and tickets go through the group. The group resolves when its last device is back. Org totals, platform and MSP counts skip grouped devices; per-room counts still use them. Reports leave the group out so nothing is counted twice (migration `20261001130000_incident_groups`)
- **Known limits of P2:** devices with no IPv4 address are never grouped; the first two devices alert on their own before the third tips the group; the group alert does not list affected meetings (its rooms are counted through the devices); v1 room-based incident paths are not grouped; no manual ungroup yet
- **Deploy:** run the two migrations on `kestrel-dev` first; both only add columns, an index and a foreign key

## 3. Not now, and why

- **SNMP/PoE and topology**: large, new driver surface, no customer asking. Revisit after P2 shows the grouping key is not enough
- **ServiceNow adapter**: build when a design-partner customer has an instance. Mapping fields blind wastes effort. Keep the generic webhook as the answer meanwhile
- **Predictive maintenance, AI summaries, energy, BI connectors, provider library, budget forecasting**: defer; revisit once P2 and P6 produce richer data
- **Business items the panel raised** (decisions for the owner, not code): free or longer trial tier (XiO), SOC 2 Type 2 and customer-hosted option (Innomate), data retention beyond 90 days (Innomate keeps 5 years)

## 4. Cross-cutting checks before any build

- Every new table and query carries `orgId`; new procedures use `orgProcedure` (CLAUDE.md)
- Tier gating: decide which of P1 to P7 are Basic vs Pro (pivot tiers are still open)
- New gateway behaviour needs a version bump, a `features` flag, and a deploy order (web first)
- Migrations are additive, nullable columns, applied to `kestrel-dev` first
- CI budget: batch the work, run tests locally per package, no whole-directory prettier
- Verification: unit tests per server module with the in-memory DB helper, plus a browser pass for each UI change. Real-hardware behaviour for P3 is untested until a device is on a gateway

## 5. Risks of the plan itself

- The agents' verdicts rest on marketing pages. Before positioning a feature as a differentiator, confirm with a demo or a customer conversation
- P1 and P4 are cheap but low visibility; P2 and P3 carry the product story and the risk. Do not let P1 to P5 crowd out P2
- Over-grouping in P2 and false "meeting impacted" labels in P1 both erode trust in alerts; both need tuning knobs and an audit trail from day one

## 6. Open questions for the owner

1. Is "Inanimate" Innomate?
2. Order: P1, P2, P3 first, or P4 and P5 first for sales reasons?
3. Tier split for these features
4. Is there a ServiceNow design partner?
5. Self-test v1 read-only (proposed), or do you want the active wake test now?
