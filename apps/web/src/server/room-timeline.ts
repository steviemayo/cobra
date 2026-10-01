import type { PrismaClient } from '@kestrel/db';
import { validZone, weekDays, weekStart } from '../lib/week';
import { meetingsBetween, openProfile, type Deps } from './calendar';
import { deviceOfSubject, windowOccurrences, type WindowRow } from './maintenance';
import { asBusy, type WeekMeeting } from './room-calendar';
import { roomCalendar } from './room-schedule';

// The room timeline: one day of a room with its bookings on top and a lane for each device below,
// so a fault someone reports ("it didn't work in my 2pm meeting") can be matched to what was on.
// Bookings come from the calendar read live and from the history Kestrel keeps (a booking the
// calendar no longer returns is still there). Read only: nothing is written to any calendar.
export type TimelineDb = Pick<
  PrismaClient,
  'room' | 'site' | 'device' | 'incident' | 'calendarConnection' | 'maintenanceWindow'
> &
  Partial<Pick<PrismaClient, 'roomBooking'>>;

const DEFAULT_ZONE = 'Australia/Sydney';
const DAY_LIMIT = 100;
/** Not about a fault: left off the timeline. */
const IGNORED_KINDS = ['pm_overdue'];
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export interface TimelineIncident {
  id: string;
  kind: string;
  severity: string;
  title: string;
  start: string;
  /** Null while it is still open. */
  end: string | null;
  acknowledged: boolean;
}

export interface TimelineLane {
  /** Null for the room's own lane (faults about the room, not one device). */
  deviceId: string | null;
  name: string;
  category: string | null;
  /** device: a device in the room. room: faults about the room itself. gateway: its gateway's faults. */
  kind: 'device' | 'room' | 'gateway';
  incidents: TimelineIncident[];
}

export interface TimelineView {
  timezone: string;
  /** Midnight at the start of the day in the site's zone, and the next midnight, as instants. */
  dayStart: string;
  dayEnd: string;
  meetings: WeekMeeting[];
  windows: { id: string; name: string; start: string; end: string }[];
  /** Lanes with an incident in the day first (earliest first), then the rest by name. */
  lanes: TimelineLane[];
  /** live: read from the calendar just now. history: only what Kestrel kept. none: no bookings known. */
  source: 'live' | 'history' | 'none';
  /** Why the calendar couldn't be read, when a calendar is set. */
  problem: string | null;
  configured: boolean;
}

const realDeps = (): Deps => ({ fetch, secretsKey: process.env.KESTREL_SECRETS_KEY });

/** The device an incident is about: "device:<id>…", or the older "<room>:<device>". */
function incidentDevice(subject: string): string | null {
  const m = new RegExp(`^${UUID}:(${UUID})$`, 'i').exec(subject);
  return deviceOfSubject(subject) ?? (m ? m[1]! : null);
}

