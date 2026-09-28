import type { PrismaClient } from '@kestrel/db';
import { RoomModel } from '@kestrel/model';
import { sharedRefs } from './bindings';
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

/** One physical device. A shared site device used by several rooms is one entry listing them all. */
export interface DeviceLive {
  key: string;
  name: string;
  online: boolean;
  since: Date;
  siteId: string;
  siteName: string;
  rooms: { id: string; name: string }[];
  shared: boolean;
}

export type DevicesDb = Pick<
  PrismaClient,
  'room' | 'site' | 'deviceStatus' | 'roomDraft' | 'siteDevice'
>;

/**
 * Every device across the org's in-scope rooms, each physical device once. Status is stored per
 * room, so a shared site device (one connection, several rooms) has a row for each room that uses
 * it; the room designs say which rows are the same device.
 */
export async function orgDevices(
  db: DevicesDb,
  orgId: string,
  scope: SiteScope = null,
): Promise<DeviceLive[]> {
  const [rooms, sites, statuses] = await Promise.all([
    db.room.findMany({ where: { orgId } }),
    db.site.findMany({ where: { orgId } }),
    db.deviceStatus.findMany({ where: { orgId }, orderBy: { name: 'asc' } }),
  ]);
  const roomById = new Map(rooms.filter((r) => inScope(scope, r.siteId)).map((r) => [r.id, r]));
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const rows = statuses.filter((d) => roomById.has(d.roomId));

  const roomIds = [...new Set(rows.map((d) => d.roomId))];
  const drafts = roomIds.length
    ? await db.roomDraft.findMany({ where: { orgId, roomId: { in: roomIds } } })
    : [];
  const siteDeviceOf = new Map<string, string>();
  for (const draft of drafts) {
    const model = RoomModel.safeParse(draft.model);
    if (!model.success) continue;
    for (const ref of sharedRefs(model.data))
      siteDeviceOf.set(`${draft.roomId}:${ref.deviceId}`, ref.siteDeviceId);
  }
  const siteDeviceIds = [...new Set(siteDeviceOf.values())];
  const siteDevices = siteDeviceIds.length
    ? await db.siteDevice.findMany({ where: { orgId, id: { in: siteDeviceIds } } })
    : [];
  const sharedName = new Map(siteDevices.map((d) => [d.id, d.name]));

  const out = new Map<string, DeviceLive>();
  for (const d of rows) {
    const room = roomById.get(d.roomId)!;
    const shared = siteDeviceOf.get(`${d.roomId}:${d.deviceId}`);
    const key = shared ? `shared:${shared}` : `${d.roomId}:${d.deviceId}`;
    const seen = out.get(key);
    if (!seen) {
      out.set(key, {
        key,
        name: (shared && sharedName.get(shared)) || d.name,
        online: d.online,
        since: d.since,
        siteId: room.siteId,
        siteName: siteName.get(room.siteId) ?? '',
        rooms: [{ id: room.id, name: room.name }],
        shared: !!shared,
      });
      continue;
    }
    seen.rooms.push({ id: room.id, name: room.name });
    // One connection, so the rows should agree; if they don't, offline is the safer thing to say.
    if (seen.online !== d.online) {
      seen.online = false;
      seen.since = d.online ? seen.since : d.since;
    }
  }
  return [...out.values()];
}

export interface SharedInRoom {
  name: string;
  /** The other rooms (in scope) whose designs use the same shared device. */
  otherRooms: { id: string; name: string }[];
}

export type SharedDb = Pick<PrismaClient, 'room' | 'roomDraft' | 'siteDevice'>;

/** This room's devices that are a shared site device, and which other rooms use the same one. */
export async function sharedInRoom(
  db: SharedDb,
  orgId: string,
  room: { id: string; siteId: string },
  scope: SiteScope = null,
): Promise<Record<string, SharedInRoom>> {
  const siteRooms = (await db.room.findMany({ where: { orgId, siteId: room.siteId } })).filter(
    (r) => inScope(scope, r.siteId),
  );
  const drafts = await db.roomDraft.findMany({
    where: { orgId, roomId: { in: siteRooms.map((r) => r.id) } },
  });
  const refsOf = (roomId: string) => {
    const draft = drafts.find((d) => d.roomId === roomId);
    const model = draft ? RoomModel.safeParse(draft.model) : null;
    return model?.success ? sharedRefs(model.data) : [];
  };
  const mine = refsOf(room.id);
  if (mine.length === 0) return {};
  const siteDevices = await db.siteDevice.findMany({
    where: { orgId, id: { in: mine.map((r) => r.siteDeviceId) } },
  });
  const name = new Map(siteDevices.map((d) => [d.id, d.name]));
  const out: Record<string, SharedInRoom> = {};
  for (const ref of mine)
    out[ref.deviceId] = {
      name: name.get(ref.siteDeviceId) ?? ref.siteDeviceId,
      otherRooms: siteRooms
        .filter(
          (r) => r.id !== room.id && refsOf(r.id).some((x) => x.siteDeviceId === ref.siteDeviceId),
        )
        .map((r) => ({ id: r.id, name: r.name })),
    };
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
