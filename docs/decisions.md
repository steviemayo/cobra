# Decisions log

Decisions made while building the "Next build steps" in `docs/plan.md`, newest last. Each says who decided (user = the product owner; build = made while building, open to change).

## Step C: room groups, gateway runtime (2026-09-26)

**From the user**

1. A wall is opened or closed by a person on the panel, from a **Room linking** menu. (The portal control page can do it too; a sensor is later.)
2. What happens when a wall opens or closes is **set in the portal, in the group settings**, per wall.
3. A group is **deployed as one action**: its rooms first, then its combined rooms.

**Made while building**

| #   | Decision                                                                                                                                                                                                                                                               | Why                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| C-1 | Open and close settings are per **wall** (divider), not per group. Four choices: **off**, **on**, **follow** (on if the space it came from was on, else off), **restore** (what that space was doing last time it was live). Defaults: opening = follow, closing = off | Matches the proposal the user confirmed; per wall is unambiguous because only one wall changes at a time |
| C-2 | The wall's setting applies to every **new space** the change creates: the combined room that goes live on open, and each room or smaller combined room that becomes active on close                                                                                    | One rule for both directions, no special cases                                                           |
| C-3 | New columns `RoomDivider.onOpen`, `onClose`, `open` (additive migration `20260926120000_divider_actions`). `open` is only the last state the gateway reported; the gateway owns the truth                                                                              | Working rule: gateway state survives restarts and works offline                                          |
| C-4 | The protocol carries groups in `ConfigResponse.groups` and open walls in `HeartbeatRequest.dividers`. Both default to empty, so gateways in the field keep working and the config version is unchanged for a gateway with no groups                                    | Protocol stays version 1; old fields (`combinations`) are still tolerated until step D                   |
| C-5 | A group is only sent to a gateway when **all** its ordinary rooms run on it                                                                                                                                                                                            | Rooms in a group are controlled together                                                                 |
| C-6 | Applying the migration to the shared database was **not** done by the build: the permission check refused it as a production deploy. It must be run by the user (`pnpm --filter @kestrel/db exec prisma migrate deploy`) before the release PR to `main`               | Previews and production share `kestrel-dev`                                                              |
