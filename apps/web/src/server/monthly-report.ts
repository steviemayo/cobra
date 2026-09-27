import type { PrismaClient } from '@kestrel/db';
import { loadUsageReport, zonedDayStart, type UsageDb, type UsageReport } from './usage-analytics';

// A month's report for a customer: how much rooms were used, how often they were down and for how
// long, and how support went. It is built from data Kestrel already keeps (telemetry, incidents,
// tickets), so a month is only complete while that data is still kept (90 days). These functions
// take the database as a parameter so they can be tested without one.
export type ReportDb = UsageDb & Pick<PrismaClient, 'org' | 'incident' | 'ticket'>;

export interface ReportMonth {
  year: number;
  /** 1 to 12. */
  month: number;
}

export interface ReportIncident {
  title: string;
  room: string | null;
  severity: string;
  kind: string;
  openedAt: string;
  resolvedAt: string | null;
  /** Minutes inside the month that the incident was open. */
  minutes: number;
}

export interface RoomAvailability {
  roomId: string;
  name: string;
  downtimeMinutes: number;
  /** Share of the month the room had no open outage, 0 to 1. */
  availability: number;
}

export interface MonthlyReport {
  orgName: string;
  label: string;
  from: string;
  to: string;
  tz: string;
  generatedAt: string;
  /** Part of the month is older than the telemetry and incident history kept, so figures are low. */
  beyondRetention: boolean;
  summary: {
    rooms: number;
    hoursInUse: number;
    avgUtilisation: number | null;
    sessions: number;
    incidentsOpened: number;
    incidentsResolved: number;
    avgResolveMinutes: number | null;
    downtimeMinutes: number;
    ticketsOpened: number;
    ticketsClosed: number;
    ticketsOpenNow: number;
  };
  usage: UsageReport;
  availability: RoomAvailability[];
  incidents: ReportIncident[];
  incidentsByKind: { kind: string; count: number }[];
}

/** Incidents that mean a room or gateway was not doing its job (as opposed to a warning). */
export const OUTAGE_KINDS = ['device_offline', 'gateway_offline', 'room_fault'];
const RETENTION_DAYS = 90;
const MAX_INCIDENTS_LISTED = 25;

const monthLabel = (m: ReportMonth) =>
  new Date(Date.UTC(m.year, m.month - 1, 15)).toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The calendar month `now` falls in, in the zone. */
export function currentMonth(now: Date, tz: string): ReportMonth {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric' }).formatToParts(now);
  return { year: Number(parts.find((p) => p.type === 'year')!.value), month: Number(parts.find((p) => p.type === 'month')!.value) };
}

