import type { PrismaClient } from '@kestrel/db';
import { deviceLiveState, type DeviceLiveState, type Provenance } from '@kestrel/model';
import { gatewayIdFor, type DevicesDb } from './devices';
import { effectiveStatus } from './gateway-status';

// What the portal sees of a device: never a login, only whether one is set.
export type DeviceViewsDb = DevicesDb & Pick<PrismaClient, 'room' | 'gateway'>;

export interface DeviceView {
  id: string;
  name: string;
  kind: string;
  category: string;
  siteId: string;
  roomId: string | null;
  roomName: string | null;
  areaId: string | null;
  /** The gateway that polls it (its own, else its room's, else the site's) and how that gateway is. */
  gatewayId: string | null;
  gatewayName: string | null;
  gatewayOverride: boolean;
  gatewayStatus: 'pending' | 'online' | 'offline' | null;
  state: DeviceLiveState;
  since: Date | null;
  lastSeenAt: Date | null;
  driver: string | null;
  control: unknown;
  hasLogin: boolean;
  credentialSetId: string | null;
  values: unknown;
  settings: unknown;
  make: string | null;
  model: string | null;
  serial: string | null;
  mac: string | null;
  ip: string | null;
  firmware: string | null;
  assetTag: string | null;
  status: string;
  installedOn: Date | null;
  warrantyEndsOn: Date | null;
  endOfLifeOn: Date | null;
  supplier: string | null;
  notes: string | null;
  provenance: Provenance;
  swapPending: boolean;
  feedback: unknown;
  details: unknown;
  /** The control points read on the device, and what each read at the last heartbeat (by point id). */
  points: unknown;
  pointValues: unknown;
  version: number;
}

export async function deviceViews(
  db: DeviceViewsDb,
  filter: { orgId: string; siteId?: string; roomId?: string; areaId?: string; deviceId?: string },
  now = Date.now(),
): Promise<DeviceView[]> {
  let roomIds: string[] | undefined;
  if (filter.areaId) {
    roomIds = (
      await db.room.findMany({ where: { orgId: filter.orgId, areaId: filter.areaId } })
    ).map((r) => r.id);
  }
  const rows = await db.device.findMany({
    where: {
      orgId: filter.orgId,
      ...(filter.deviceId ? { id: filter.deviceId } : {}),
      ...(filter.siteId ? { siteId: filter.siteId } : {}),
      ...(filter.roomId ? { roomId: filter.roomId } : {}),
      ...(roomIds ? { roomId: { in: roomIds } } : {}),
    },
    orderBy: { name: 'asc' },
  });
  const rooms = new Map(
    (await db.room.findMany({ where: { orgId: filter.orgId } })).map((r) => [r.id, r]),
  );
  const gateways = new Map(
    (await db.gateway.findMany({ where: { orgId: filter.orgId } })).map((g) => [g.id, g]),
  );
  const out: DeviceView[] = [];
  for (const d of rows) {
    const room = d.roomId ? rooms.get(d.roomId) : undefined;
    const gwId = d.kind === 'active' ? await gatewayIdFor(db, d) : null;
    const gw = gwId ? gateways.get(gwId) : undefined;
    const gatewayStatus = gw ? effectiveStatus(gw, now) : null;
    const control = d.control as { kind?: string; driverId?: string; protocol?: string } | null;
    out.push({
      id: d.id,
      name: d.name,
      kind: d.kind,
      category: d.category,
      siteId: d.siteId,
      roomId: d.roomId,
      roomName: room?.name ?? null,
      areaId: room?.areaId ?? null,
      gatewayId: gwId,
      gatewayName: gw?.name ?? null,
      gatewayOverride: !!d.gatewayId,
      gatewayStatus,
      state: deviceLiveState({
        kind: d.kind,
        online: d.online,
        gatewayOnline: gatewayStatus === 'online',
      }),
      since: d.since,
      lastSeenAt: d.lastSeenAt,
      driver: control?.driverId ?? control?.protocol ?? null,
      control: d.control,
      hasLogin: !!d.sealed || !!d.credentialSetId,
      credentialSetId: d.credentialSetId,
      values: d.values,
      settings: d.settings,
      make: d.make,
      model: d.model,
      serial: d.serial,
      mac: d.mac,
      ip: d.ip,
      firmware: d.firmware,
      assetTag: d.assetTag,
      status: d.status,
      installedOn: d.installedOn,
      warrantyEndsOn: d.warrantyEndsOn,
      endOfLifeOn: d.endOfLifeOn,
      supplier: d.supplier,
      notes: d.notes,
      provenance: (d.provenance ?? {}) as Provenance,
      swapPending: d.swapPending,
      feedback: d.feedback,
      details: d.details,
      points: d.points,
      pointValues: d.pointValues,
      version: d.version,
    });
  }
  return out;
}
