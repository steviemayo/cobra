import { Prisma, type PrismaClient } from '@kestrel/db';
import { BUILT_IN_DRIVERS, ControlPoint, DeviceControl, settingScope } from '@kestrel/model';
import { createDevice, type DevicesDb } from './devices';
import { MAX_POINTS, pointsOf, validatePoints } from './device-points';

// Copies of a room (docs/room-shapes-and-shared-devices.md, RS-2 to RS-7): a room's devices, control
// points and held settings are stamped into new rooms, each with its own addresses and logins.
// Addresses and logins are never copied from the source, so a copy starts with exactly what the
// person typed. Everything is checked first and written in one transaction, or nothing is.

export const MAX_COPIES = 100;

type Fields = Record<string, string | number | boolean>;

/** What a person says about one device in one new room. Anything left out keeps the source's design. */
export interface DeviceCopyInput {
  sourceDeviceId: string;
  /** Leave this device out of the new room. */
  skip?: boolean;
  name?: string;
  /** Addresses, setting key to value. Replaces the source's (which are not copied). */
  values?: Fields;
  /** Design settings. Replaces the source's when given. */
  settings?: Fields;
  /** Logins, sealed before storing. */
  secrets?: Fields;
  credentialSetId?: string | null;
  /** The control points for this room. Replaces the source's when given. */
  points?: ControlPoint[];
}

export interface RoomCopyInput {
  name: string;
  areaId?: string | null;
  tags?: string[];
  gatewayId?: string | null;
  devices: DeviceCopyInput[];
}

export interface SourceDevice {
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
}

export interface CopyRowResult {
  name: string;
  problems: string[];
  warnings: string[];
}

