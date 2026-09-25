# Staff portal, licences, support and MSPs

Status: planning draft. Decisions so far come from the planning session on 2026-09-25 (see "Decided"). Nothing here is built.

## Why

Today Kestrel has no way for its own staff to see across customers. Extending a trial, comping a pilot, or investigating a customer's problem means editing the database by hand. Customers also have no way to bring in an MSP, and support tickets have no defined owner. This plan covers four things that share one foundation (who is allowed to see and do what, across organisations):

1. A **staff portal** for Kestrel staff: every org, licences and trials, support, fleet health
2. **Licence and trial control** with a reason and an audit trail
3. **Support tickets** with a clear owner and escalation path
4. **MSPs** (managed service providers) that look after several customers

## What exists today

- Roles inside an org: `owner`, `dev`, `support`, `customer_viewer` (`OrgRole`)
- Every org-scoped procedure checks membership and filters by `orgId` (`orgProcedure`)
- Kestrel staff are a comma-separated list of emails (`KESTREL_ADMIN_EMAILS`), used only to approve marketplace listings
- `OrgBilling` holds the plan, trial end and Stripe ids. Entitlements are worked out from it
- `Ticket` and `TicketComment` belong to an org; `assignedTo` is a user id in that org
- Monitoring, incidents, deployments and gateway health all exist per org

## Decided

- **Billing:** the customer pays Kestrel directly, even when an MSP manages them. Reseller/wholesale billing (MSP pays for its customers) can be added later without changing the rest
- **MSP attachment:** an MSP is attached to a customer org or to specific sites of it, and a customer can have several MSPs (different MSPs can cover different buildings)
- **Ticket first line:** the customer's MSP if there is one, otherwise Kestrel. Anyone handling a ticket can escalate it to Kestrel staff
- **First version covers:** org directory with licence and trial controls, view-as (support sessions) with audit, a global ticket queue, and a fleet health overview

## Staff (platform) layer

- **Staff accounts**: a `StaffUser` table (user id, role). Replaces the email list; the env var only seeds the first admin. Roles: `staff_admin` (everything), `staff_support` (view-as, tickets), `staff_billing` (licences), `staff_readonly`
- **Same app, own area**: staff pages live under `/staff`, behind a separate `staffProcedure` (checks `StaffUser`, not org membership). A separate deployment on its own domain is stricter and can come later
- **MFA required** for staff accounts (Supabase MFA). Optional IP allowlist
- **Cross-org on purpose**: staff procedures are the one place the "always scope by orgId" rule does not apply, so they are a separate builder that logs every call that reads customer data beyond aggregates
- **No secrets**: staff never see signing keys, calendar credentials, panel PIN hashes or webhook secrets (already omitted from queries)

### Org directory

One row per org: plan, trial end, rooms (ordinary rooms only), gateways online, open incidents, open tickets, last activity, Stripe status. Search and filter. Click through to an org page with members, sites, billing, notes and audit.

## Licences and trials

- **Overrides** (`OrgLicenseOverride`): plan, max rooms, trial end, monitoring on/off, with an optional expiry and a **required reason**. Entitlement resolution: an active override wins over `OrgBilling`; when it expires the org falls back to its paid state
- **Stripe stays the source of truth** for paid plans. Overrides are for trials, extensions, pilots and comps
- **Notes** (`OrgNote`): free text per org, staff only
- Every change is audited (who, old value, new value, reason) and shown to the org's owner as "Kestrel adjusted your trial" in their activity log

## Support sessions (view-as)

- Staff start a session for an org with a **reason** (and optionally a ticket link) and a duration (default 60 minutes)
- **Read-only by default.** "Act as support" needs `staff_support` and a second confirmation; every change made is logged with the staff member as the actor and the org as the target
- A banner shows in the portal for the whole session ("Viewing as Kestrel staff: name"), and the customer's activity log records the session start, end and any change
- Access resolution: staff with an active session get a read-only or support-level role for that one org, through the same `orgProcedure`, so existing pages just work

## Tickets

