import type { PrismaClient } from '@kestrel/db';

// Maintenance windows (docs/pivot-monitoring.md, "Support"): times when nothing about a site, room or
// device should alert or open a ticket. Functions take the database as a parameter.
export type MaintenanceDb = Pick<PrismaClient, 'maintenanceWindow' | 'room'>;

const DAY_MS = 86_400_000;
export const WINDOW_SCOPES = ['org', 'site', 'room', 'device'] as const;
export type WindowScope = (typeof WINDOW_SCOPES)[number];
export const WINDOW_REPEATS = ['none', 'daily', 'weekly'] as const;

export interface WindowRow {
  id: string;
  orgId: string;
  name: string;
  scope: string;
  scopeId: string | null;
  startsAt: Date;
  endsAt: Date;
  repeat: string;
  repeatUntil: Date | null;
}

/** Whether a window covers this moment, counting its repeats. */
export function windowActive(w: WindowRow, now: Date): boolean {
  const t = now.getTime();
  const start = w.startsAt.getTime();
  const length = w.endsAt.getTime() - start;
  if (length <= 0) return false;
  if (w.repeat === 'none') return t >= start && t < w.endsAt.getTime();
  const step = w.repeat === 'weekly' ? 7 * DAY_MS : DAY_MS;
  if (t < start) return false;
  if (w.repeatUntil && t > w.repeatUntil.getTime() + step) return false;
  const k = Math.floor((t - start) / step);
  return t - (start + k * step) < length;
}

/** The device an incident is about, from its subject ("device:<id>..." or the older "<room>:<device>"). */
export function deviceOfSubject(subject: string): string | null {
  const m = /^device:([0-9a-f-]{36})/i.exec(subject);
  return m ? m[1]! : null;
}

export interface MaintenanceTarget {
  roomId?: string | null;
  deviceId?: string | null;
  siteId?: string | null;
}

/** Whether something is inside an active window: the whole organisation's, its site's, its room's or its own. */
export async function inMaintenance(
  db: MaintenanceDb,
  orgId: string,
  target: MaintenanceTarget,
  now: Date,
): Promise<boolean> {
  // A database without the table (older tests) has no windows.
  if (!db.maintenanceWindow) return false;
  const windows = (await db.maintenanceWindow.findMany({
    where: { orgId, startsAt: { lte: new Date(now.getTime() + 1) } },
  })) as WindowRow[];
  const active = windows.filter((w) => windowActive(w, now));
  if (active.length === 0) return false;
  let siteId = target.siteId ?? null;
  if (!siteId && target.roomId)
    siteId = (await db.room.findFirst({ where: { id: target.roomId, orgId } }))?.siteId ?? null;
  return active.some(
    (w) =>
      w.scope === 'org' ||
      (w.scope === 'site' && w.scopeId !== null && w.scopeId === siteId) ||
      (w.scope === 'room' && w.scopeId !== null && w.scopeId === target.roomId) ||
      (w.scope === 'device' && w.scopeId !== null && w.scopeId === target.deviceId),
  );
}

type Result<T = { id: string }> = { ok: true; value: T } | { ok: false; message: string };

export async function createWindow(
  db: MaintenanceDb & Pick<PrismaClient, 'site' | 'device'>,
  input: {
    orgId: string;
    name: string;
    scope: WindowScope;
    scopeId?: string | null;
    startsAt: Date;
    endsAt: Date;
    repeat?: string;
    repeatUntil?: Date | null;
    reason?: string | null;
    userId: string | null;
  },
): Promise<Result> {
  if (input.endsAt.getTime() <= input.startsAt.getTime())
    return { ok: false, message: 'It must end after it starts' };
  if (input.endsAt.getTime() - input.startsAt.getTime() > 31 * DAY_MS)
    return { ok: false, message: 'A window can be at most 31 days long' };
  const repeat = input.repeat ?? 'none';
  if (!WINDOW_REPEATS.includes(repeat as never)) return { ok: false, message: 'Unknown repeat' };
  if (input.scope !== 'org') {
    if (!input.scopeId) return { ok: false, message: 'Choose what it covers' };
    const found =
      input.scope === 'site'
        ? await db.site.findFirst({ where: { id: input.scopeId, orgId: input.orgId } })
        : input.scope === 'room'
          ? await db.room.findFirst({ where: { id: input.scopeId, orgId: input.orgId } })
          : await db.device.findFirst({ where: { id: input.scopeId, orgId: input.orgId } });
    if (!found) return { ok: false, message: 'That is not in this organisation' };
  }
  const row = await db.maintenanceWindow.create({
    data: {
      orgId: input.orgId,
      name: input.name,
      scope: input.scope,
      scopeId: input.scope === 'org' ? null : (input.scopeId ?? null),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      repeat,
      repeatUntil: input.repeatUntil ?? null,
      reason: input.reason ?? null,
      createdBy: input.userId,
    },
  });
  return { ok: true, value: { id: row.id } };
}

