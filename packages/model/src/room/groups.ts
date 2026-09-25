import { z } from 'zod';

/**
 * What a room does when a wall opens or closes and it becomes part of a new space (a combined room
 * going live, or a room going back on its own):
 * - off: the new space is turned off
 * - on: the new space is turned on (its On state)
 * - follow: on if the space it came from was on, otherwise off
 * - restore: what that space was doing the last time it was live, or off if it never was
 */
export const TransitionAction = z.enum(['off', 'on', 'follow', 'restore']);
export type TransitionAction = z.infer<typeof TransitionAction>;

export const DEFAULT_ON_OPEN: TransitionAction = 'follow';
export const DEFAULT_ON_CLOSE: TransitionAction = 'off';

export const TRANSITION_LABELS: Record<TransitionAction, string> = {
  off: 'Turn it off',
  on: 'Turn it on',
  follow: 'On if the rooms were on',
  restore: 'Back to what it was doing',
};

/**
 * A movable wall (or set of walls). When it is open, every room it touches is joined into one
 * space. A simple wall touches two rooms; a wall that opens a large room onto two others at once
 * touches three. Room ids are Kestrel Room record ids (database ids).
 */
export const Divider = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  roomIds: z.array(z.string().min(1)).min(2).max(20),
  /** What happens to the spaces this wall creates when it opens. Absent means DEFAULT_ON_OPEN. */
  onOpen: TransitionAction.optional(),
  /** What happens to the spaces this wall creates when it closes. Absent means DEFAULT_ON_CLOSE. */
  onClose: TransitionAction.optional(),
});
export type Divider = z.infer<typeof Divider>;

/** The physical layout of a room group: which rooms exist and which dividers can join them. */
export const RoomGroupSpec = z.object({
  roomIds: z.array(z.string().min(1)).min(2).max(50),
  dividers: z.array(Divider).max(100),
});
export type RoomGroupSpec = z.infer<typeof RoomGroupSpec>;

/** A Room record is either an ordinary room, or the combined room for a set of joined rooms. */
export const RoomKind = z.enum(['standard', 'combined']);
export type RoomKind = z.infer<typeof RoomKind>;
