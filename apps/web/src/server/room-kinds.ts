// The kinds a room can be (Room.kind is free text; standard is the default).
//   standard: an ordinary room
//   combined: the room that exists while the rooms of a group are joined
//   staging:  a copy for trying changes on the real gateway before they reach a live room
// Only standard rooms are billed, and staging rooms never raise alerts or appear in usage reports.
export const STAGING = 'staging';
export const NOT_BILLED_KINDS = ['combined', STAGING] as const;

/** A Prisma `where` fragment for the rooms an organisation pays for. */
export const billedRooms = { kind: { notIn: [...NOT_BILLED_KINDS] } };

export const isBilledRoom = (room: { kind?: string | null }) =>
  !(NOT_BILLED_KINDS as readonly string[]).includes(room.kind ?? 'standard');
