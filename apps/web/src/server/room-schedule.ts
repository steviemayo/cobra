import type { PrismaClient } from '@kestrel/db';
import {
  MAX_MEETINGS,
  MAX_STORED_MEETINGS,
  StoredMeetings,
  type Meeting,
  type RoomMeetings,
} from '@kestrel/model';
import {
  calendarTriggers,
  meetingsBetween,
  openProfile,
  type CalendarCredentials,
  type Deps,
  type PollSummary,
} from './calendar';

// Room bookings. Each room names a calendar profile (Settings > Calendars) and its own calendar in
// it. Kestrel reads that calendar (read only, never written) and keeps a copy of about two weeks of
// bookings per room, refreshed by the sweep. The copy feeds fault alerts ("may affect the 07:30
// meeting"), maintenance clash checks and, for older gateways, the panel. The week view reads the
// calendar live.
export type ScheduleDb = Pick<
  PrismaClient,
  'calendarConnection' | 'room' | 'release' | 'roomSchedule'
>;

/** How far ahead an older gateway's panel is told about. A day's meetings, without the week. */
export const WINDOW_MS = 12 * 3_600_000;
/** How far ahead Kestrel keeps a copy, for alerts and maintenance checks. */
export const STORE_AHEAD_MS = 14 * 86_400_000;
/** A calendar is read again after this long, however often the job runs. */
export const REFRESH_AFTER_MS = 4 * 60_000;
/** A copy older than this is not used: Kestrel would rather say nothing than say something wrong. */
export const FRESH_MS = 15 * 60_000;
/** A fault is said to "may affect" meetings on now or starting within this long. */
export const AFFECT_AHEAD_MS = 12 * 3_600_000;

const realDeps = (): Deps => ({ fetch, secretsKey: process.env.KESTREL_SECRETS_KEY });

/** The calendar a room reads: a profile and the room's own address in it. */
export function roomCalendar(room: {
  calendarConnectionId?: string | null;
  calendarResource?: string | null;
}): { connectionId: string; resource: string } | null {
  return room.calendarConnectionId && room.calendarResource
    ? { connectionId: room.calendarConnectionId, resource: room.calendarResource }
    : null;
}

/** Reads one room's calendar and saves the copy. Throws when the calendar can't be read. */
export async function storeSchedule(
  db: Pick<PrismaClient, 'roomSchedule'>,
  room: { id: string; orgId: string },
  creds: CalendarCredentials,
  resource: string,
  now: Date,
  deps: Deps,
  exists: boolean,
): Promise<Meeting[]> {
  const to = new Date(now.getTime() + STORE_AHEAD_MS);
  const meetings = (
    await meetingsBetween(creds, resource, now, to, deps, now.getTime(), MAX_STORED_MEETINGS)
  )
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, MAX_STORED_MEETINGS);
  if (exists)
    await db.roomSchedule.update({
      where: { roomId: room.id },
      data: { orgId: room.orgId, meetings, fetchedAt: now },
    });
  else
    await db.roomSchedule.create({
      data: { roomId: room.id, orgId: room.orgId, meetings, fetchedAt: now },
    });
  return meetings;
}

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
    const opened = openProfile(c, deps.secretsKey);
    if (opened) creds.set(c.id, opened);
    else summary.errors.push(`calendar profile "${c.name}" for ${c.orgId} could not be read`);
  }
  const orgs = new Set(connections.map((c) => c.orgId));
  const rooms = (await db.room.findMany({})).filter((r) => orgs.has(r.orgId));

  // Rooms set up before profiles existed name their calendar in a calendar trigger of the deployed
  // design. They keep working, with the organisation's first profile of that provider.
  const legacy = rooms.filter((r) => !roomCalendar(r) && r.gatewayId && r.desiredReleaseId);
  const manifests = new Map<string, unknown>();
  if (legacy.length)
    for (const rel of await db.release.findMany({
      where: { id: { in: legacy.map((r) => r.desiredReleaseId as string) } },
    }))
      manifests.set(rel.id, rel.manifest);

  const targets: { room: (typeof rooms)[number]; connectionId: string; resource: string }[] = [];
  for (const room of rooms) {
    const own = roomCalendar(room);
    if (own) {
      targets.push({ room, ...own });
      continue;
    }
    const trigger = calendarTriggers(manifests.get(room.desiredReleaseId ?? '')).find((t) =>
      connections.some((c) => c.orgId === room.orgId && c.provider === t.provider),
    );
    const profile = trigger
      ? connections.find((c) => c.orgId === room.orgId && c.provider === trigger.provider)
      : undefined;
    if (trigger && profile)
      targets.push({ room, connectionId: profile.id, resource: trigger.resourceId });
  }
  if (targets.length === 0) return summary;

  const held = new Map(
    (
      await db.roomSchedule.findMany({ where: { roomId: { in: targets.map((t) => t.room.id) } } })
    ).map((s) => [s.roomId, s]),
  );
  for (const { room, connectionId, resource } of targets) {
    const c = creds.get(connectionId);
    if (!c) continue;
    const before = held.get(room.id);
    if (before && now.getTime() - before.fetchedAt.getTime() < REFRESH_AFTER_MS) continue;
    summary.checked++;
    try {
      await storeSchedule(db, room, c, resource, now, deps, !!before);
      summary.fired++;
    } catch (err) {
      summary.errors.push(
        `${room.id} schedule (${c.provider}): ${err instanceof Error ? err.message : String(err)}`,
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
    const parsed = StoredMeetings.safeParse(row.meetings);
    if (!parsed.success) return [];
    // A panel wants the day ahead: meetings already over, or days away, are no use to it.
    const meetings = parsed.data
      .filter(
        (m) => Date.parse(m.end) > now.getTime() && Date.parse(m.start) < now.getTime() + WINDOW_MS,
      )
      .slice(0, MAX_MEETINGS);
    return [{ roomId: row.roomId, meetings }];
  });
}

/**
 * The meetings a fault in this room may disturb: on now, or starting within the next 12 hours.
 * Private meetings come back with no title or organiser (shown as "Busy"). Empty when the room has
 * no calendar or its copy is stale.
 */
export async function affectedMeetings(
  db: Partial<Pick<PrismaClient, 'roomSchedule'>>,
  orgId: string,
  roomId: string,
  now: Date,
): Promise<{ meetings: Meeting[]; more: number }> {
  // A database without the table (older tests) has no calendars.
  if (!db.roomSchedule) return { meetings: [], more: 0 };
  const row = await db.roomSchedule.findFirst({
    where: { roomId, orgId, fetchedAt: { gte: new Date(now.getTime() - FRESH_MS) } },
  });
  const parsed = row ? StoredMeetings.safeParse(row.meetings) : null;
  if (!parsed?.success) return { meetings: [], more: 0 };
  const hits = parsed.data
    .filter(
      (m) =>
        Date.parse(m.end) > now.getTime() && Date.parse(m.start) <= now.getTime() + AFFECT_AHEAD_MS,
    )
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((m) => (m.private ? { ...m, title: '', organiser: undefined } : m));
  return { meetings: hits.slice(0, 5), more: Math.max(0, hits.length - 5) };
}
