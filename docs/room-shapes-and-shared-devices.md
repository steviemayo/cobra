# Room shapes, copies and shared devices (plan, for review before building)

Status: written 2026-10-01. Slices 1 to 3 built (PR #131). Slice 4 built in the next PR (needs migration `20261001070000_shared_devices`). The rest is plan. Extends `docs/pivot-monitoring.md` (rooms are a light grouping of devices) and replaces the v1 plan in `docs/driver-classes.md` ("Shared devices", slices 3 and 6), whose web pages were removed in M7-5.

## What the user asked for

- Room **type** (meeting, training) when adding a room is no longer useful. Remove it
- Describe the **shape** of a room once (a display, a touch panel, a few Q-SYS control points), then make **several copies**, changing each copy's addresses, connection details and control points
- Keep **shared devices**: a DSP shared by rooms with separate control points per room, and also **a control system that serves several rooms**, not only DSPs

## What exists today (checked in the code)

- A room is `Room` (name, site, area, tags, gateway, `type`). Its devices are `Device` rows: `roomId` (nullable), `kind` (active or passive), `category`, `control` (driver), `settings` (design), `values` (addresses), `sealed` (logins), `credentialSetId`, `gatewayId`, `profileId` and `configParams` (held settings), and `points` (control points, JSON)
- A device with `roomId = null` already means "a spare or shared by several rooms", but nothing says **which** rooms, and the `points` JSON belongs to the device as a whole
- The gateway already runs **one driver instance and one connection per `Device` row**, whichever room it is in. So sharing needs no gateway change
- `CredentialSet` (a login used by many devices) exists. `Area`, `tags` and `profile` exist
- v1 leftovers that are **not** the base for this: `SiteDevice`, `RoomBinding`, `Template`, `RoomDraft`. They serve old gateways (M7-6). Not reused, retired later
- There is no "copy a room" or "make N rooms" in the web app now (both were removed in M7-5). Room **type** is only a label

## Decisions proposed

| #     | Proposal |
| ----- | -------- |
| RS-1  | **Remove room type** from the new-room dialog, the room settings page and the onboarding wizard. The column stays (default `meeting`) and is dropped in a later migration, because old gateways and v1 tables read it |
| RS-2  | **A room shape is a list of device slots**, not a template with values. A slot holds: a name, category, kind (active or passive), driver, design settings, control points (with watch rules), profile and held settings, and which fields need filling per copy (address, port, login). It holds **no address and no login** (same rule as DC-5) |
| RS-3  | **Two ways in, one engine.** (a) **Copy from a room**: any existing room is a shape on the fly. (b) **Saved shapes**: a named, organisation-wide shape made from a room ("Save as shape"). Both produce the same slot list, so the creation steps are identical |
| RS-4  | **Make several copies** from the room list or the new-room dialog: pick a shape or room, say how many, and fill a grid, one row per new room. Columns: room name (with a number pattern such as "Room {n}"), area, and for every slot its address, port and login choice. Control points are edited per room too (RS-6) |
| RS-5  | **Logins are never copied.** A copy asks for a credential set per slot (or a login typed for that room). A slot with a credential set pre-fills the same set for every row |
| RS-6  | **Control points per copy.** The grid has an expandable row per slot listing its points with their address fields. Two helpers: **replace text** across a slot's point addresses (change "Room1" to "Room2" in every component name) and **number sequence** (`{n}` in an address). Points can be added or removed per room. Anything not changed stays as the shape had it |
| RS-7  | **Checks before anything is written**: duplicate addresses in the grid or already in the estate, missing required fields, a point address that repeats within one device, gateway for the site. **Test connection** for every row, and for a Q-SYS slot **verify points** with the existing read (`readPoint`) so a wrong name shows before saving. Everything or nothing in one transaction, one audit entry, as in the old bulk create (DB-7) |
| RS-8  | **A shared device is one `Device` row linked to several rooms.** One address, login, gateway, driver connection, asset record and history. New table `DeviceRoom(deviceId, roomId)` says which rooms it serves. `Device.roomId` stays as the "home" room (or null) so nothing existing breaks. A room's device list shows its own devices **and** the shared ones linked to it, marked "Shared with 2 other rooms" |
| RS-9  | **Control points belong to a room.** Each control point gets an optional `roomId` (inside the `points` JSON, additive). A shared DSP, control processor or lighting unit then holds Room A's points and Room B's points on the one device. Room pages show only their points, the device page shows all, grouped by room. A point with no `roomId` belongs to the device as a whole and shows in every linked room |
| RS-10 | **What can be shared is any device**, in three shapes, so a control system works the same as a DSP: **(a) points per room**: DSP, Crestron or other control processor (program slot or IP table entry per room), lighting processor. **(b) outlets per room**: a power controller such as the Blustream PWR, an outlet per room (a point type for an outlet is added with the PWR driver work). **(c) whole device**: a switch, a codec, a control system whose health matters to every room it serves, with no per-room slice |
| RS-11 | **Impact**: one device, one incident. If a shared device goes offline or a point goes out of bounds, the incident is listed against **each linked room** (and on the device), and each room's status shows it. A point with a `roomId` affects only that room; a whole-device fault affects all. Room usage rules and analytics can use a linked shared device's readings in each room |
| RS-12 | **Same organisation, any site** (decided 2026-10-01). A shared device is polled by one gateway, the one its home room or its own site resolves to, whatever site the rooms it serves are at. A room never gets a connection of its own to it. A device cannot serve a room of another organisation |
| RS-13 | **Shapes with shared slots.** A slot can be marked **shared**. Creating copies then asks, per slot: link to an existing shared device (pick it), or create it once and link all the new rooms to it. For a shared slot the grid has no address columns, only the points (RS-6) |
| RS-14 | **Billing and limits**: per room, as now. A shared device is counted **once** for any device-based monitor limit, not once per room, and is not an extra charge. To be confirmed against `canMonitorRoom` when building |
| RS-15 | **Delete and unlink**: removing a room unlinks its shared devices and deletes its own points on them (after listing what goes). Deleting a shared device lists every room that uses it first. Moving a device between "own" and "shared" is an edit, not a rebuild |

## Build order (each slice additive, with tests, one PR each)

1. **Remove room type** (RS-1). Small. Web only
2. **Copy a room**: server `room.copy` (devices and points, no logins, optional rename of point addresses), "Copy room" on the room page and "Start from a room" in the new-room dialog. One copy, no grid yet
3. **Several copies**: the grid, number patterns, replace-text helper, checks, test all, verify points (RS-4 to RS-7). Gateway needs nothing new
4. **Shared devices, data and display** (RS-8, RS-9, RS-11, RS-12): migration `DeviceRoom`, point `roomId`, link and unlink in the device page and room page, shared marker, incident fan-out to linked rooms, room status
5. **Saved shapes and shared slots** (RS-3b, RS-13): named shapes, "Save as shape", shared slots in the copy flow
6. **Polish and the rest**: outlet point type for power controllers (RS-10b), limits (RS-14), deletion and unlink flows (RS-15), a gateway-version check so a monitored device never lands on a gateway too old for its driver

Slices 2 and 3 answer the "copies" ask on their own. Slice 4 is the larger one (schema, status and incidents).

## Risks and things to check first

- **Status and incidents** are worked out per room today. Fan-out to linked rooms (RS-11) touches `monitoring-queries`, incident creation and the room status view. Read these before slice 4
- **Points JSON** is read by the gateway and by watched-point checks. Adding `roomId` must not change a point's id or its hash, so existing readings and incidents stay attached
- **Old gateways** ignore `roomId` on a point (harmless) but a copy to a driver newer than the gateway needs the version check in slice 6
- **Per-room addressing in a shared DSP**: two rooms may use the same component name by mistake. The checks in RS-7 and slice 4 warn on a repeat within one device
- **Control points per room** when the DSP program is the same for ten rooms: replace-text and `{n}` carry most of the work, but components that do not follow a pattern still need typing. A CSV import for points is a later step if this is common
- **Billing**: confirm how rooms and devices are counted before slice 4 (RS-14)

## Questions for the user

1. **(open)** **Saved shapes (RS-3b):** are copy-from-a-room and a bulk grid enough at first, with named shapes later in slice 5? Or are named shapes needed from the start
2. **Shared across sites (RS-12):** decided: same organisation, any site
3. **Outlets as rooms (RS-10b):** is a power controller (PWR4 outlets per room) a case you want in this, or is it a later add-on?
4. **Whole-device sharing (RS-10c):** decided: one incident that lists every room, shown in each of them
