import { z } from 'zod';

// A room's bookings, as a panel shows them. Kestrel reads the room's calendar (read only), removes
// what a private meeting must not reveal, and sends the rest to the room's gateway, which hands it
// to the panel. Times are ISO strings; the panel formats them in its own time zone.
export const Meeting = z.object({
  id: z.string().min(1).max(200),
  /** Empty for a private meeting: the panel says "Private meeting" instead. */
  title: z.string().max(200),
  /** Absent for a private meeting. */
  organiser: z.string().max(200).optional(),
  start: z.string().datetime(),
  end: z.string().datetime(),
  private: z.boolean().default(false),
});
export type Meeting = z.infer<typeof Meeting>;

/** The most meetings sent for one room. A day's bookings for one room rarely come near this. */
export const MAX_MEETINGS = 20;
export const Meetings = z.array(Meeting).max(MAX_MEETINGS);

/** The most meetings Kestrel keeps for one room: about two weeks of bookings, for the week view. */
export const MAX_STORED_MEETINGS = 300;
export const StoredMeetings = z.array(Meeting).max(MAX_STORED_MEETINGS);

/** A room's meetings as the cloud hands them to a gateway. */
export const RoomMeetings = z.object({ roomId: z.string().uuid(), meetings: Meetings });
export type RoomMeetings = z.infer<typeof RoomMeetings>;

export interface ScheduleView {
  /** The meeting that is on now, if any. */
  current: Meeting | null;
  /** The next meeting that has not started, if any. */
  next: Meeting | null;
  /**
   * While something is on: when the room is next free. Meetings that run straight into each other
   * count as one, so this is the end of the last of them. Null when nothing is on.
   */
  availableAt: Date | null;
}

/** What a panel should say about the room at `now`. */
export function scheduleView(meetings: readonly Meeting[], now: Date): ScheduleView {
  const t = now.getTime();
  const sorted = meetings
    .map((m) => ({ m, start: Date.parse(m.start), end: Date.parse(m.end) }))
    .filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const on = sorted.filter((x) => x.start <= t && x.end > t);
  // The one that ends last is the one that keeps the room busy longest.
  const current = on.reduce<(typeof sorted)[number] | null>(
    (best, x) => (best && best.end >= x.end ? best : x),
    null,
  );
  const next = sorted.find((x) => x.start > t) ?? null;

  let availableAt: Date | null = null;
  if (current) {
    let end = current.end;
    for (const x of sorted) if (x.start <= end && x.end > end) end = x.end;
    availableAt = new Date(end);
  }
  return { current: current?.m ?? null, next: next?.m ?? null, availableAt };
}
