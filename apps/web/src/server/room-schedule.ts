import type { PrismaClient } from '@kestrel/db';
import { open } from '@kestrel/crypto';
import { MAX_MEETINGS, Meetings, type RoomMeetings } from '@kestrel/model';
import {
  CalendarCredentials,
  calendarTriggers,
  meetingsBetween,
  type Deps,
  type PollSummary,
} from './calendar';

// Bookings on the panel. A room that has a calendar trigger already names its calendar, so the same
// calendar is read (read only, never written) to show what is on and what is next. The calendar
// job keeps a copy per room; a gateway that shows bookings is sent the copy with its heartbeat.
export type ScheduleDb = Pick<
  PrismaClient,
  'calendarConnection' | 'room' | 'release' | 'roomSchedule'
>;

/** How far ahead a panel is told about. A day's meetings, without the week. */
export const WINDOW_MS = 12 * 3_600_000;
/** A calendar is read again after this long, however often the job runs. */
export const REFRESH_AFTER_MS = 4 * 60_000;
/** A copy older than this is not sent: a panel would rather say nothing than say something wrong. */
export const FRESH_MS = 15 * 60_000;

const realDeps = (): Deps => ({ fetch, secretsKey: process.env.KESTREL_SECRETS_KEY });

/** Reads the calendar of every room that has one and keeps the copy up to date. */
export async function refreshSchedules(
  db: ScheduleDb,
  now = new Date(),
  deps: Deps = realDeps(),
): Promise<PollSummary> {
  const summary: PollSummary = { checked: 0, fired: 0, errors: [] };
  if (!deps.secretsKey) return summary;
  const connections = await db.calendarConnection.findMany({});
  if (connections.length === 0) return summary;

  const creds = new Map<string, CalendarCredentials>();
  for (const c of connections) {
    try {
      creds.set(
        `${c.orgId}:${c.provider}`,
        CalendarCredentials.parse({
          provider: c.provider,
          ...JSON.parse(open(c.sealed, deps.secretsKey)),
        }),
      );
    } catch {
      summary.errors.push(`${c.provider} connection for ${c.orgId} could not be read`);
    }
  }
  const orgs = new Set(connections.map((c) => c.orgId));
  const rooms = (await db.room.findMany({})).filter(
    (r) => orgs.has(r.orgId as string) && r.gatewayId && r.desiredReleaseId,
  ) as { id: string; orgId: string; desiredReleaseId: string }[];
  if (rooms.length === 0) return summary;

  const releases = await db.release.findMany({
    where: { id: { in: rooms.map((r) => r.desiredReleaseId) } },
  });
  const manifests = new Map(releases.map((r) => [r.id, r.manifest]));
  const held = new Map(
    (await db.roomSchedule.findMany({ where: { roomId: { in: rooms.map((r) => r.id) } } })).map(
      (s) => [s.roomId, s],
    ),
  );

  const to = new Date(now.getTime() + WINDOW_MS);
  for (const room of rooms) {
    const trigger = calendarTriggers(manifests.get(room.desiredReleaseId)).find((t) =>
      creds.has(`${room.orgId}:${t.provider}`),
    );
    if (!trigger) continue;
    const before = held.get(room.id);
    if (before && now.getTime() - before.fetchedAt.getTime() < REFRESH_AFTER_MS) continue;
    summary.checked++;
    try {
      const meetings = (
        await meetingsBetween(
          creds.get(`${room.orgId}:${trigger.provider}`)!,
          trigger.resourceId,
          now,
          to,
          deps,
          now.getTime(),
        )
      )
        .sort((a, b) => a.start.localeCompare(b.start))
        .slice(0, MAX_MEETINGS);
      if (before)
        await db.roomSchedule.update({
          where: { roomId: room.id },
          data: { orgId: room.orgId, meetings, fetchedAt: now },
        });
      else
        await db.roomSchedule.create({
          data: { roomId: room.id, orgId: room.orgId, meetings, fetchedAt: now },
        });
      summary.fired++;
    } catch (err) {
      summary.errors.push(
        `${room.id} schedule (${trigger.provider}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return summary;
}

/** The recent bookings of the rooms a gateway runs, for its heartbeat reply. */
export async function schedulesForGateway(
  db: Pick<PrismaClient, 'room' | 'roomSchedule'>,
  gw: { id: string; orgId: string },
  now: Date,
): Promise<RoomMeetings[]> {
  const rooms = await db.room.findMany({ where: { gatewayId: gw.id, orgId: gw.orgId } });
  if (rooms.length === 0) return [];
  const rows = await db.roomSchedule.findMany({
    where: {
      orgId: gw.orgId,
      roomId: { in: rooms.map((r) => r.id) },
      fetchedAt: { gte: new Date(now.getTime() - FRESH_MS) },
    },
  });
  return rows.flatMap((row) => {
    const parsed = Meetings.safeParse(row.meetings);
    if (!parsed.success) return [];
    // Meetings already over are no use to a panel.
    const meetings = parsed.data.filter((m) => Date.parse(m.end) > now.getTime());
    return [{ roomId: row.roomId, meetings }];
  });
}