/** The month before `now` in the zone, so a report sent on the 1st covers the month just ended. */
export function previousMonth(now: Date, tz: string): ReportMonth {
  const { year, month } = currentMonth(now, tz);
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

type Interval = [number, number];

/** Overlapping time counted once. */
function merged(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
const minutesOf = (list: Interval[]) => list.reduce((n, [s, e]) => n + (e - s), 0) / 60_000;

export async function buildMonthlyReport(
  db: ReportDb,
  orgId: string,
  month: ReportMonth,
  tz: string,
  now = new Date(),
): Promise<MonthlyReport> {
  const from = zonedDayStart(tz, month.year, month.month);
  const end = zonedDayStart(tz, month.month === 12 ? month.year + 1 : month.year, month.month === 12 ? 1 : month.month + 1);
  // A month still under way is reported up to now.
  const to = new Date(Math.min(end.getTime(), now.getTime()));
  const f = from.getTime();
  const t = to.getTime();

  const [org, usage, incidents, rooms, tickets] = await Promise.all([
    db.org.findFirst({ where: { id: orgId }, select: { name: true } }),
    loadUsageReport(db, orgId, { from, to, tz, businessStartHour: 8, businessEndHour: 18 }),
    // Anything open at any point in the month: opened before the end and not resolved before the start.
    db.incident.findMany({
      where: { orgId, openedAt: { lte: to }, OR: [{ resolvedAt: null }, { resolvedAt: { gte: from } }] },
      orderBy: { openedAt: 'asc' },
    }),
    db.room.findMany({ where: { orgId }, select: { id: true, name: true } }),
    db.ticket.findMany({
      where: { orgId, OR: [{ createdAt: { gte: from, lte: to } }, { closedAt: { gte: from, lte: to } }, { status: { not: 'closed' } }] },
      select: { createdAt: true, closedAt: true, status: true },
    }),
  ]);

  const roomName = new Map(rooms.map((r) => [r.id, r.name]));
  const clip = (i: { openedAt: Date; resolvedAt: Date | null }): Interval => [
    Math.max(i.openedAt.getTime(), f),
    Math.min((i.resolvedAt ?? to).getTime(), t),
  ];

  const opened = incidents.filter((i) => i.openedAt.getTime() >= f);
  const resolved = incidents.filter((i) => i.resolvedAt && i.resolvedAt.getTime() >= f && i.resolvedAt.getTime() <= t);
  const resolveTimes = resolved.map((i) => (i.resolvedAt!.getTime() - i.openedAt.getTime()) / 60_000);

  // Downtime per room: outages only, overlapping ones counted once. A gateway outage is not a room's.
  const byRoom = new Map<string, Interval[]>();
  const gatewayDown: Interval[] = [];
  for (const i of incidents) {
    if (!OUTAGE_KINDS.includes(i.kind)) continue;
    const iv = clip(i);
    if (iv[1] <= iv[0]) continue;
    if (i.roomId) byRoom.set(i.roomId, [...(byRoom.get(i.roomId) ?? []), iv]);
    else gatewayDown.push(iv);
  }
  const span = Math.max(1, (t - f) / 60_000);
  const availability = rooms
    .map((r) => {
      const down = minutesOf(merged(byRoom.get(r.id) ?? []));
      return { roomId: r.id, name: r.name, downtimeMinutes: Math.round(down), availability: Math.max(0, 1 - down / span) };
    })
    .sort((a, b) => a.availability - b.availability || a.name.localeCompare(b.name));
  const downtime = Math.round([...byRoom.values()].reduce((n, list) => n + minutesOf(merged(list)), 0) + minutesOf(merged(gatewayDown)));

  const kinds = new Map<string, number>();
  for (const i of opened) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1);

  const listed: ReportIncident[] = incidents
    .map((i) => ({
      title: i.title,
      room: i.roomId ? (roomName.get(i.roomId) ?? null) : null,
      severity: i.severity,
      kind: i.kind,
      openedAt: i.openedAt.toISOString(),
      resolvedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
      minutes: Math.round(minutesOf([clip(i)])),
    }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, MAX_INCIDENTS_LISTED);

  const ticketsOpened = tickets.filter((x) => x.createdAt.getTime() >= f && x.createdAt.getTime() <= t).length;
  const ticketsClosed = tickets.filter((x) => x.closedAt && x.closedAt.getTime() >= f && x.closedAt.getTime() <= t).length;
  const withUtil = usage.rooms.filter((r) => r.utilisation !== null);

  return {
    orgName: org?.name ?? '',
    label: monthLabel(month),
    from: from.toISOString(),
    to: to.toISOString(),
    tz,
    generatedAt: now.toISOString(),
    beyondRetention: f < now.getTime() - RETENTION_DAYS * 86_400_000,
    summary: {
      rooms: rooms.length,
      hoursInUse: Math.round(usage.rooms.reduce((n, r) => n + r.inUseMinutes, 0) / 6) / 10,
      avgUtilisation: withUtil.length ? withUtil.reduce((n, r) => n + (r.utilisation ?? 0), 0) / withUtil.length : null,
      sessions: usage.rooms.reduce((n, r) => n + r.sessions, 0),
      incidentsOpened: opened.length,
      incidentsResolved: resolved.length,
      avgResolveMinutes: resolveTimes.length ? Math.round(resolveTimes.reduce((a, b) => a + b, 0) / resolveTimes.length) : null,
      downtimeMinutes: downtime,
      ticketsOpened,
      ticketsClosed,
      ticketsOpenNow: tickets.filter((x) => x.status !== 'closed').length,
    },
    usage,
    availability,
    incidents: listed,
    incidentsByKind: [...kinds].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
  };
}

// ---- Text version, for email -----------------------------------------------------------------------

const pct = (x: number | null) => (x === null ? 'n/a' : `${Math.round(x * 1000) / 10}%`);
const duration = (m: number) => (m >= 120 ? `${Math.round((m / 60) * 10) / 10} h` : `${Math.round(m)} min`);

export function reportText(r: MonthlyReport, portalUrl?: string): string {
  const s = r.summary;
  const lines = [
    `${r.orgName}: ${r.label} report`,
    '',
    'Use',
    `- ${s.rooms} rooms, ${s.hoursInUse} hours in use across ${s.sessions} sessions`,
    `- Business hours in use, on average per room: ${pct(s.avgUtilisation)}`,
    ...r.usage.rooms.slice(0, 5).map((x) => `  ${x.name}: ${pct(x.utilisation)} of business hours, ${Math.round(x.inUseMinutes / 6) / 10} h in use`),
    '',
    'Reliability',
    `- ${s.incidentsOpened} problems came up, ${s.incidentsResolved} were resolved${s.avgResolveMinutes === null ? '' : ` (average ${duration(s.avgResolveMinutes)} to resolve)`}`,
    `- Time rooms and gateways were out: ${duration(s.downtimeMinutes)}`,
    ...r.availability.filter((a) => a.downtimeMinutes > 0).slice(0, 5).map((a) => `  ${a.name}: available ${pct(a.availability)} (${duration(a.downtimeMinutes)} out)`),
    '',
    'Support',
    `- ${s.ticketsOpened} requests opened, ${s.ticketsClosed} closed, ${s.ticketsOpenNow} still open`,
    ...(r.usage.insights.length ? ['', 'Worth a look', ...r.usage.insights.slice(0, 5).map((i) => `- ${i.text}`)] : []),
    ...(r.beyondRetention ? ['', 'Part of this month is older than the history Kestrel keeps (90 days), so figures may be low.'] : []),
    ...(portalUrl ? ['', `Full report: ${portalUrl}`] : []),
  ];
  return lines.join('\n');
}
