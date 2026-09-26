import { open, seal } from '@kestrel/crypto';
import type { Prisma, PrismaClient } from '@kestrel/db';
import {
  DeviceCategory,
  DeviceControl,
  RoomModel,
  scopeOfSetting,
  slotsFor,
  type BindingSlot,
  type CustomDrivers,
  type Device,
} from '@kestrel/model';
import { sharedRefs, type BindingsDb } from './bindings';

// Shared site devices (docs/driver-classes.md, "Shared devices"): one physical device known to a
// site, used by any number of rooms. Its address and login are kept here once; rooms refer to it
// from their design and get its values through their bindings. These functions take the database
// as a parameter so they can be tested without one.
export type SiteDeviceDb = Pick<PrismaClient, 'room' | 'roomDraft'> & BindingsDb;

export const MAX_SITE_DEVICES_PER_SITE = 300;

const secretsKey = () => process.env.KESTREL_SECRETS_KEY || undefined;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const blank = (v: unknown) => v === undefined || v === null || v === '';
const cleanName = (n: string) => n.trim().replace(/\s+/g, ' ');

type Result<T = object> = ({ ok: true } & T) | { ok: false; message: string };

/** A stand-in device, so the driver's own setting scopes can be used for a device that is not in a room. */
function asDevice(row: { id: string; name: string; category: string; control: unknown }): Device {
  return {
    id: 'shared',
    name: row.name,
    category: row.category as Device['category'],
    ports: [],
    extraCapabilities: [],
    control: DeviceControl.safeParse(row.control).data,
    settings: {},
  };
}

function openSecrets(sealed: string | null, key: string | undefined): Record<string, unknown> {
  if (!sealed) return {};
  if (!key) throw new Error('This shared device has stored logins but the server has no KESTREL_SECRETS_KEY');
  const parsed: unknown = JSON.parse(open(sealed, key));
  return isObject(parsed) ? parsed : {};
}

// ---- Who uses a device ---------------------------------------------------------------------------

export interface SiteDeviceUse {
  roomId: string;
  roomName: string;
  gatewayId: string | null;
  /** The device in the room design, and its ports that map onto this device. */
  deviceId: string;
  deviceName: string;
  ports: { id: string; maps: string }[];
}

/** Every room at the site whose design uses a shared device, from the drafts. */
export async function usesOfSite(
  db: SiteDeviceDb,
  orgId: string,
  siteId: string,
): Promise<Map<string, SiteDeviceUse[]>> {
  const rooms = await db.room.findMany({ where: { orgId, siteId } });
  const drafts = rooms.length
    ? await db.roomDraft.findMany({ where: { orgId, roomId: { in: rooms.map((r) => r.id) } } })
    : [];
  const out = new Map<string, SiteDeviceUse[]>();
  for (const room of rooms) {
    const draft = drafts.find((d) => d.roomId === room.id);
    const model = draft ? RoomModel.safeParse(draft.model) : null;
    if (!model?.success) continue;
    for (const d of model.data.devices) {
      if (!d.siteDeviceId) continue;
      const list = out.get(d.siteDeviceId) ?? [];
      list.push({
        roomId: room.id,
        roomName: room.name,
        gatewayId: room.gatewayId,
        deviceId: d.id,
        deviceName: d.name,
        ports: d.ports.flatMap((p) => (p.maps ? [{ id: p.id, maps: p.maps }] : [])),
      });
      out.set(d.siteDeviceId, list);
    }
  }
  return out;
}

/**
 * The same physical port used by two rooms of one device: for an exclusive device the lock handles
 * it, but for a matrix output or a DSP zone it means two rooms fighting over one thing.
 */
export function portConflicts(uses: SiteDeviceUse[]): { port: string; rooms: string[] }[] {
  const byPort = new Map<string, Set<string>>();
  for (const u of uses)
    for (const p of u.ports) byPort.set(p.maps, new Set([...(byPort.get(p.maps) ?? []), u.roomName]));
  return [...byPort].filter(([, rooms]) => rooms.size > 1).map(([port, rooms]) => ({ port, rooms: [...rooms].sort() }));
}

/**
 * Whether putting a room on this gateway keeps every room that shares a device with it on one
 * gateway (a device has one connection, so all its rooms must run in the same place).
 */
export async function sharedGatewayProblem(
  db: SiteDeviceDb,
  input: { orgId: string; siteId: string; roomId: string; gatewayId: string; model: RoomModel },
): Promise<string | null> {
  const refs = sharedRefs(input.model);
  if (refs.length === 0) return null;
  const uses = await usesOfSite(db, input.orgId, input.siteId);
  for (const ref of refs)
    for (const other of uses.get(ref.siteDeviceId) ?? [])
      if (other.roomId !== input.roomId && other.gatewayId && other.gatewayId !== input.gatewayId)
        return `${other.roomName} uses the same shared device on a different gateway. Rooms that share a device must run on the same gateway`;
  return null;
}