export interface CopyContext {
  /** Names of rooms already in the site, lower case. */
  roomNames: Set<string>;
  /** Addresses already used by devices in the site: `driver|host|port` to the device's name. */
  addresses: Map<string, string>;
  /** Credential sets of the organisation, by id. */
  credentialSets: Set<string>;
  /** Areas and gateways of the site. */
  areas: Set<string>;
  gateways: Set<string>;
  /** The plan's monitored-room limit (null: none) and how many rooms are monitored now. */
  maxRooms: number | null;
  monitoredRooms: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function driverIdOf(control: unknown): string | null {
  const c = DeviceControl.safeParse(control);
  if (!c.success) return null;
  return c.data.kind === 'driver' ? c.data.driverId : `generic:${c.data.protocol}`;
}

/** The settings a driver needs per room, split into the address kind and the login kind. */
export function requiredFields(control: unknown): { binding: string[]; secret: string[] } {
  const id = driverIdOf(control);
  const info = id ? BUILT_IN_DRIVERS[id] : undefined;
  if (!info) return { binding: ['host'], secret: [] };
  const binding: string[] = [];
  const secret: string[] = [];
  for (const s of info.settings) {
    if (!s.required) continue;
    (settingScope(s.key, { scope: s.scope }) === 'secret' ? secret : binding).push(s.key);
  }
  return { binding, secret };
}

const addressKey = (control: unknown, values: Fields) => {
  const host = String(values.host ?? '').trim().toLowerCase();
  if (!host) return null;
  return `${driverIdOf(control) ?? '?'}|${host}|${values.port ?? ''}`;
};

/**
 * Everything wrong (problems, which stop the copy) or worth knowing (warnings) about each requested
 * room. Pure: the caller supplies what the estate already holds.
 */
export function checkCopies(
  source: SourceDevice[],
  copies: RoomCopyInput[],
  ctx: CopyContext,
): { rows: CopyRowResult[]; batch: string[] } {
  const byId = new Map(source.map((d) => [d.id, d]));
  const rows: CopyRowResult[] = [];
  const batch: string[] = [];
  const names = new Set<string>();
  const seenAddress = new Map<string, string>();
  let newMonitored = 0;

  for (const copy of copies) {
    const row: CopyRowResult = { name: copy.name.trim(), problems: [], warnings: [] };
    rows.push(row);
    const key = row.name.toLowerCase();
    if (!row.name) row.problems.push('The room needs a name');
    else if (names.has(key)) row.problems.push('Two new rooms have this name');
    else if (ctx.roomNames.has(key)) row.problems.push('A room with this name is already in the site');
    names.add(key);
    if (copy.areaId && !ctx.areas.has(copy.areaId)) row.problems.push('That area is not in this site');
    if (copy.gatewayId && !ctx.gateways.has(copy.gatewayId))
      row.problems.push('That gateway is not in this site');

    const used = new Set<string>();
    let monitored = false;
    for (const d of copy.devices) {
      if (d.skip) continue;
      const src = byId.get(d.sourceDeviceId);
      if (!src) {
        row.problems.push('A device to copy is not in the source room');
        continue;
      }
      if (used.has(src.id)) row.problems.push(`“${src.name}” is listed twice`);
      used.add(src.id);
      const label = d.name?.trim() || src.name;
      if (src.kind !== 'active') continue;
      monitored = true;

      const values = d.values ?? {};
      const need = requiredFields(src.control);
      for (const f of need.binding)
        if (String(values[f] ?? '').trim() === '')
          row.problems.push(`“${label}” needs its ${f === 'host' ? 'address' : f}`);
      for (const f of need.secret)
        if (!d.credentialSetId && String(d.secrets?.[f] ?? '').trim() === '' && !src.credentialSetId)
          row.problems.push(`“${label}” needs its ${f}, or a saved login to use`);
      if (d.credentialSetId && !ctx.credentialSets.has(d.credentialSetId))
        row.problems.push(`“${label}”: that saved login does not exist`);

      const points = d.points ?? pointsOf(src.points);
      if (points.length > MAX_POINTS) row.problems.push(`“${label}” has too many control points`);
      else {
        const problem = validatePoints(src.control, points);
        if (problem) row.problems.push(`“${label}”: ${problem}`);
      }

      const addr = addressKey(src.control, values);
      if (addr) {
        const earlier = seenAddress.get(addr);
        if (earlier) row.problems.push(`“${label}” has the same address as ${earlier}`);
        else seenAddress.set(addr, `“${label}” in “${row.name || 'a new room'}”`);
        const existing = ctx.addresses.get(addr);
        if (existing)
          row.warnings.push(`“${label}” has the same address as the existing device ${existing}`);
      }
    }
    if (monitored) newMonitored += 1;
  }

  if (ctx.maxRooms !== null && ctx.monitoredRooms + newMonitored > ctx.maxRooms)
    batch.push(
      ctx.maxRooms === 0
        ? 'Your trial has ended, so no more rooms can be monitored. Subscribe to add more.'
        : `Your plan includes ${ctx.maxRooms} monitored rooms and ${ctx.monitoredRooms} are in use, so ${newMonitored} more will not fit.`,
    );
  if (copies.length > MAX_COPIES) batch.push(`Make at most ${MAX_COPIES} rooms at a time`);
  return { rows, batch };
}

export type CopyDb = DevicesDb & Pick<PrismaClient, 'room' | 'device'>;

/** What the estate already holds that a copy must not collide with. */
export async function loadContext(
  db: DevicesDb,
  orgId: string,
  siteId: string,
  limits: { maxRooms: number | null; monitoredRooms: number },
): Promise<CopyContext> {
  const [rooms, devices, sets, areas, gateways] = await Promise.all([
    db.room.findMany({ where: { orgId, siteId }, select: { name: true } }),
    db.device.findMany({
      where: { orgId, siteId, kind: 'active' },
      select: { name: true, control: true, values: true },
    }),
    db.credentialSet.findMany({ where: { orgId }, select: { id: true } }),
    db.area.findMany({ where: { orgId, siteId }, select: { id: true } }),
    db.gateway.findMany({ where: { orgId, siteId }, select: { id: true } }),
  ]);
  const addresses = new Map<string, string>();
  for (const d of devices) {
    const key = addressKey(d.control, isObject(d.values) ? (d.values as Fields) : {});
    if (key) addresses.set(key, `“${d.name}”`);
  }
  return {
    roomNames: new Set(rooms.map((r) => r.name.toLowerCase())),
    addresses,
    credentialSets: new Set(sets.map((s) => s.id)),
    areas: new Set(areas.map((a) => a.id)),
    gateways: new Set(gateways.map((g) => g.id)),
    ...limits,
  };
}

/**
 * Writes the rooms and their devices. The caller runs it inside one transaction. Returns the new
 * rooms in the order asked for.
 */
export async function writeCopies(
  db: CopyDb,
  input: {
    orgId: string;
    actorId: string;
    source: { id: string; siteId: string; gatewayId: string | null; monitorOnly: boolean };
    sourceDevices: SourceDevice[];
    copies: RoomCopyInput[];
  },
): Promise<{ roomId: string; name: string; devices: number }[]> {
  const byId = new Map(input.sourceDevices.map((d) => [d.id, d]));
  const made: { roomId: string; name: string; devices: number }[] = [];
  for (const copy of input.copies) {
    const room = await db.room.create({
      data: {
        orgId: input.orgId,
        siteId: input.source.siteId,
        name: copy.name.trim(),
        type: 'meeting',
        gatewayId: copy.gatewayId === undefined ? input.source.gatewayId : copy.gatewayId,
        areaId: copy.areaId ?? null,
        tags: copy.tags ?? [],
        monitorOnly: input.source.monitorOnly,
      },
    });
    let count = 0;
    for (const d of copy.devices) {
      if (d.skip) continue;
      const src = byId.get(d.sourceDeviceId)!;
      const made1 = await createDevice(db, {
        orgId: input.orgId,
        siteId: input.source.siteId,
        roomId: room.id,
        kind: src.kind === 'active' ? 'active' : 'passive',
        name: d.name?.trim() || src.name,
        category: src.category,
        control: src.kind === 'active' ? src.control : undefined,
        settings: d.settings ?? (isObject(src.settings) ? (src.settings as Fields) : {}),
        values: d.values ?? {},
        secrets: d.secrets,
        credentialSetId: d.credentialSetId === undefined ? src.credentialSetId : d.credentialSetId,
        make: src.make,
        model: src.model,
        actorId: input.actorId,
      });
      if (!made1.ok) throw new Error(made1.message);
      // What createDevice does not take: the control points and the held settings.
      const points = d.points ?? pointsOf(src.points);
      await db.device.update({
        where: { id: made1.value.id },
        data: {
          points: points as unknown as Prisma.InputJsonValue,
          profileId: src.profileId,
          configParams: (src.configParams ?? []) as Prisma.InputJsonValue,
        },
      });
      count += 1;
    }
    made.push({ roomId: room.id, name: room.name, devices: count });
  }
  return made;
}
