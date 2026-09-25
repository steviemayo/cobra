# Room groups and combined rooms (redesign)

Status: design draft. Replaces the original "room combinations" feature (primary/secondary rooms with follow/blank), which was incorrect and is being removed. Decisions come from the panel UI planning session (see `docs/panel-ui-requirements.md`, Room Linking).

## Terms

- **Room**: one physical space with its own program, as today (devices, activities, panel)
- **Room group**: rooms in one site that can be physically joined by movable walls
- **Divider**: a movable wall (or set of walls) that, when open, joins the rooms it touches into one space. Named by the dev, e.g. "Wall A". A divider touches two or more rooms: a simple wall touches 2; a wall that opens a large room onto two others at once touches 3
- **Combined room**: a room that exists when a particular set of rooms is joined (e.g. "Rooms 1 + 2"). It is an ordinary Room record with its own program, draft, releases and panel. Its program starts out derived from its members and is then edited like any other
- **Configuration**: which dividers are open right now. Determines which combined rooms are live and which member rooms are separate

## Only physical combinations

No assumption that rooms are in a line or that walls are equal. Example: rooms A B C D in a line plus a large room L that opens onto B and C together. Dividers: A-B, B-C, C-D, and L-B-C (one divider touching three rooms).

A set of rooms is a combined room if it is the union of dividers that connect through shared rooms. Kestrel enumerates these from the dividers; there is no fixed upper limit, but the portal stops and explains if a group would produce an unreasonable number (default cap 200 combined rooms).

For 5 rooms in a line that is 10 combined rooms plus the 5 separate rooms (15 programs), not 26.

## What the portal does

1. Create a group: name, site, and the member rooms. All members must run on the same gateway (the portal says so and blocks otherwise)
2. Add dividers: name, and which rooms each touches
3. The portal lists every combined room it derives, and how many
4. **Create combined rooms**: makes each combined room as a normal room with a derived draft
5. Devs edit each combined room (mostly to add the cross-room connections the derivation cannot know), then deploy the group's rooms together
6. Editing dividers later adds or retires combined rooms. A combined room that has been deployed is never deleted silently: the portal asks the dev to retire it first

## Derived program (starting point)

For a combined room over member rooms R1..Rn:

- Devices, ports, connections, groups, states, triggers of each member are copied in with ids prefixed by the member ("r1__display1") and names prefixed by the room name
- One combined display group holds every member display; one combined audio zone holds every member audio output; mode follows
- For each activity kind the members share (Present, Video call, Record) there is one activity. Its sources are the members' sources (labelled "Room 1: Laptop 1"), targeting the combined group
- The combined Off / On states run every member's Off / On actions
- Cross-room routing cannot be guessed. The validator flags unconnected sources; the dev adds the links (e.g. through the shared network video matrix). Until then the combined room will not validate for deployment

## Runtime (next slice, not built)

- The gateway owns the configuration (which dividers are open); it survives restarts and works with no cloud
- When the dividers make a component live, that combined room's program runs and its member rooms are suspended (they must not both drive the same devices). When the divider closes, the combined room stops and the members resume
- Transition rules per group (dev sets defaults): opening: if any member was on, the combined room starts on; closing: members go Off, or restore what they had
- Panels: every member's panel shows the live combined room's UI (mirrored), so people in any of the joined rooms can control it
- Divider state comes from a panel action, the portal, or a sensor (later)

## Data model

- `RoomGroup`: id, orgId, siteId, name
- `RoomDivider`: id, groupId, name, roomIds (2 or more)
- `Room` gains: `groupId` (nullable), `kind` ("standard" or "combined"), `memberRoomIds` (for combined rooms)
- Billing and trial limits count `kind = standard` rooms only: combined rooms are derived and are not billed
- The old `RoomCombination` table stays until the new version is deployed everywhere, then a follow-up migration drops it. Dropping it in the same release would break the running production code, which shares the database with previews

## Slices (status)

Slice 1 and 2 are built. The migration `room_groups` is additive and has been applied to `kestrel-dev`.

1. Pure logic with tests: divider validation, combined-room enumeration, program derivation (`packages/model`, `packages/engine`)
2. Database (additive migration) and portal: create groups and dividers, list derived rooms, create combined rooms; remove the old combinations page, router and panel banner
3. Gateway runtime: configuration, suspend/resume, transitions, panel mirroring; remove the old coordinator
4. Follow-up migration dropping `RoomCombination`