export async function roomTimeline(
  db: TimelineDb,
  room: {
    id: string;
    orgId: string;
    siteId: string;
    gatewayId: string | null;
    calendarConnectionId: string | null;
    calendarResource: string | null;
  },
  at: Date,
  deps: Deps = realDeps(),
  now = new Date(),
): Promise<TimelineView> {
  const site = await db.site.findFirst({ where: { id: room.siteId } });
  const timezone = site?.timezone && validZone(site.timezone) ? site.timezone : DEFAULT_ZONE;
  const days = weekDays(weekStart(at, timezone), timezone);
  const day = days.find((d) => d.start <= at && at < d.end) ?? days[0]!;
  const { start, end } = day;

  // ---- Bookings: the calendar now, plus what Kestrel kept --------------------------------------
  const byKey = new Map<string, WeekMeeting>();
  const kept = db.roomBooking
    ? await db.roomBooking
        .findMany({
          where: {
            roomId: room.id,
            orgId: room.orgId,
            startsAt: { lt: end },
            endsAt: { gt: start },
          },
          orderBy: { startsAt: 'asc' },
          take: DAY_LIMIT,
        })
        .catch(() => [])
    : [];
  for (const b of kept) {
    const m = asBusy({
      id: b.eventId,
      title: b.title,
      organiser: b.organiser ?? undefined,
      start: b.startsAt.toISOString(),
      end: b.endsAt.toISOString(),
      private: b.private,
    });
    byKey.set(`${b.eventId}@${b.startsAt.getTime()}`, m);
  }

  const cal = roomCalendar(room);
  let source: TimelineView['source'] = kept.length ? 'history' : 'none';
  let problem: string | null = null;
  if (cal) {
    try {
      const profile = await db.calendarConnection.findFirst({
        where: { id: cal.connectionId, orgId: room.orgId },
      });
      if (!profile || !deps.secretsKey) throw new Error('The calendar profile is not available');
      const creds = openProfile(profile, deps.secretsKey);
      if (!creds) throw new Error('The calendar profile could not be read');
      const live = await meetingsBetween(
        creds,
        cal.resource,
        start,
        end,
        deps,
        now.getTime(),
        DAY_LIMIT,
      );
      // What the calendar says now wins over what was kept (a moved or renamed booking).
      for (const m of live) byKey.set(`${m.id}@${new Date(m.start).getTime()}`, asBusy(m));
      source = 'live';
    } catch (e) {
      problem = e instanceof Error ? e.message : 'The calendar could not be read';
    }
  }
  const meetings = [...byKey.values()].sort((a, b) => a.start.localeCompare(b.start));
  if (!meetings.length && source !== 'live') source = 'none';

  // ---- Maintenance windows ---------------------------------------------------------------------
  const windows = (
    (await db.maintenanceWindow.findMany({ where: { orgId: room.orgId } })) as WindowRow[]
  )
    .filter(
      (w) =>
        w.scope === 'org' ||
        (w.scope === 'site' && w.scopeId === room.siteId) ||
        (w.scope === 'room' && w.scopeId === room.id),
    )
    .flatMap((w) =>
      windowOccurrences(w, start, end).map((o) => ({
        id: w.id,
        name: w.name,
        start: o.start.toISOString(),
        end: o.end.toISOString(),
      })),
    );

  // ---- Devices and incidents -------------------------------------------------------------------
  const devices = await db.device.findMany({
    where: {
      orgId: room.orgId,
      status: { not: 'retired' },
      OR: [{ roomId: room.id }, { rooms: { some: { roomId: room.id } } }],
    },
    orderBy: { name: 'asc' },
  });
  const gatewayIds = [
    ...new Set(
      [room.gatewayId, ...devices.map((d) => d.gatewayId)].filter((g): g is string => !!g),
    ),
  ];
  const incidents = await db.incident.findMany({
    where: {
      orgId: room.orgId,
      kind: { notIn: IGNORED_KINDS },
      openedAt: { lt: end },
      AND: [{ OR: [{ resolvedAt: null }, { resolvedAt: { gt: start } }] }],
      OR: [
        { roomId: room.id },
        { roomIds: { has: room.id } },
        // A gateway being offline stops every room behind it.
        ...(gatewayIds.length ? [{ roomId: null, gatewayId: { in: gatewayIds } }] : []),
      ],
    },
    orderBy: { openedAt: 'asc' },
    take: 500,
  });

  const lane = (l: TimelineLane) => l;
  const lanes = new Map<string, TimelineLane>();
  for (const d of devices)
    // A passive device nobody can see the state of has no history to show.
    if (d.kind === 'active' || d.online !== null)
      lanes.set(
        d.id,
        lane({ deviceId: d.id, name: d.name, category: d.category, kind: 'device', incidents: [] }),
      );
  const roomLane = lane({
    deviceId: null,
    name: 'Room',
    category: null,
    kind: 'room',
    incidents: [],
  });
  const gatewayLane = lane({
    deviceId: null,
    name: 'Gateway and network',
    category: null,
    kind: 'gateway',
    incidents: [],
  });
  for (const i of incidents) {
    const entry: TimelineIncident = {
      id: i.id,
      kind: i.kind,
      severity: i.severity,
      title: i.title,
      start: i.openedAt.toISOString(),
      end: i.resolvedAt?.toISOString() ?? null,
      acknowledged: i.acknowledgedAt !== null,
    };
    const deviceId = incidentDevice(i.subject);
    const own = deviceId ? devices.find((d) => d.id === deviceId) : undefined;
    if (own) {
      // A device that was hidden for having no state is shown once it has an incident.
      if (!lanes.has(own.id))
        lanes.set(
          own.id,
          lane({
            deviceId: own.id,
            name: own.name,
            category: own.category,
            kind: 'device',
            incidents: [],
          }),
        );
      lanes.get(own.id)!.incidents.push(entry);
    } else if (i.roomId === null || (i.roomId !== room.id && !i.roomIds.includes(room.id))) {
      gatewayLane.incidents.push(entry);
    } else roomLane.incidents.push(entry);
  }

  const first = (l: TimelineLane) => l.incidents[0]?.start ?? '';
  const withFaults = [...lanes.values(), roomLane, gatewayLane].filter((l) => l.incidents.length);
  const quiet = [...lanes.values()].filter((l) => !l.incidents.length);
  withFaults.sort((a, b) => first(a).localeCompare(first(b)) || a.name.localeCompare(b.name));

  return {
    timezone,
    dayStart: start.toISOString(),
    dayEnd: end.toISOString(),
    meetings,
    windows,
    lanes: [...withFaults, ...quiet],
    source,
    problem,
    configured: !!cal,
  };
}