/** The rooms whose designs use a shared device, wherever they run. */
export async function roomsUsing(db: SiteDeviceDb, orgId: string, siteId: string, siteDeviceId: string) {
  return (await usesOfSite(db, orgId, siteId)).get(siteDeviceId) ?? [];
}

// ---- Views ---------------------------------------------------------------------------------------

export interface SiteDeviceSlot extends BindingSlot {
  value?: unknown;
  isSet: boolean;
}

export interface SiteDeviceView {
  id: string;
  siteId: string;
  name: string;
  category: string;
  control: unknown;
  exclusive: boolean;
  credentialSetId: string | null;
  version: number;
  slots: SiteDeviceSlot[];
  uses: SiteDeviceUse[];
  conflicts: { port: string; rooms: string[] }[];
}

/** A shared device for a browser: addresses as they are, logins only as "set or not". */
export async function siteDeviceViews(
  db: SiteDeviceDb,
  input: { orgId: string; siteId?: string; custom?: CustomDrivers },
  key = secretsKey(),
): Promise<SiteDeviceView[]> {
  const rows = await db.siteDevice.findMany({
    where: { orgId: input.orgId, ...(input.siteId ? { siteId: input.siteId } : {}) },
    orderBy: { name: 'asc' },
  });
  const usesBySite = new Map<string, Map<string, SiteDeviceUse[]>>();
  const views: SiteDeviceView[] = [];
  for (const row of rows) {
    if (!usesBySite.has(row.siteId)) usesBySite.set(row.siteId, await usesOfSite(db, input.orgId, row.siteId));
    const uses = usesBySite.get(row.siteId)!.get(row.id) ?? [];
    const secrets = openSecrets(row.sealed, key);
    const values = isObject(row.values) ? row.values : {};
    const set = row.credentialSetId ? await db.credentialSet.findFirst({ where: { id: row.credentialSetId, orgId: input.orgId } }) : null;
    views.push({
      id: row.id,
      siteId: row.siteId,
      name: row.name,
      category: row.category,
      control: row.control,
      exclusive: row.exclusive,
      credentialSetId: row.credentialSetId,
      version: row.version,
      slots: slotsFor(asDevice(row), input.custom ?? {}).map((s) => ({
        ...s,
        ...(s.scope === 'binding' && !blank(values[s.key]) ? { value: values[s.key] } : {}),
        isSet: !blank(values[s.key]) || !blank(secrets[s.key]) || (set !== null && set.fields.includes(s.key)),
      })),
      uses,
      conflicts: portConflicts(uses),
    });
  }
  return views;
}

// ---- Changing them -------------------------------------------------------------------------------

export async function createSiteDevice(
  db: SiteDeviceDb & Pick<PrismaClient, 'site'>,
  input: {
    orgId: string;
    siteId: string;
    name: string;
    category: string;
    control: unknown;
    exclusive?: boolean;
    userId: string | null;
  },
): Promise<Result<{ id: string }>> {
  const name = cleanName(input.name);
  if (!name || name.length > 80) return { ok: false, message: 'Give the device a name of up to 80 characters' };
  const category = DeviceCategory.safeParse(input.category);
  if (!category.success) return { ok: false, message: 'That is not a device category' };
  const control = DeviceControl.safeParse(input.control);
  if (!control.success) return { ok: false, message: 'Choose how the device is controlled' };
  const site = await db.site.findFirst({ where: { id: input.siteId, orgId: input.orgId } });
  if (!site) return { ok: false, message: 'That site does not exist' };
  if (await db.siteDevice.findFirst({ where: { siteId: site.id, name } }))
    return { ok: false, message: 'A shared device with that name already exists at this site' };
  const count = (await db.siteDevice.findMany({ where: { siteId: site.id } })).length;
  if (count >= MAX_SITE_DEVICES_PER_SITE)
    return { ok: false, message: `A site can have up to ${MAX_SITE_DEVICES_PER_SITE} shared devices` };
  const row = await db.siteDevice.create({
    data: {
      orgId: input.orgId,
      siteId: site.id,
      name,
      category: category.data,
      control: control.data as unknown as Prisma.InputJsonValue,
      exclusive: !!input.exclusive,
      updatedBy: input.userId,
    },
  });
  return { ok: true, id: row.id };
}

