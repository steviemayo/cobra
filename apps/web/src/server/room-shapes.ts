import { Prisma, type PrismaClient } from '@kestrel/db';
import { ControlPoint, DeviceControl } from '@kestrel/model';
import { z } from 'zod';
import { pointsOf } from './device-points';
import type { SourceDevice } from './room-copies';

// Saved room shapes (docs/room-shapes-and-shared-devices.md, RS-2, RS-3): the devices a room is made
// of, kept by name so many rooms can be made from them. A shape holds drivers, design settings and
// control points. It never holds an address or a login.

export type ShapeDb = Pick<PrismaClient, 'roomShape' | 'device' | 'room'>;

const fields = z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()]));

export const ShapeSlot = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  kind: z.enum(['active', 'passive']),
  category: z.string().min(1).max(60),
  control: DeviceControl.nullable().default(null),
  settings: fields.default({}),
  credentialSetId: z.string().uuid().nullable().default(null),
  profileId: z.string().uuid().nullable().default(null),
  configParams: z.array(z.unknown()).default([]),
  points: z.array(ControlPoint).max(200).default([]),
  make: z.string().max(100).nullable().default(null),
  model: z.string().max(100).nullable().default(null),
});
export type ShapeSlot = z.infer<typeof ShapeSlot>;

export const MAX_SHAPES = 100;
export const MAX_SLOTS = 100;

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** The slots a room's devices make: design only, a point's room dropped (it is the source room's). */
export function slotsFromDevices(
  devices: {
    id: string;
    name: string;
    kind: string;
    category: string;
    control: unknown;
    settings: unknown;
    credentialSetId: string | null;
    profileId: string | null;
    configParams: unknown;
    points: unknown;
    make: string | null;
    model: string | null;
  }[],
  roomId: string,
): ShapeSlot[] {
  return devices.map((d) => {
    const control = DeviceControl.safeParse(d.control);
    return ShapeSlot.parse({
      id: d.id,
      name: d.name,
      kind: d.kind === 'active' ? 'active' : 'passive',
      category: d.category,
      control: control.success ? control.data : null,
      settings: isObject(d.settings) ? d.settings : {},
      credentialSetId: d.credentialSetId,
      profileId: d.profileId,
      configParams: Array.isArray(d.configParams) ? d.configParams : [],
      // Points that belong to another room on a shared device are not this room's shape.
      points: pointsOf(d.points)
        .filter((p) => !p.roomId || p.roomId === roomId)
        .map((p) => {
          const rest = { ...p };
          delete rest.roomId;
          return rest;
        }),
      make: d.make,
      model: d.model,
    });
  });
}

/** A slot as the copy engine reads a source device. */
export function slotToSource(slot: ShapeSlot): SourceDevice {
  return {
    id: slot.id,
    name: slot.name,
    kind: slot.kind,
    category: slot.category,
    control: slot.control,
    settings: slot.settings,
    credentialSetId: slot.credentialSetId,
    profileId: slot.profileId,
    configParams: slot.configParams,
    points: slot.points,
    make: slot.make,
    model: slot.model,
  };
}

export type ShapeResult<T = { id: string }> =
  { ok: true; value: T } | { ok: false; message: string };

/** Saves a room's devices as a named shape. A name already used is refused, so nothing is overwritten by accident. */
export async function saveShape(
  db: ShapeDb,
  input: { orgId: string; roomId: string; name: string; description?: string | null; actorId: string | null },
): Promise<ShapeResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, message: 'Give the shape a name' };
  const room = await db.room.findFirst({ where: { id: input.roomId, orgId: input.orgId } });
  if (!room) return { ok: false, message: 'No such room' };
  if ((await db.roomShape.count({ where: { orgId: input.orgId } })) >= MAX_SHAPES)
    return { ok: false, message: `An organisation can keep ${MAX_SHAPES} shapes` };
  if (await db.roomShape.findFirst({ where: { orgId: input.orgId, name } }))
    return { ok: false, message: 'A shape with this name already exists' };
  const devices = await db.device.findMany({
    where: { orgId: input.orgId, roomId: room.id },
    orderBy: { createdAt: 'asc' },
  });
  if (devices.length === 0) return { ok: false, message: 'This room has no devices to save' };
  if (devices.length > MAX_SLOTS)
    return { ok: false, message: `A shape can hold ${MAX_SLOTS} devices` };
  const created = await db.roomShape.create({
    data: {
      orgId: input.orgId,
      name,
      description: input.description?.trim() || null,
      slots: slotsFromDevices(devices, room.id) as unknown as Prisma.InputJsonValue,
      createdBy: input.actorId,
    },
  });
  return { ok: true, value: { id: created.id } };
}

/** A saved shape's slots. Anything stored that no longer parses is dropped. */
export function slotsOf(stored: unknown): ShapeSlot[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((s) => {
    const parsed = ShapeSlot.safeParse(s);
    return parsed.success ? [parsed.data] : [];
  });
}
