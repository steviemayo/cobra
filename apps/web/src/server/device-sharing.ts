import type { PrismaClient } from '@kestrel/db';
import type { ControlPoint } from '@kestrel/model';

// Shared devices (docs/room-shapes-and-shared-devices.md, RS-8 to RS-12): one device row, one address,
// login, gateway and history, serving several rooms. The device keeps its home room (`roomId`, or none)
// and `DeviceRoom` lists the others. The rooms may be at different sites of the organisation.
export type SharingDb = Pick<PrismaClient, 'device' | 'deviceRoom' | 'deviceEvent' | 'room'>;
type MaybeLinks = { deviceRoom?: Pick<PrismaClient['deviceRoom'], 'findMany'> };

export const MAX_SHARED_ROOMS = 50;

/** The rooms a device serves besides its home room. Empty when links are not available. */
export async function linkedRoomIds(
  db: MaybeLinks,
  orgId: string,
  deviceId: string,
): Promise<string[]> {
  if (!db.deviceRoom) return [];
  const rows = await db.deviceRoom.findMany({ where: { orgId, deviceId } });
  return rows.map((r) => r.roomId);
}

/** Every room a device serves: its home room first, then the rest. */
export async function roomsServedBy(
  db: MaybeLinks,
  device: { id: string; orgId: string; roomId: string | null },
): Promise<string[]> {
  const linked = await linkedRoomIds(db, device.orgId, device.id);
  return [...new Set([...(device.roomId ? [device.roomId] : []), ...linked])];
}

/** The devices linked to a room (not counting those whose home it is). */
export async function linkedDeviceIds(
  db: MaybeLinks,
  orgId: string,
  roomId: string,
): Promise<string[]> {
  if (!db.deviceRoom) return [];
  const rows = await db.deviceRoom.findMany({ where: { orgId, roomId } });
  return rows.map((r) => r.deviceId);
}

/**
 * The control points a room sees on a shared device: its own, and those that belong to the device as a
 * whole. With no room given, all of them.
 */
export function pointsForRoom(points: ControlPoint[], roomId: string | undefined): ControlPoint[] {
  return roomId ? points.filter((p) => !p.roomId || p.roomId === roomId) : points;
}

export type SharingResult = { ok: true; rooms: number } | { ok: false; message: string };

/**
 * Sets which rooms, besides its home room, a device serves. Replaces what was there. Every room must
 * be in the organisation (any site). A room that stops being served loses the control points that
 * belonged to it on this device.
 */
export async function setDeviceRooms(
  db: SharingDb,
  input: {
    orgId: string;
    deviceId: string;
    roomIds: string[];
    actorId: string | null;
  },
  now = new Date(),
): Promise<SharingResult> {
  const device = await db.device.findFirst({ where: { id: input.deviceId, orgId: input.orgId } });
  if (!device) return { ok: false, message: 'No such device' };
  const wanted = [...new Set(input.roomIds)].filter((id) => id !== device.roomId);
  if (wanted.length > MAX_SHARED_ROOMS)
    return { ok: false, message: `A device can serve at most ${MAX_SHARED_ROOMS} other rooms` };
  const rooms = wanted.length
    ? await db.room.findMany({ where: { orgId: input.orgId, id: { in: wanted } } })
    : [];
  if (rooms.length !== wanted.length)
    return { ok: false, message: 'One of those rooms is not in this organisation' };

  const current = await db.deviceRoom.findMany({
    where: { orgId: input.orgId, deviceId: device.id },
  });
  const have = new Set(current.map((r) => r.roomId));
  const add = wanted.filter((id) => !have.has(id));
  const drop = current.filter((r) => !wanted.includes(r.roomId));
  for (const roomId of add)
    await db.deviceRoom.create({ data: { orgId: input.orgId, deviceId: device.id, roomId } });
  if (drop.length > 0)
    await db.deviceRoom.deleteMany({
      where: { deviceId: device.id, roomId: { in: drop.map((r) => r.roomId) } },
    });

  const changed = add.length > 0 || drop.length > 0;
  // Points that belonged to a room no longer served would never show: take them off.
  const served = new Set([...(device.roomId ? [device.roomId] : []), ...wanted]);
  const stored = Array.isArray(device.points) ? (device.points as unknown as ControlPoint[]) : [];
  const kept = drop.length > 0 ? stored.filter((p) => !p.roomId || served.has(p.roomId)) : stored;
  if (changed)
    await db.device.update({
      where: { id: device.id },
      data: {
        version: device.version + 1,
        ...(kept.length !== stored.length ? { points: kept as never } : {}),
      },
    });
  if (changed)
    await db.deviceEvent.create({
      data: {
        orgId: input.orgId,
        deviceId: device.id,
        type: 'field_changed',
        field: 'shared with',
        newValue: `${wanted.length} other room${wanted.length === 1 ? '' : 's'}`,
        source: 'manual',
        actorId: input.actorId,
        at: now,
      },
    });
  return { ok: true, rooms: wanted.length };
}
