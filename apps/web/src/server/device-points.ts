import { Prisma, type PrismaClient } from '@kestrel/db';
import {
  BUILT_IN_DRIVERS,
  ControlPoint,
  DeviceControl,
  POINT_TYPE_LABEL,
  type DeviceReport,
} from '@kestrel/model';
import { linkedRoomIds, roomsServedBy } from './device-sharing';
import { openIncident, resolveIncident, type AlertJob, type MonitoringDb } from './monitoring';

// Control points on a monitored device (docs/decisions.md QS-1..): the things inside a DSP or
// similar (a gain block, a router, a named control) that are read through the device's driver, shown
// on its page, and optionally watched, so an incident is raised when one is out of bounds. The cloud
// keeps the list and sends it to the gateway in the signed device set; the gateway reports back what
// each point reads and whether each watch holds.
export type PointsDb = Pick<PrismaClient, 'device' | 'deviceEvent' | 'incident'> &
  Partial<Pick<PrismaClient, 'deviceRoom'>>;

export const MAX_POINTS = 200;

/** The points this device has, as stored. Anything that no longer parses is dropped. */
export function pointsOf(stored: unknown): ControlPoint[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((p) => {
    const parsed = ControlPoint.safeParse(p);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Whether these points suit the device's driver: it supports control points at all, each point's
 * type is one it can read, and the parts of the address it needs are filled in. Null when fine,
 * otherwise what is wrong in plain words.
 */
export function validatePoints(control: unknown, points: ControlPoint[]): string | null {
  if (points.length > MAX_POINTS) return `A device can have at most ${MAX_POINTS} control points`;
  const ids = new Set<string>();
  for (const p of points) {
    if (ids.has(p.id)) return `Two control points share the id "${p.id}"`;
    ids.add(p.id);
  }
  if (points.length === 0) return null;
  const parsed = DeviceControl.safeParse(control);
  if (!parsed.success || parsed.data.kind !== 'driver')
    return 'Choose the device’s driver before adding control points';
  const driver = BUILT_IN_DRIVERS[parsed.data.driverId];
  if (!driver?.points) return `${driver?.name ?? 'This driver'} does not support control points`;
  for (const p of points) {
    const form = driver.points[p.type];
    if (!form)
      return `${driver.name} does not support ${POINT_TYPE_LABEL[p.type].toLowerCase()} points`;
    for (const f of form)
      if (!f.optional && !String(p.address[f.key] ?? '').trim())
        return `“${p.name}” needs its ${f.label.toLowerCase()}`;
    if (p.min !== undefined && p.max !== undefined && p.min >= p.max)
      return `“${p.name}”: the minimum must be below the maximum`;
  }
  return null;
}

export type PointsResult = { ok: true } | { ok: false; message: string };

/** Replaces a device's control points. The gateway picks the change up with the next device set. */
export async function setDevicePoints(
  db: PointsDb,
  input: { orgId: string; deviceId: string; actorId: string | null; points: ControlPoint[] },
  now = new Date(),
): Promise<PointsResult> {
  const row = await db.device.findFirst({ where: { id: input.deviceId, orgId: input.orgId } });
  if (!row) return { ok: false, message: 'No such device' };
  if (row.kind !== 'active')
    return { ok: false, message: 'Only a monitored device can have control points' };
  const problem = validatePoints(row.control, input.points);
  if (problem) return { ok: false, message: problem };
  // A point can only belong to a room this device serves.
  const named = input.points.filter((p) => p.roomId);
  if (named.length > 0) {
    const served = new Set(await roomsServedBy(db, row));
    const stray = named.find((p) => !served.has(p.roomId!));
    if (stray) return { ok: false, message: `“${stray.name}” belongs to a room this device does not serve` };
  }
  await db.device.update({
    where: { id: row.id },
    data: {
      points: input.points as unknown as Prisma.InputJsonValue,
      // What was read for the old list means nothing for the new one.
      pointValues: Prisma.DbNull,
      version: row.version + 1,
    },
  });
  await db.deviceEvent.create({
    data: {
      orgId: row.orgId,
      deviceId: row.id,
      type: 'field_changed',
      field: 'control points',
      newValue: `${input.points.length} point${input.points.length === 1 ? '' : 's'}`,
      source: 'manual',
      actorId: input.actorId,
      at: now,
    },
  });
  return { ok: true };
}

/** What a heartbeat's point readings change on the device row, if anything. */
export function pointValuesPatch(
  row: { pointValues: unknown },
  rep: Pick<DeviceReport, 'points'>,
): Record<string, unknown> | undefined {
  if (!rep.points) return undefined;
  return JSON.stringify(rep.points) === JSON.stringify(row.pointValues ?? null)
    ? undefined
    : (rep.points as Record<string, unknown>);
}

/**
 * Raises and resolves the incidents for a device's watched points. A device that is offline cannot
 * be read, so its incidents are left as they are; a watch that has been taken off a point, or a
 * point removed, no longer holds an incident open. A point with no reading yet changes nothing.
 */
export async function applyWatchedPoints(
  db: PointsDb,
  row: { id: string; orgId: string; roomId: string | null; name: string; points: unknown },
  gw: { id: string },
  rep: Pick<DeviceReport, 'online' | 'watched'>,
  now: Date,
): Promise<AlertJob[]> {
  const jobs: AlertJob[] = [];
  if (!rep.online) return jobs;
  const monitoring = db as unknown as MonitoringDb;
  const pointsHere = pointsOf(row.points);
  const linked = await linkedRoomIds(db, row.orgId, row.id);
  const watchedNow = new Set(
    pointsOf(row.points)
      .filter((p) => p.watch)
      .map((p) => p.id),
  );
  for (const w of rep.watched ?? []) {
    if (!watchedNow.has(w.pointId)) continue;
    const subject = `device:${row.id}:${w.pointId}`;
    // A point that belongs to a room affects that room only; one that belongs to the device affects every room it serves.
    const point = pointsHere.find((p) => p.id === w.pointId);
    const rooms = point?.roomId
      ? [point.roomId]
      : [...new Set([...(row.roomId ? [row.roomId] : []), ...linked])];
    const job = w.ok
      ? await resolveIncident(monitoring, { orgId: row.orgId, kind: 'point_alert', subject }, now)
      : await openIncident(
          monitoring,
          {
            orgId: row.orgId,
            roomId: rooms[0] ?? row.roomId,
            roomIds: rooms.slice(1),
            gatewayId: gw.id,
            kind: 'point_alert',
            subject,
            severity: w.severity,
            title: `${row.name}: ${w.name}`,
            detail: `${w.message ?? `${w.name} is out of bounds`} (${row.name}).`,
          },
          now,
        );
    if (job) jobs.push(job);
  }
  const open = await db.incident.findMany({
    where: {
      orgId: row.orgId,
      kind: 'point_alert',
      status: 'open',
      subject: { startsWith: `device:${row.id}:` },
    },
  });
  for (const inc of open) {
    const pointId = inc.subject.slice(`device:${row.id}:`.length);
    if (watchedNow.has(pointId)) continue;
    const job = await resolveIncident(
      monitoring,
      { orgId: row.orgId, kind: 'point_alert', subject: inc.subject },
      now,
    );
    if (job) jobs.push(job);
  }
  return jobs;
}
