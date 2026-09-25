import { z } from 'zod';

/**
 * A movable wall (or set of walls). When it is open, every room it touches is joined into one
 * space. A simple wall touches two rooms; a wall that opens a large room onto two others at once
 * touches three. Room ids are Kestrel Room record ids (database ids).
 */
export const Divider = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  roomIds: z.array(z.string().min(1)).min(2).max(20),
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