/**
 * Change a shared device. `set` replaces addresses and logins the way a room's Setup does (an
 * empty value clears one); `credentialSetId` (null to remove) picks a shared login. Any change to
 * its address, login or exclusivity gives every room that uses it a new bindings version.
 */
export async function updateSiteDevice(
  db: SiteDeviceDb,
  input: {
    orgId: string;
    id: string;
    name?: string;
    exclusive?: boolean;
    set?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    credentialSetId?: string | null;
    custom?: CustomDrivers;
    userId: string | null;
  },
  key = secretsKey(),
): Promise<Result<{ version: number }>> {
  const row = await db.siteDevice.findFirst({ where: { id: input.id, orgId: input.orgId } });
  if (!row) return { ok: false, message: 'That shared device does not exist' };
  const device = asDevice(row);
  const custom = input.custom ?? {};
  const values = { ...(isObject(row.values) ? row.values : {}) };
  const settings = { ...(isObject(row.settings) ? row.settings : {}) };
  let secrets: Record<string, unknown>;
  try {
    secrets = openSecrets(row.sealed, key);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Cannot open the stored logins' };
  }
  let changed = false;

  for (const [k, v] of Object.entries(input.set ?? {})) {
    const scope = scopeOfSetting(device, k, custom);
    if (scope === 'design') return { ok: false, message: `“${k}” is part of the device’s design, not its address or login` };
    const bucket = scope === 'secret' ? secrets : values;
    if (blank(v)) delete bucket[k];
    else bucket[k] = v;
    changed = true;
  }
  for (const [k, v] of Object.entries(input.settings ?? {})) {
    if (scopeOfSetting(device, k, custom) !== 'design')
      return { ok: false, message: `“${k}” is an address or login: set it under the device’s address` };
    if (blank(v)) delete settings[k];
    else settings[k] = v;
    changed = true;
  }
  let credentialSetId = row.credentialSetId;
  if (input.credentialSetId !== undefined) {
    if (input.credentialSetId !== null && !(await db.credentialSet.findFirst({ where: { id: input.credentialSetId, orgId: input.orgId } })))
      return { ok: false, message: 'That credential set does not exist' };
    if (credentialSetId !== input.credentialSetId) changed = true;
    credentialSetId = input.credentialSetId;
  }
  let name = row.name;
  if (input.name !== undefined) {
    name = cleanName(input.name);
    if (!name || name.length > 80) return { ok: false, message: 'Give the device a name of up to 80 characters' };
    if (name !== row.name && (await db.siteDevice.findFirst({ where: { siteId: row.siteId, name } })))
      return { ok: false, message: 'A shared device with that name already exists at this site' };
  }
  const exclusive = input.exclusive ?? row.exclusive;
  if (exclusive !== row.exclusive) changed = true;
  const hasSecrets = Object.keys(secrets).length > 0;
  if (hasSecrets && !key) return { ok: false, message: 'Storing logins needs KESTREL_SECRETS_KEY on the server' };

  const version = changed ? row.version + 1 : row.version;
  await db.siteDevice.update({
    where: { id: row.id },
    data: {
      name,
      exclusive,
      settings: settings as Prisma.InputJsonValue,
      values: values as Prisma.InputJsonValue,
      sealed: hasSecrets ? seal(JSON.stringify(secrets), key!) : null,
      credentialSetId,
      version,
      updatedBy: input.userId,
    },
  });
  return { ok: true, version };
}

/** A shared device that a room still uses cannot be deleted. */
export async function deleteSiteDevice(db: SiteDeviceDb, orgId: string, id: string): Promise<Result> {
  const row = await db.siteDevice.findFirst({ where: { id, orgId } });
  if (!row) return { ok: false, message: 'That shared device does not exist' };
  const uses = await roomsUsing(db, orgId, row.siteId, id);
  if (uses.length > 0) {
    const names = [...new Set(uses.map((u) => u.roomName))];
    return {
      ok: false,
      message: `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''} use${names.length === 1 ? 's' : ''} this device. Take it out of their designs first`,
    };
  }
  await db.siteDevice.delete({ where: { id } });
  return { ok: true };
}

/** A device in a room design that is a slice of this shared device. It takes its driver from the site device. */
export async function referenceFor(
  db: SiteDeviceDb,
  orgId: string,
  siteDeviceId: string,
): Promise<{ name: string; category: Device['category']; control: Device['control'] } | null> {
  const row = await db.siteDevice.findFirst({ where: { id: siteDeviceId, orgId } });
  if (!row) return null;
  return { name: row.name, category: row.category as Device['category'], control: DeviceControl.safeParse(row.control).data };
}
