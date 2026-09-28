import type { PrismaClient } from '@kestrel/db';
import { effectiveStatus } from './gateway-status';
import { roomHealth, type Health } from './monitoring';
import { incidentVisible, inScope, type SiteScope } from './site-scope';

export type OverviewDb = Pick<
  PrismaClient,
  'room' | 'gateway' | 'site' | 'deviceStatus' | 'incident'
>;

export interface RoomLive {
  id: string;
  name: string;
  type: string;
  siteId: string;
  siteName: string;
  gatewayId: string | null;
  gatewayName: string | null;
  gatewayStatus: 'pending' | 'online' | 'offline' | null;
  /** What the room last said it was doing (off, on, fault...), or null if it has not reported. */
  status: string | null;
  reportedAt: Date | null;
  health: Health;
  devices: { total: number; online: number };
  openIncidents: number;
}

export interface DeviceLive {
  deviceId: string;
  name: string;
  online: boolean;
  since: Date;
  roomId: string;
  roomName: string;
  siteId: string;
  siteName: string;
}

export type DevicesDb = Pick<PrismaClient, 'room' | 'site' | 'deviceStatus'>;

/** Every device across the org's in-scope rooms, flattened for the org-wide monitoring list. */
export async function orgDevices(
  db: DevicesDb,
  orgId: string,
  scope: SiteScope = null,
): Promise<DeviceLive[]> {
  const [rooms, sites, devices] = await Promise.all([
    db.room.findMany({ where: { orgId } }),
    db.site.findMany({ where: { orgId } }),
    db.deviceStatus.findMany({ where: { orgId }, orderBy: { name: 'asc' } }),
  ]);
  const inScopeRooms = rooms.filter((r) => inScope(scope, r.siteId));
  const roomById = new Map(inScopeRooms.map((r) => [r.id, r]));
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const out: DeviceLive[] = [];
  for (const d of devices) {
    const room = roomById.get(d.roomId);
    if (!room) continue;
    out.push({
      deviceId: d.deviceId,
      name: d.name,
      online: d.online,
      since: d.since,
      roomId: room.id,
      roomName: room.name,
      siteId: room.siteId,
      siteName: siteName.get(room.siteId) ?? '',
    });
  }
  return out;
}

export interface GatewayLive {
  id: string;
  name: string;
  siteId: string;
  siteName: string;
  status: 'pending' | 'online' | 'offline';
  lastSeenAt: Date | null;
  version: string | null;
  roomCount: number;
  openIncidents: number;
}

/** Everything the live status pages show, in five queries. Every query is scoped to the org. */
export async function orgOverview(
  db: OverviewDb,
  orgId: string,
  now = new Date(),
  /** null: the whole organisation. A list: only rooms, gateways and sites at these sites. */
  scope: SiteScope = null,
) {
  const [allRooms, allGateways, allSites, allDevices, allIncidents] = await Promise.all([
    db.room.findMany({ where: { orgId }, orderBy: { name: 'asc' } }),
    db.gateway.findMany({ where: { orgId }, orderBy: { name: 'asc' } }),
    db.site.findMany({ where: { orgId } }),
    db.deviceStatus.findMany({ where: { orgId } }),
    db.incident.findMany({ where: { orgId, status: 'open' } }),
  ]);
  const rooms = allRooms.filter((r) => inScope(scope, r.siteId));
  const gateways = allGateways.filter((g) => inScope(scope, g.siteId));
  const sites = allSites.filter((s) => inScope(scope, s.id));
  const roomIds = new Set(rooms.map((r) => r.id));
  const gatewayIds = new Set(gateways.map((g) => g.id));
  const devices = allDevices.filter((d) => roomIds.has(d.roomId));
  const incidents = allIncidents.filter((i) => incidentVisible(i, scope, roomIds, gatewayIds));
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const gatewayById = new Map(
    gateways.map((g) => [g.id, { name: g.name, status: effectiveStatus(g, now.getTime()) }]),
  );

  const roomRows: RoomLive[] = rooms.map((r) => {
    const gw = r.gatewayId ? gatewayById.get(r.gatewayId) : undefined;
    const own = devices.filter((d) => d.roomId === r.id);
    const open = incidents.filter((i) => i.roomId === r.id);
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      siteId: r.siteId,
      siteName: siteName.get(r.siteId) ?? '',
      gatewayId: r.gatewayId,
      gatewayName: gw?.name ?? null,
      gatewayStatus: gw?.status ?? null,
      status: r.reportedStatus,
      reportedAt: r.reportedAt,
      health: roomHealth({
        gatewayStatus: gw?.status ?? null,
        deployed: r.reportedReleaseId !== null,
        status: r.reportedStatus,
        devices: own,
        openIncidents: open,
      }),
      devices: { total: own.length, online: own.filter((d) => d.online).length },
      openIncidents: open.length,
    };
  });

  const gatewayRows: GatewayLive[] = gateways.map((g) => ({
    id: g.id,
    name: g.name,
    siteId: g.siteId,
    siteName: siteName.get(g.siteId) ?? '',
    status: effectiveStatus(g, now.getTime()),
    lastSeenAt: g.lastSeenAt,
    version: g.version,
    roomCount: rooms.filter((r) => r.gatewayId === g.id).length,
    openIncidents: incidents.filter((i) => i.gatewayId === g.id && i.roomId === null).length,
  }));

  return {
    rooms: roomRows,
    gateways: gatewayRows,
    incidents: {
      open: incidents.length,
      critical: incidents.filter((i) => i.severity === 'critical').length,
    },
  };
}