- **Routing**: each ticket has an owner side: `msp:<org id>` or `kestrel`. New tickets go to the org's MSP if it has one covering that site, otherwise to Kestrel
- **Escalate**: moves the ticket to `kestrel`. The MSP stays as a watcher and can keep commenting
- **Comments** have visibility: `public` (the customer sees it) or `internal` (MSP and staff only)
- **Assignee** can be a member of the customer org, of the MSP org, or a staff user
- **Staff queue**: all tickets routed to Kestrel across every org, by priority and age, with filters
- **MSP queue**: tickets routed to that MSP across its customers
- Notifications by email (needs the Resend domain), plus in-app
- SLA timers and priority rules come later

## MSPs

- An MSP is an **org of its own** (`Org.kind` = `msp`), with its own members and roles. Staff can also be given an MSP role for direct customers (Kestrel acting as their MSP)
- **Grants** (`MspGrant`): MSP org, customer org, optional site ids (empty means the whole org), role (`manage`, `support`, `view`), status (`pending`, `active`, `revoked`). **Two-sided**: the customer's owner invites the MSP, the MSP's owner accepts, and either side can revoke at any time. Both sides are audited
- **Effective access**: a person from an MSP gets, in a customer org, the lower of their role in the MSP and the grant's role. Billing and invoices are not included unless the grant says so
- **Site scope**: for an MSP with site-limited grants, every query for rooms, gateways, incidents, tickets and monitoring is limited to those sites. This is the hard part: every site-aware query needs one shared filter. Plan to ship org-wide grants first, then site scope with a test for each query
- **MSP portal** (`/msp`): customers with health, open tickets and quick switch between customers

## Data model (new)

- `StaffUser` (userId, role, createdAt)
- `OrgLicenseOverride` (orgId, plan?, maxRooms?, trialEndsAt?, monitoring?, expiresAt?, reason, setBy, createdAt)
- `OrgNote` (orgId, body, authorId, createdAt)
- `SupportSession` (id, staffUserId, orgId, mode read|act, reason, ticketId?, startedAt, endsAt, endedAt)
- `Org.kind` ("customer" | "msp")
- `MspGrant` (id, mspOrgId, customerOrgId, siteIds[], role, status, invitedBy, acceptedBy, createdAt, revokedAt)
- `Ticket.routedTo` ("kestrel" or "msp:<org id>"), `TicketComment.visibility`, `Ticket.escalatedAt`
- Audit entries gain an optional `onBehalfOfOrgId` and `staffUserId`

All migrations additive first, as with room groups, because previews and production share one database.

## Build order

1. **Staff foundation**: `StaffUser`, `staffProcedure`, `/staff` shell, MFA, org directory (read only), audit, move marketplace review here
2. **Licences**: overrides, entitlement resolution, controls, notes, customer-visible log entries
3. **Support sessions**: read-only view-as with banner and audit, then act mode
4. **Ticket queue**: routing field, comment visibility, escalation, staff queue
5. **MSP**: `Org.kind`, grants and invites, effective access for org-wide grants, MSP portal. Then site-scoped grants
6. **Fleet health**: gateways offline, incidents and failed deployments across customers

Slices 1 and 2 give the most value fastest and touch the least. Slice 5 changes the access core, so it gets the most tests.

## Open questions

1. Should a customer be able to **block** Kestrel staff view-as for their org (enterprise customers often ask)? Proposed: allowed, but staff can still start a session with a ticket link when a customer asks for help
2. Do MSPs need **their own branding** on the customer panels and portal (white label)? Later
3. Do we need **audit retention** rules and export (for customers who ask)?
4. **Notifications**: email is blocked on the Resend domain. Teams/webhook for MSPs in the meantime?
5. **SLAs and priorities**: are they needed at launch, or after the first customers?
6. Should the **marketplace review** move into the staff portal now? Proposed: yes, in slice 1
7. Who are the first **staff users**, and do we want one separate `staff_billing` person from day one?
8. A **separate domain and deployment** for the staff portal: worth it before real customers?
