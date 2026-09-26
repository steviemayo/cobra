import { open, seal, signBindings } from '@kestrel/crypto';
import type { Prisma, PrismaClient } from '@kestrel/db';
import {
  missingBindings,
  scopeOfSetting,
  slotsFor,
  stripBindings,
  type BindingSlot,
  type CustomDrivers,
  type Device,
  type DeviceValues,
  type MissingBinding,
  type RoomModel,
  type SignedBindings,
} from '@kestrel/model';
import type { SigningKey } from './signing';

// A room's addresses and logins, kept apart from its design (docs/driver-classes.md). Secrets are
// sealed with KESTREL_SECRETS_KEY before they reach the database and are never sent to a browser.
// These functions take the database as a parameter so they can be tested without one.
export type BindingsDb = Pick<PrismaClient, 'roomBinding' | 'credentialSet'>;

export const MAX_CREDENTIAL_SETS_PER_ORG = 200;

const secretsKey = () => process.env.KESTREL_SECRETS_KEY || undefined;

type Fields = Record<string, unknown>;
interface Stored {
  id: string;
  version: number;
  values: DeviceValues;
  secrets: DeviceValues;
  credentialSets: Record<string, string>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const blank = (v: unknown) => v === undefined || v === null || v === '';

function asDeviceValues(v: unknown): DeviceValues {
  const out: DeviceValues = {};
  if (isObject(v)) for (const [id, fields] of Object.entries(v)) if (isObject(fields)) out[id] = { ...fields };
  return out;
}

function sealFields(fields: Fields, key: string): string {
  return seal(JSON.stringify(fields), key);
}

function openFields(sealed: string, key: string): Fields {
  const parsed: unknown = JSON.parse(open(sealed, key));
  return isObject(parsed) ? parsed : {};
}

async function read(db: BindingsDb, roomId: string, key: string | undefined): Promise<Stored | null> {
  const row = await db.roomBinding.findFirst({ where: { roomId } });
  if (!row) return null;
  let secrets: DeviceValues = {};
  if (row.sealed) {
    if (!key) throw new Error('This room has stored logins but the server has no KESTREL_SECRETS_KEY');
    secrets = asDeviceValues(openFields(row.sealed, key));
  }
  const sets: Record<string, string> = {};
  if (isObject(row.credentialSets))
    for (const [id, v] of Object.entries(row.credentialSets)) if (typeof v === 'string') sets[id] = v;
  return { id: row.id, version: row.version, values: asDeviceValues(row.values), secrets, credentialSets: sets };
}

async function write(
  db: BindingsDb,
  input: { orgId: string; roomId: string; userId: string | null; key: string | undefined },
  next: Omit<Stored, 'id' | 'version'>,
  current: Stored | null,
): Promise<number> {
  const secretCount = Object.values(next.secrets).reduce((n, f) => n + Object.keys(f).length, 0);
  if (secretCount > 0 && !input.key) throw new Error('Storing logins needs KESTREL_SECRETS_KEY on the server');
  const data = {
    values: next.values as Prisma.InputJsonValue,
    sealed: secretCount > 0 ? sealFields(next.secrets, input.key!) : null,
    credentialSets: next.credentialSets as Prisma.InputJsonValue,
    updatedBy: input.userId,
  };
  if (current) {
    const version = current.version + 1;
    await db.roomBinding.update({ where: { id: current.id }, data: { ...data, version } });
    return version;
  }
  await db.roomBinding.create({ data: { orgId: input.orgId, roomId: input.roomId, version: 1, ...data } });
  return 1;
}

const emptyNext = (): Omit<Stored, 'id' | 'version'> => ({ values: {}, secrets: {}, credentialSets: {} });

/** What the credential sets a room uses give each device, as the lowest layer. */
async function credentialFields(db: BindingsDb, orgId: string, ids: string[], key: string | undefined) {
  const out = new Map<string, Fields>();
  for (const id of new Set(ids)) {
    const row = await db.credentialSet.findFirst({ where: { id, orgId } });
    if (row) {
      if (!key) throw new Error('This room uses a credential set but the server has no KESTREL_SECRETS_KEY');
      out.set(id, openFields(row.sealed, key));
    }
  }
  return out;
}

// ---- What a gateway gets -------------------------------------------------------------------------

/**
 * A room's addresses and logins with credential sets resolved, for a gateway. For each device the
 * credential set's fields sit under the device's own addresses, which sit under its own logins.
 * Null when the room has none.
 */
export async function resolveBindings(
  db: BindingsDb,
  orgId: string,
  roomId: string,
  key = secretsKey(),
): Promise<{ version: number; devices: DeviceValues } | null> {
  const stored = await read(db, roomId, key);
  if (!stored) return null;
  const sets = await credentialFields(db, orgId, Object.values(stored.credentialSets), key);
  const ids = new Set([...Object.keys(stored.values), ...Object.keys(stored.secrets), ...Object.keys(stored.credentialSets)]);
  const devices: DeviceValues = {};
  for (const id of ids) {
    const setId = stored.credentialSets[id];
    const merged = { ...(setId ? sets.get(setId) : undefined), ...stored.values[id], ...stored.secrets[id] };
    if (Object.keys(merged).length > 0) devices[id] = merged;
  }
  return { version: stored.version, devices };
}

/** The bindings version a gateway should run a room with, or undefined when the room has none. */
export async function bindingsVersionOf(db: BindingsDb, roomId: string): Promise<number | undefined> {
  const row = await db.roomBinding.findFirst({ where: { roomId } });
  return row?.version;
}

/** A room's bindings, signed so a gateway trusts them only if Kestrel made them. */
export async function signedBindingsFor(
  db: BindingsDb,
  orgId: string,
  roomId: string,
  signing: SigningKey,
  key = secretsKey(),
): Promise<SignedBindings | null> {
  const bindings = await resolveBindings(db, orgId, roomId, key);
  if (!bindings) return null;
  return signBindings({ orgId, roomId, version: bindings.version, devices: bindings.devices }, signing);
}

// ---- Changing them -------------------------------------------------------------------------------

export type SaveResult = { ok: true; version: number } | { ok: false; message: string };

/**
 * Set, replace or clear addresses and logins for one device. `set` may only name settings the
 * driver says are a binding or a secret; design settings belong in the device editor. An empty
 * value clears it. `credentialSetId` (null to remove) picks a shared login for the device.
 */
export async function saveDeviceBinding(
  db: BindingsDb,
  input: {
    orgId: string;
    roomId: string;
    device: Device;
    custom?: CustomDrivers;
    set?: Fields;
    credentialSetId?: string | null;
    userId: string | null;
  },
  key = secretsKey(),
): Promise<SaveResult> {
  const custom = input.custom ?? {};
  const next = emptyNext();
  const current = await read(db, input.roomId, key);
  if (current) {
    next.values = structuredClone(current.values);
    next.secrets = structuredClone(current.secrets);
    next.credentialSets = { ...current.credentialSets };
  }
  const id = input.device.id;

  for (const [k, v] of Object.entries(input.set ?? {})) {
    const scope = scopeOfSetting(input.device, k, custom);
    if (scope === 'design')
      return { ok: false, message: `“${k}” is part of the device’s design, not its address or login` };
    const bucket = scope === 'secret' ? next.secrets : next.values;
    if (blank(v)) {
      if (bucket[id]) delete bucket[id][k];
    } else (bucket[id] ??= {})[k] = v;
  }
  for (const b of [next.values, next.secrets]) if (b[id] && Object.keys(b[id]).length === 0) delete b[id];

  if (input.credentialSetId !== undefined) {
    if (input.credentialSetId === null) delete next.credentialSets[id];
    else {
      const set = await db.credentialSet.findFirst({ where: { id: input.credentialSetId, orgId: input.orgId } });
      if (!set) return { ok: false, message: 'That credential set does not exist' };
      next.credentialSets[id] = set.id;
    }
  }
  const secretCount = Object.values(next.secrets).reduce((n, f) => n + Object.keys(f).length, 0);
  if (secretCount > 0 && !key) return { ok: false, message: 'Storing logins needs KESTREL_SECRETS_KEY on the server' };

  const version = await write(db, { orgId: input.orgId, roomId: input.roomId, userId: input.userId, key }, next, current);
  return { ok: true, version };
}

/**
 * Moves addresses and logins found inline in a room's design into its bindings, and returns the
 * design without them. Only fills what the room's bindings lack, so a value set in the bindings
 * is never overwritten by an older inline copy. Without a secrets key, logins stay inline (as they
 * always did) and only addresses move.
 */
export async function absorbInline(
  db: BindingsDb,
  input: { orgId: string; roomId: string; model: RoomModel; custom?: CustomDrivers; userId: string | null },
  key = secretsKey(),
): Promise<{
  model: RoomModel;
  version: number | undefined;
  /** Inline values that differ from what the bindings already hold. The bindings win. */
  conflicts: { deviceId: string; deviceName: string; key: string }[];
}> {
  const custom = input.custom ?? {};
  const { model: bare, parts } = stripBindings(input.model, custom);
  const hasSecrets = Object.keys(parts.secret).length > 0;
  const takeSecrets = hasSecrets && !!key;
  const current = await read(db, input.roomId, key);

  const next = emptyNext();
  if (current) {
    next.values = structuredClone(current.values);
    next.secrets = structuredClone(current.secrets);
    next.credentialSets = { ...current.credentialSets };
  }
  let changed = false;
  const conflicts: { deviceId: string; deviceName: string; key: string }[] = [];
  const names = new Map(input.model.devices.map((d) => [d.id, d.name]));
  const fill = (into: DeviceValues, from: DeviceValues) => {
    for (const [id, fields] of Object.entries(from))
      for (const [k, v] of Object.entries(fields)) {
        if (blank(v)) continue;
        if (blank(into[id]?.[k])) {
          (into[id] ??= {})[k] = v;
          changed = true;
        } else if (JSON.stringify(into[id]![k]) !== JSON.stringify(v))
          conflicts.push({ deviceId: id, deviceName: names.get(id) ?? id, key: k });
      }
  };
  fill(next.values, parts.binding);
  if (takeSecrets) fill(next.secrets, parts.secret);
  const version = changed
    ? await write(db, { orgId: input.orgId, roomId: input.roomId, userId: input.userId, key }, next, current)
    : current?.version;

  if (takeSecrets) return { model: bare, version, conflicts };
  // No key: keep the logins in the design, take the addresses out.
  const kept: RoomModel = {
    ...bare,
    devices: bare.devices.map((d) => {
      const secrets = parts.secret[d.id];
      return secrets ? { ...d, settings: { ...d.settings, ...secrets } } : d;
    }),
  };
  return { model: kept, version, conflicts };
}

// ---- Many devices at once (bulk create) ----------------------------------------------------------

/** A room's stored addresses and shared-login choices, without opening any sealed login. */
export async function readPlainBindings(
  db: BindingsDb,
  roomId: string,
): Promise<{ values: DeviceValues; credentialSets: Record<string, string> }> {
  const row = await db.roomBinding.findFirst({ where: { roomId } });
  const credentialSets: Record<string, string> = {};
  if (row && isObject(row.credentialSets))
    for (const [id, v] of Object.entries(row.credentialSets)) if (typeof v === 'string') credentialSets[id] = v;
  return { values: row ? asDeviceValues(row.values) : {}, credentialSets };
}

/** What setting these would change. A blank value never clears anything: it means "leave it". */
export function bindingChanges(
  current: { values: DeviceValues; credentialSets: Record<string, string> },
  incoming: { values: DeviceValues; credentialSets?: Record<string, string> },
): { values: DeviceValues; credentialSets: Record<string, string> } {
  const values: DeviceValues = {};
  for (const [id, fields] of Object.entries(incoming.values))
    for (const [k, v] of Object.entries(fields))
      if (!blank(v) && JSON.stringify(current.values[id]?.[k]) !== JSON.stringify(v)) (values[id] ??= {})[k] = v;
  const credentialSets: Record<string, string> = {};
  for (const [id, setId] of Object.entries(incoming.credentialSets ?? {}))
    if (current.credentialSets[id] !== setId) credentialSets[id] = setId;
  return { values, credentialSets };
}

/**
 * Set addresses (and shared-login choices) for many devices of one room in a single change, so the
 * room gets one new version. Values are written as they are: the caller must already have checked
 * they are addresses. Nothing to change writes nothing.
 */
export async function setRoomBindings(
  db: BindingsDb,
  input: {
    orgId: string;
    roomId: string;
    userId: string | null;
    values: DeviceValues;
    credentialSets?: Record<string, string>;
  },
  key = secretsKey(),
): Promise<{ version: number | undefined; changed: boolean }> {
  const plain = await readPlainBindings(db, input.roomId);
  const change = bindingChanges(plain, input);
  if (Object.keys(change.values).length === 0 && Object.keys(change.credentialSets).length === 0)
    return { version: (await db.roomBinding.findFirst({ where: { roomId: input.roomId } }))?.version, changed: false };
  const current = await read(db, input.roomId, key);
  const next = emptyNext();
  if (current) {
    next.values = structuredClone(current.values);
    next.secrets = structuredClone(current.secrets);
    next.credentialSets = { ...current.credentialSets };
  }
  for (const [id, fields] of Object.entries(change.values)) next.values[id] = { ...next.values[id], ...fields };
  Object.assign(next.credentialSets, change.credentialSets);
  const version = await write(db, { orgId: input.orgId, roomId: input.roomId, userId: input.userId, key }, next, current);
  return { version, changed: true };
}

// ---- What a browser sees -------------------------------------------------------------------------

export interface SlotView extends BindingSlot {
  /** The value, for an address. Never sent for a secret. */
  value?: unknown;
  /** Whether something is set, from the device's own value or its credential set. */
  isSet: boolean;
  fromCredentialSet: boolean;
}

export interface DeviceBindingView {
  deviceId: string;
  name: string;
  slots: SlotView[];
  credentialSetId: string | null;
}

export interface BindingView {
  version: number | null;
  devices: DeviceBindingView[];
  missing: MissingBinding[];
}

/** A room's addresses for a browser: values for addresses, only "set or not" for logins. */
export async function bindingView(
  db: BindingsDb,
  input: { orgId: string; roomId: string; model: RoomModel; custom?: CustomDrivers },
  key = secretsKey(),
): Promise<BindingView> {
  const custom = input.custom ?? {};
  const stored = await read(db, input.roomId, key);
  const resolved = await resolveBindings(db, input.orgId, input.roomId, key);
  const devices: DeviceBindingView[] = [];
  for (const d of input.model.devices) {
    const slots = slotsFor(d, custom);
    if (slots.length === 0) continue;
    const own = { ...stored?.values[d.id], ...stored?.secrets[d.id] };
    const all = resolved?.devices[d.id] ?? {};
    devices.push({
      deviceId: d.id,
      name: d.name,
      credentialSetId: stored?.credentialSets[d.id] ?? null,
      slots: slots.map((s) => ({
        ...s,
        ...(s.scope === 'binding' && !blank(all[s.key]) ? { value: all[s.key] } : {}),
        isSet: !blank(all[s.key]) || !blank(d.settings[s.key]),
        fromCredentialSet: blank(own[s.key]) && !blank(all[s.key]),
      })),
    });
  }
  return {
    version: stored?.version ?? null,
    devices,
    missing: missingBindings(input.model, resolved?.devices ?? {}, custom),
  };
}

// ---- Credential sets -----------------------------------------------------------------------------

export interface CredentialSetView {
  id: string;
  name: string;
  fields: string[];
  updatedAt: Date;
  usedBy: number;
}

type SetResult = { ok: true; id: string } | { ok: false; message: string };

const cleanName = (n: string) => n.trim().replace(/\s+/g, ' ');

async function usersOf(db: BindingsDb, orgId: string, setId: string) {
  const rows = await db.roomBinding.findMany({ where: { orgId } });
  return rows.filter((r) => isObject(r.credentialSets) && Object.values(r.credentialSets).includes(setId));
}

export async function listCredentialSets(db: BindingsDb, orgId: string): Promise<CredentialSetView[]> {
  const [sets, bindings] = await Promise.all([
    db.credentialSet.findMany({ where: { orgId }, orderBy: { name: 'asc' } }),
    db.roomBinding.findMany({ where: { orgId } }),
  ]);
  return sets.map((s) => ({
    id: s.id,
    name: s.name,
    fields: s.fields,
    updatedAt: s.updatedAt,
    usedBy: bindings.filter(
      (b) => isObject(b.credentialSets) && Object.values(b.credentialSets).includes(s.id),
    ).length,
  }));
}

export async function createCredentialSet(
  db: BindingsDb,
  input: { orgId: string; name: string; fields: Record<string, string>; userId: string | null },
  key = secretsKey(),
): Promise<SetResult> {
  const name = cleanName(input.name);
  const fields = Object.fromEntries(Object.entries(input.fields).filter(([, v]) => v !== ''));
  if (!name) return { ok: false, message: 'Give the credential set a name' };
  if (Object.keys(fields).length === 0) return { ok: false, message: 'Add at least one field' };
  if (!key) return { ok: false, message: 'Storing logins needs KESTREL_SECRETS_KEY on the server' };
  if ((await db.credentialSet.findMany({ where: { orgId: input.orgId } })).length >= MAX_CREDENTIAL_SETS_PER_ORG)
    return { ok: false, message: `An organisation can have up to ${MAX_CREDENTIAL_SETS_PER_ORG} credential sets` };
  if (await db.credentialSet.findFirst({ where: { orgId: input.orgId, name } }))
    return { ok: false, message: 'A credential set with that name already exists' };
  const row = await db.credentialSet.create({
    data: {
      orgId: input.orgId,
      name,
      sealed: sealFields(fields, key),
      fields: Object.keys(fields).sort(),
      updatedBy: input.userId,
    },
  });
  return { ok: true, id: row.id };
}

/**
 * Rename a set and change its fields: a value replaces the field, an empty string removes it,
 * fields not mentioned are kept. Every room that uses the set gets a new bindings version, so its
 * gateway picks the change up without a new release.
 */
export async function updateCredentialSet(
  db: BindingsDb,
  input: { orgId: string; id: string; name?: string; fields?: Record<string, string>; userId: string | null },
  key = secretsKey(),
): Promise<SetResult & { roomsUpdated?: number }> {
  const row = await db.credentialSet.findFirst({ where: { id: input.id, orgId: input.orgId } });
  if (!row) return { ok: false, message: 'That credential set does not exist' };
  if (!key) return { ok: false, message: 'Storing logins needs KESTREL_SECRETS_KEY on the server' };
  const name = input.name === undefined ? row.name : cleanName(input.name);
  if (!name) return { ok: false, message: 'Give the credential set a name' };
  if (name !== row.name && (await db.credentialSet.findFirst({ where: { orgId: input.orgId, name } })))
    return { ok: false, message: 'A credential set with that name already exists' };
  const fields = openFields(row.sealed, key);
  for (const [k, v] of Object.entries(input.fields ?? {})) {
    if (v === '') delete fields[k];
    else fields[k] = v;
  }
  if (Object.keys(fields).length === 0) return { ok: false, message: 'A credential set needs at least one field' };
  await db.credentialSet.update({
    where: { id: row.id },
    data: { name, sealed: sealFields(fields, key), fields: Object.keys(fields).sort(), updatedBy: input.userId },
  });
  const users = await usersOf(db, input.orgId, row.id);
  for (const u of users) await db.roomBinding.update({ where: { id: u.id }, data: { version: u.version + 1 } });
  return { ok: true, id: row.id, roomsUpdated: users.length };
}

/** A set that rooms still use cannot be deleted. */
export async function deleteCredentialSet(
  db: BindingsDb,
  orgId: string,
  id: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const row = await db.credentialSet.findFirst({ where: { id, orgId } });
  if (!row) return { ok: false, message: 'That credential set does not exist' };
  const users = await usersOf(db, orgId, id);
  if (users.length > 0)
    return { ok: false, message: `${users.length} room${users.length === 1 ? ' uses' : 's use'} this credential set. Remove it from them first` };
  await db.credentialSet.delete({ where: { id } });
  return { ok: true };
}
