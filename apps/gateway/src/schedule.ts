import type { Meeting, RoomMeetings } from '@kestrel/model';

/** Bookings the cloud has not confirmed for this long are no longer shown: better blank than wrong. */
export const STALE_MS = 20 * 60_000;

/**
 * What the gateway last heard about each room's bookings. The cloud sends today's meetings with
 * each heartbeat; panels work out "on now" and "next" themselves from their own clock, so a panel
 * stays right between heartbeats and while the cloud cannot be reached, until the data goes stale.
 */
export class ScheduleStore {
  private readonly rooms = new Map<string, { meetings: Meeting[]; json: string; at: number }>();
  private readonly listeners = new Set<(roomId: string) => void>();

  /** Take what the cloud sent. Rooms it did not mention keep what they had until it goes stale. */
  apply(list: readonly RoomMeetings[], now = Date.now()): void {
    for (const { roomId, meetings } of list) {
      const json = JSON.stringify(meetings);
      const before = this.rooms.get(roomId);
      this.rooms.set(roomId, { meetings, json, at: now });
      if (!before || before.json !== json) this.emit(roomId);
    }
    this.expire(now);
  }

  /** Forget rooms whose bookings have not been confirmed lately, and tell their panels. */
  expire(now = Date.now()): void {
    for (const [roomId, entry] of this.rooms) {
      if (now - entry.at <= STALE_MS) continue;
      this.rooms.delete(roomId);
      this.emit(roomId);
    }
  }

  /** The room's meetings, or null when they are not known right now. */
  get(roomId: string, now = Date.now()): Meeting[] | null {
    const entry = this.rooms.get(roomId);
    return entry && now - entry.at <= STALE_MS ? entry.meetings : null;
  }

  onChange(listener: (roomId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(roomId: string) {
    for (const l of this.listeners) l(roomId);
  }
}
