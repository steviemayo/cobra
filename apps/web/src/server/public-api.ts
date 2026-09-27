import type { PrismaClient } from '@kestrel/db';
import { effectiveStatus } from './gateway-status';

// What the public API (/api/v1) returns. The shapes are a promise to outside systems, so they are
// written out here rather than passed through from the database, and never include anything private
// (addresses, logins, secrets). Read-only. See docs/public-api.md. These functions take the database
// as a parameter so they can be tested without one.
export type PublicApiDb = Pick<PrismaClient, 'room' | 'site' | 'gateway' | 'release' | 'deviceStatus' | 'incident'>;

export interface ApiRoom {
  id: string;
  name: string;
  type: string;
  /** standard, combined or staging. */
  kind: string;
  site: { id: string; name: string } | null;
  gateway: { id: string; name: string; status: 'pending' | 'online' | 'offline' } | null;
  release: { running: number | null; target: number | null };
  /** What the gateway last said the room was doing (off, starting, on, fault), or null. */
  status: string | null;
  reportedAt: string | null;
}

export interface ApiDevice {
  id: string;
  name: string;
  online: boolean;
  /** When the device last changed between online and offline. */
  since: string;
}

export interface ApiIncident {
  id: string;
  kind: string;
  severity: string;
  status: string;
  title: string;
  detail: string | null;
  room: { id: string; name: string } | null;
  openedAt: string;
  resolvedAt: string | null;
  acknowledged: boolean;
}

export const MAX_PAGE = 200;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function shape(db: PublicApiDb, orgId: string, rooms: Awaited<ReturnType<PublicApiDb['room']['findMany']>>): Promise<ApiRoom[]> {
  if (rooms.length === 0) return [];
  const siteIds = [...new Set(rooms.map((r) => r.siteId))];
  const gatewayIds = [...new Set(rooms.flatMap((r) => (r.gatewayId ? [r.gatewayId] : [])))];
  const releaseIds = [...new Set(rooms.flatMap((r) => [r.desiredReleaseId, r.reportedReleaseId].flatMap((x) => (x ? [x] : []))))];
  const [sites, gateways, releases] = await Promise.all([
    db.site.findMany({ where: { orgId, id: { in: siteIds } }, select: { id: true, name: true } }),
    gatewayIds.length
      ? db.gateway.findMany({ where: { orgId, id: { in: gatewayIds } }, select: { id: true, name: true, enrolledAt: true, lastSeenAt: true } })
      : Promise.resolve([]),
    releaseIds.length
      ? db.release.findMany({ where: { orgId, id: { in: releaseIds } }, select: { id: true, number: true } })
      : Promise.resolve([]),
  ]);
  const site = new Map(sites.map((s) => [s.id, s]));
  const gateway = new Map(gateways.map((g) => [g.id, g]));
  const number = new Map(releases.map((r) => [r.id, r.number]));
  return rooms.map((r) => {
    const gw = r.gatewayId ? gateway.get(r.gatewayId) : undefined;
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      kind: r.kind ?? 'standard',
      site: site.get(r.siteId) ? { id: r.siteId, name: site.get(r.siteId)!.name } : null,
      gateway: gw ? { id: gw.id, name: gw.name, status: effectiveStatus(gw) } : null,
      release: {
        running: r.reportedReleaseId ? (number.get(r.reportedReleaseId) ?? null) : null,
        target: r.desiredReleaseId ? (number.get(r.desiredReleaseId) ?? null) : null,
      },
      status: r.reportedStatus ?? null,
      reportedAt: iso(r.reportedAt),
    };
  });
}

export async function listRooms(db: PublicApiDb, orgId: string): Promise<ApiRoom[]> {
  const rooms = await db.room.findMany({ where: { orgId }, orderBy: { name: 'asc' }, take: 1000 });
  // Sorted here rather than by the database, so the order does not depend on its collation.
  return (await shape(db, orgId, rooms)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getRoom(
  db: PublicApiDb,
  orgId: string,
  roomId: string,
): Promise<(ApiRoom & { devices: ApiDevice[]; openIncidents: number }) | null> {
  const room = await db.room.findFirst({ where: { id: roomId, orgId } });
  if (!room) return null;
  const [[shaped], devices, open] = await Promise.all([
    shape(db, orgId, [room]),
    db.deviceStatus.findMany({ where: { orgId, roomId }, orderBy: { name: 'asc' } }),
    db.incident.count({ where: { orgId, roomId, status: 'open' } }),
  ]);
  return {
    ...shaped!,
    devices: devices
      .map((d) => ({ id: d.deviceId, name: d.name, online: d.online, since: d.since.toISOString() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    openIncidents: open,
  };
}

export async function listIncidents(
  db: PublicApiDb,
  orgId: string,
  opts: { status?: 'open' | 'resolved'; roomId?: string; limit?: number },
): Promise<ApiIncident[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_PAGE);
  const rows = await db.incident.findMany({
    where: { orgId, ...(opts.status && { status: opts.status }), ...(opts.roomId && { roomId: opts.roomId }) },
    orderBy: { openedAt: 'desc' },
    take: limit,
  });
  const ids = [...new Set(rows.flatMap((r) => (r.roomId ? [r.roomId] : [])))];
  const rooms = ids.length ? await db.room.findMany({ where: { orgId, id: { in: ids } }, select: { id: true, name: true } }) : [];
  const name = new Map(rooms.map((r) => [r.id, r.name]));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    severity: r.severity,
    status: r.status,
    title: r.title,
    detail: r.detail,
    room: r.roomId && name.has(r.roomId) ? { id: r.roomId, name: name.get(r.roomId)! } : null,
    openedAt: r.openedAt.toISOString(),
    resolvedAt: iso(r.resolvedAt),
    acknowledged: r.acknowledgedAt !== null,
  }));
}