export async function deleteWindow(db: MaintenanceDb, orgId: string, id: string): Promise<Result> {
  const row = await db.maintenanceWindow.findFirst({ where: { id, orgId } });
  if (!row) return { ok: false, message: 'No such window' };
  await db.maintenanceWindow.delete({ where: { id } });
  return { ok: true, value: { id } };
}

/** Windows that are active now or start within the next `days` days, soonest first. */
export async function upcomingWindows(db: MaintenanceDb, orgId: string, now: Date, days = 60) {
  const rows = (await db.maintenanceWindow.findMany({
    where: { orgId },
    orderBy: { startsAt: 'asc' },
  })) as WindowRow[];
  const horizon = now.getTime() + days * DAY_MS;
  return rows.filter((w) => {
    if (windowActive(w, now)) return true;
    if (w.repeat === 'none')
      return w.endsAt.getTime() > now.getTime() && w.startsAt.getTime() <= horizon;
    return !w.repeatUntil || w.repeatUntil.getTime() >= now.getTime();
  });
}

/** The times a window covers between `from` and `to`, one entry per repeat, clipped to the range. */
export function windowOccurrences(
  w: WindowRow,
  from: Date,
  to: Date,
): { start: Date; end: Date }[] {
  const start = w.startsAt.getTime();
  const length = w.endsAt.getTime() - start;
  if (length <= 0) return [];
  const step = w.repeat === 'weekly' ? 7 * DAY_MS : w.repeat === 'daily' ? DAY_MS : 0;
  const out: { start: Date; end: Date }[] = [];
  const last = step === 0 ? 0 : Math.max(0, Math.ceil((to.getTime() - start) / step));
  const first = step === 0 ? 0 : Math.max(0, Math.floor((from.getTime() - start - length) / step));
  for (let k = first; k <= last; k++) {
    const s = start + k * step;
    if (w.repeatUntil && s > w.repeatUntil.getTime() + step) break;
    if (s < to.getTime() && s + length > from.getTime())
      out.push({
        start: new Date(Math.max(s, from.getTime())),
        end: new Date(Math.min(s + length, to.getTime())),
      });
  }
  return out;
}

// ---- Maintenance mode: a window that starts now, for a room, site or the whole organisation ---------

/** The name a "maintenance mode" window carries, so it can be found and ended again. */
export const MAINTENANCE_MODE_NAME = 'Maintenance mode';

export async function startMaintenanceMode(
  db: MaintenanceDb & Pick<PrismaClient, 'site' | 'device'>,
  input: {
    orgId: string;
    scope: 'org' | 'site' | 'room';
    scopeId?: string | null;
    hours: number;
    reason?: string | null;
    userId: string | null;
  },
  now: Date,
): Promise<Result> {
  return createWindow(db, {
    orgId: input.orgId,
    name: MAINTENANCE_MODE_NAME,
    scope: input.scope,
    scopeId: input.scopeId ?? null,
    startsAt: now,
    endsAt: new Date(now.getTime() + input.hours * 3_600_000),
    reason: input.reason ?? null,
    userId: input.userId,
  });
}

/** Ends maintenance mode early: its windows covering this scope stop now. */
export async function endMaintenanceMode(
  db: MaintenanceDb,
  input: { orgId: string; scope: 'org' | 'site' | 'room'; scopeId?: string | null },
  now: Date,
): Promise<number> {
  const rows = (await db.maintenanceWindow.findMany({
    where: {
      orgId: input.orgId,
      name: MAINTENANCE_MODE_NAME,
      scope: input.scope,
      scopeId: input.scope === 'org' ? null : (input.scopeId ?? null),
    },
  })) as WindowRow[];
  let ended = 0;
  for (const w of rows.filter((w) => windowActive(w, now))) {
    await db.maintenanceWindow.update({ where: { id: w.id }, data: { endsAt: now } });
    ended += 1;
  }
  return ended;
}
