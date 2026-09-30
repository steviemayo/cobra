import type { Prisma, PrismaClient } from '@kestrel/db';
import {
  CONFIG_FIELDS,
  ConfigParams,
  checkConfigParam,
  diffSnapshots,
  effectiveParams,
  holdableFields,
  paramCommand,
  planDeploy,
  splitApplicable,
  stepDrift,
  stripSecrets,
  type ConfigParam,
  type ConfigState,
  type DeviceCommand,
  type SnapshotChange,
  type SnapshotData,
} from '@kestrel/model';
import { openIncident, resolveIncident, type AlertJob, type MonitoringDb } from './monitoring';

// Device configuration (docs/pivot-monitoring.md): profiles, per-device settings, drift and
// enforcement, snapshots and staged deploys. Functions take the database as a parameter so they can
// be tested without one. A parameter only applies to a device that reports that reading.
export type ConfigDb = Pick<
  PrismaClient,
  'device' | 'deviceEvent' | 'configProfile' | 'deviceSnapshot' | 'configDeploy' | 'incident'
>;

type DeviceRow = NonNullable<Awaited<ReturnType<ConfigDb['device']['findFirst']>>>;
type Result<T = { id: string }> = { ok: true; value: T } | { ok: false; message: string };
const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const parseParams = (v: unknown): ConfigParam[] => {
  const r = ConfigParams.safeParse(v);
  return r.success ? r.data : [];
};

/** The readings a device has given, by field: what it can be held to. */
export const readingsOf = (d: Pick<DeviceRow, 'feedback'>): Record<string, unknown> =>
  isObject(d.feedback) ? d.feedback : {};

async function log(
  db: ConfigDb,
  orgId: string,
  deviceId: string,
  e: {
    type: string;
    field?: string;
    oldValue?: string | null;
    newValue?: string | null;
    source?: string;
    actorId?: string | null;
    data?: Prisma.InputJsonValue;
  },
  at: Date,
) {
  await db.deviceEvent.create({
    data: {
      orgId,
      deviceId,
      type: e.type,
      field: e.field ?? null,
      oldValue: e.oldValue ?? null,
      newValue: e.newValue ?? null,
      source: e.source ?? 'system',
      actorId: e.actorId ?? null,
      ...(e.data ? { data: e.data } : {}),
      at,
    },
  });
}

// ---- Profiles ------------------------------------------------------------------------------------

function checkParams(params: ConfigParam[]): string | null {
  const seen = new Set<string>();
  for (const p of params) {
    const problem = checkConfigParam(p);
    if (problem) return problem;
    if (seen.has(p.field)) return `${CONFIG_FIELDS[p.field]?.label ?? p.field} is listed twice`;
    seen.add(p.field);
  }
  return null;
}

export async function createProfile(
  db: ConfigDb,
  input: {
    orgId: string;
    name: string;
    description?: string | null;
    category?: string | null;
    params: unknown;
    userId: string | null;
  },
): Promise<Result> {
  const parsed = ConfigParams.safeParse(input.params);
  if (!parsed.success) return bad('Those settings are not valid');
  const problem = checkParams(parsed.data);
  if (problem) return bad(problem);
  if (await db.configProfile.findFirst({ where: { orgId: input.orgId, name: input.name } }))
    return bad('There is already a profile with that name');
  const row = await db.configProfile.create({
    data: {
      orgId: input.orgId,
      name: input.name,
      description: input.description ?? null,
      category: input.category ?? null,
      params: parsed.data as unknown as Prisma.InputJsonValue,
      version: 1,
      createdBy: input.userId,
    },
  });
  return { ok: true, value: { id: row.id } };
}

export async function updateProfile(
  db: ConfigDb,
  input: {
    orgId: string;
    profileId: string;
    name?: string;
    description?: string | null;
    category?: string | null;
    params?: unknown;
  },
): Promise<Result> {
  const row = await db.configProfile.findFirst({
    where: { id: input.profileId, orgId: input.orgId },
  });
  if (!row) return bad('No such profile');
  const data: Record<string, unknown> = {};
  if (input.name !== undefined && input.name !== row.name) {
    if (await db.configProfile.findFirst({ where: { orgId: input.orgId, name: input.name } }))
      return bad('There is already a profile with that name');
    data.name = input.name;
  }
  if (input.description !== undefined) data.description = input.description;
  if (input.category !== undefined) data.category = input.category;
  if (input.params !== undefined) {
    const parsed = ConfigParams.safeParse(input.params);
    if (!parsed.success) return bad('Those settings are not valid');
    const problem = checkParams(parsed.data);
    if (problem) return bad(problem);
    if (JSON.stringify(parsed.data) !== JSON.stringify(row.params)) {
      data.params = parsed.data as unknown as Prisma.InputJsonValue;
      data.version = row.version + 1;
    }
  }
  if (Object.keys(data).length > 0) await db.configProfile.update({ where: { id: row.id }, data });
  return { ok: true, value: { id: row.id } };
}

/** Deleting a profile lets its devices go: nothing holds them any more. */
export async function deleteProfile(
  db: ConfigDb,
  orgId: string,
  profileId: string,
): Promise<Result> {
  const row = await db.configProfile.findFirst({ where: { id: profileId, orgId } });
  if (!row) return bad('No such profile');
  const held = await db.device.findMany({ where: { orgId, profileId } });
  for (const d of held)
    await db.device.update({ where: { id: d.id }, data: { profileId: null, configState: {} } });
  await db.configProfile.delete({ where: { id: profileId } });
  return { ok: true, value: { id: profileId } };
}

// ---- A device's own settings ----------------------------------------------------------------------

/**
 * Sets a device's profile and its own held settings. A setting of its own must be one the device
 * reports and Kestrel can set, so nothing is recorded that cannot exist on that device.
 */
export async function setDeviceConfig(
  db: ConfigDb,
  input: {
    orgId: string;
    deviceId: string;
    profileId?: string | null;
    params?: unknown;
    actorId: string | null;
  },
  now = new Date(),
): Promise<Result> {
  const device = await db.device.findFirst({ where: { id: input.deviceId, orgId: input.orgId } });
  if (!device) return bad('No such device');
  if (device.kind !== 'active') return bad('Only a monitored device can be held to settings');
  const data: Record<string, unknown> = {};
  if (input.profileId !== undefined && input.profileId !== device.profileId) {
    if (input.profileId) {
      const profile = await db.configProfile.findFirst({
        where: { id: input.profileId, orgId: input.orgId },
      });
      if (!profile) return bad('No such profile');
    }
    data.profileId = input.profileId;
    // A different profile starts with a clean record of what drifted.
    data.configState = {};
    await log(
      db,
      input.orgId,
      device.id,
      {
        type: 'profile_assigned',
        newValue: input.profileId,
        oldValue: device.profileId,
        source: 'manual',
        actorId: input.actorId,
      },
      now,
    );
  }
  if (input.params !== undefined) {
    const parsed = ConfigParams.safeParse(input.params);
    if (!parsed.success) return bad('Those settings are not valid');
    const problem = checkParams(parsed.data);
    if (problem) return bad(problem);
    const allowed = new Set(holdableFields(Object.keys(readingsOf(device))));
    for (const p of parsed.data)
      if (!allowed.has(p.field))
        return bad(
          `${CONFIG_FIELDS[p.field]?.label ?? p.field} is not something this device reports`,
        );
    data.configParams = parsed.data as unknown as Prisma.InputJsonValue;
    await log(
      db,
      input.orgId,
      device.id,
      { type: 'config_changed', source: 'manual', actorId: input.actorId },
      now,
    );
  }
  if (Object.keys(data).length > 0) await db.device.update({ where: { id: device.id }, data });
  return { ok: true, value: { id: device.id } };
}

/** What a device is held to now: each setting that applies, and the ones set aside because it does not report them. */
export async function deviceConfigView(db: ConfigDb, orgId: string, deviceId: string) {
  const device = await db.device.findFirst({ where: { id: deviceId, orgId } });
  if (!device) return null;
  const profile = device.profileId
    ? await db.configProfile.findFirst({ where: { id: device.profileId, orgId } })
    : null;
  const params = effectiveParams(parseParams(profile?.params), parseParams(device.configParams));
  const reported = Object.keys(readingsOf(device));
  const { applies, skipped } = splitApplicable(params, reported);
  const state = (isObject(device.configState) ? device.configState : {}) as unknown as ConfigState;
  return {
    profile: profile ? { id: profile.id, name: profile.name, version: profile.version } : null,
    own: parseParams(device.configParams),
    applies: applies.map((p) => ({
      ...p,
      drift: state[p.field]?.drifted ? state[p.field]! : null,
      reading: readingsOf(device)[p.field] ?? null,
    })),
    notApplicable: skipped,
    /** The settings this device could be held to: what it reports that Kestrel can set. */
    holdable: holdableFields(reported).map((f) => ({
      field: f,
      label: CONFIG_FIELDS[f]!.label,
      reading: readingsOf(device)[f],
    })),
  };
}

// ---- Drift and enforcement on each report ----------------------------------------------------------

export interface EnforceItem {
  deviceId: string;
  command: DeviceCommand;
}

/**
 * Compares a device's new readings with what it is held to. A setting that starts to drift becomes a
 * `config_drift` incident (and a history entry); one that comes right closes it. Enforced settings
 * are returned as commands for the gateway to send. A push (from a deploy or a rollback) sends its
 * values regardless of mode, once.
 */
export async function evaluateConfig(
  db: ConfigDb,
  device: DeviceRow,
  readings: Record<string, unknown>,
  now: Date,
  cache: Map<string, ConfigParam[]>,
): Promise<{ enforce: EnforceItem[]; jobs: AlertJob[]; state: ConfigState | null }> {
  const jobs: AlertJob[] = [];
  const enforce: EnforceItem[] = [];
  const own = parseParams(device.configParams);
  let profileParams = device.profileId ? cache.get(device.profileId) : [];
  if (device.profileId && !profileParams) {
    const p = await db.configProfile.findFirst({
      where: { id: device.profileId, orgId: device.orgId },
    });
    profileParams = parseParams(p?.params);
    cache.set(device.profileId, profileParams);
  }
  const rawState = (isObject(device.configState) ? device.configState : {}) as Record<
    string,
    unknown
  >;
  const push = isObject(rawState.__push)
    ? (rawState.__push as Record<string, string | number | boolean>)
    : null;
  const previous: ConfigState = {};
  for (const [k, v] of Object.entries(rawState))
    if (k !== '__push') previous[k] = v as ConfigState[string];
  if (!device.profileId && own.length === 0 && Object.keys(previous).length === 0 && !push)
    return { enforce, jobs, state: null };

  const params = effectiveParams(profileParams ?? [], own);
  const { applies } = splitApplicable(params, Object.keys(readings));
  const step = stepDrift(applies, previous, readings, now.getTime());
  const monitoring = db as unknown as MonitoringDb;
  const subject = (field: string) => `device:${device.id}:config:${field}`;
  const label = (f: string) => CONFIG_FIELDS[f]?.label ?? f;

  for (const d of step.newlyDrifted) {
    await log(
      db,
      device.orgId,
      device.id,
      { type: 'config_drift', field: d.field, oldValue: d.desired, newValue: d.actual },
      now,
    );
    const inc = await openIncident(
      monitoring,
      {
        orgId: device.orgId,
        roomId: device.roomId,
        kind: 'config_drift',
        subject: subject(d.field),
        severity: 'warning',
        title: `${device.name}: ${label(d.field)} changed`,
        detail: `${device.name} should have ${label(d.field)} ${d.desired} but reads ${d.actual}.`,
      },
      now,
    );
    if (inc) jobs.push(inc);
  }
  for (const ok of step.newlyOk) {
    await log(
      db,
      device.orgId,
      device.id,
      { type: ok.corrected ? 'config_corrected' : 'config_restored', field: ok.field },
      now,
    );
    const r = await resolveIncident(
      monitoring,
      { orgId: device.orgId, kind: 'config_drift', subject: subject(ok.field) },
      now,
    );
    if (r) jobs.push(r);
    await resolveIncident(
      monitoring,
      { orgId: device.orgId, kind: 'config_enforce_failed', subject: subject(ok.field) },
      now,
    );
  }
  for (const f of step.cleared) {
    const r = await resolveIncident(
      monitoring,
      { orgId: device.orgId, kind: 'config_drift', subject: subject(f) },
      now,
    );
    if (r) jobs.push(r);
  }
  for (const g of step.giveUp) {
    const inc = await openIncident(
      monitoring,
      {
        orgId: device.orgId,
        roomId: device.roomId,
        kind: 'config_enforce_failed',
        subject: subject(g.field),
        severity: 'warning',
        title: `${device.name}: ${label(g.field)} could not be put back`,
        detail: `Sent back several times, it still reads ${g.actual} instead of ${g.desired}.`,
      },
      now,
    );
    if (inc) jobs.push(inc);
  }
  for (const e of step.enforce) enforce.push({ deviceId: device.id, command: e.command });

  // A push: send each wanted value the device does not already have, once.
  if (push) {
    for (const [field, value] of Object.entries(push)) {
      if (!(field in readings)) continue;
      if (String(readings[field]).toLowerCase() === String(value).toLowerCase()) continue;
      const command = paramCommand({ field, value, mode: 'once' });
      if (command) enforce.push({ deviceId: device.id, command });
    }
    if (enforce.length > 0 || Object.keys(push).length > 0)
      await log(
        db,
        device.orgId,
        device.id,
        { type: 'config_pushed', data: { fields: Object.keys(push) } },
        now,
      );
  }
  const changed = push !== null || JSON.stringify(step.state) !== JSON.stringify(previous);
  return { enforce, jobs, state: changed ? step.state : null };
}

// ---- Snapshots -----------------------------------------------------------------------------------

/** What a device is known to be like now, from its last report. */
export function snapshotOf(d: DeviceRow): SnapshotData {
  const control = d.control as { kind?: string; driverId?: string; protocol?: string } | null;
  const details = Array.isArray(d.details) ? (d.details as SnapshotData['details']) : [];
  return {
    driver: control?.driverId ?? control?.protocol ?? null,
    firmware: d.firmware ?? null,
    feedback: readingsOf(d),
    details: details.map((s) => ({
      title: String(s.title),
      rows: (s.rows ?? []).map((r) => ({ label: String(r.label), value: String(r.value) })),
    })),
    settings: stripSecrets({
      ...(isObject(d.settings) ? d.settings : {}),
      ...(isObject(d.values) ? d.values : {}),
    }),
  };
}

export const AUTO_SNAPSHOTS_KEPT = 30;

export async function takeSnapshot(
  db: ConfigDb,
  input: {
    orgId: string;
    deviceId: string;
    reason: string;
    note?: string | null;
    userId: string | null;
    baseline?: boolean;
  },
  now = new Date(),
): Promise<Result> {
  const device = await db.device.findFirst({ where: { id: input.deviceId, orgId: input.orgId } });
  if (!device) return bad('No such device');
  if (device.kind !== 'active') return bad('Only a monitored device has a snapshot');
  if (input.baseline)
    await db.deviceSnapshot.updateMany({
      where: { deviceId: device.id, isBaseline: true },
      data: { isBaseline: false },
    });
  const snap = await db.deviceSnapshot.create({
    data: {
      orgId: input.orgId,
      deviceId: device.id,
      reason: input.reason,
      data: snapshotOf(device) as unknown as Prisma.InputJsonValue,
      isBaseline: !!input.baseline,
      note: input.note ?? null,
      takenBy: input.userId,
      takenAt: now,
    },
  });
  await log(
    db,
    input.orgId,
    device.id,
    {
      type: 'snapshot_taken',
      source: input.userId ? 'manual' : 'system',
      actorId: input.userId,
      data: { reason: input.reason, baseline: !!input.baseline },
    },
    now,
  );
  // Scheduled snapshots are trimmed so a device does not collect them for ever.
  if (input.reason === 'scheduled') {
    const auto = await db.deviceSnapshot.findMany({
      where: { deviceId: device.id, reason: 'scheduled', isBaseline: false },
      orderBy: { takenAt: 'desc' },
    });
    for (const old of auto.slice(AUTO_SNAPSHOTS_KEPT))
      await db.deviceSnapshot.delete({ where: { id: old.id } });
  }
  return { ok: true, value: { id: snap.id } };
}

export async function setBaseline(
  db: ConfigDb,
  orgId: string,
  snapshotId: string,
): Promise<Result> {
  const snap = await db.deviceSnapshot.findFirst({ where: { id: snapshotId, orgId } });
  if (!snap) return bad('No such snapshot');
  await db.deviceSnapshot.updateMany({
    where: { deviceId: snap.deviceId, isBaseline: true },
    data: { isBaseline: false },
  });
  await db.deviceSnapshot.update({ where: { id: snap.id }, data: { isBaseline: true } });
  return { ok: true, value: { id: snap.id } };
}

/** Compares two snapshots of a device, or one against how the device is now. */
export async function compareSnapshots(
  db: ConfigDb,
  input: { orgId: string; deviceId: string; from: string; to: string },
): Promise<{ changes: SnapshotChange[] } | null> {
  const device = await db.device.findFirst({ where: { id: input.deviceId, orgId: input.orgId } });
  if (!device) return null;
  const load = async (id: string): Promise<SnapshotData | null> => {
    if (id === 'live') return snapshotOf(device);
    const s = await db.deviceSnapshot.findFirst({
      where: { id, deviceId: device.id, orgId: input.orgId },
    });
    return s ? (s.data as unknown as SnapshotData) : null;
  };
  const a = await load(input.from);
  const b = await load(input.to);
  if (!a || !b) return null;
  return { changes: diffSnapshots(a, b) };
}

/** Devices whose live state differs from their baseline, and by how much. */
export async function baselineDrift(db: ConfigDb, orgId: string, deviceId: string) {
  const baseline = await db.deviceSnapshot.findFirst({
    where: { deviceId, orgId, isBaseline: true },
  });
  const device = await db.device.findFirst({ where: { id: deviceId, orgId } });
  if (!baseline || !device) return null;
  return {
    baselineAt: baseline.takenAt,
    changes: diffSnapshots(baseline.data as unknown as SnapshotData, snapshotOf(device)),
  };
}

// ---- Deploying a profile -------------------------------------------------------------------------

export interface DeployPlanRow {
  deviceId: string;
  name: string;
  applies: ReturnType<typeof planDeploy>;
  notApplicable: string[];
  /** Nothing to change: it already reads what the profile wants. */
  conforming: boolean;
}

/** A dry run: for each device, what the profile would change, and what does not apply to it. */
export async function planProfileDeploy(
  db: ConfigDb,
  input: { orgId: string; profileId: string; deviceIds: string[] },
): Promise<{ profileName: string; rows: DeployPlanRow[] } | null> {
  const profile = await db.configProfile.findFirst({
    where: { id: input.profileId, orgId: input.orgId },
  });
  if (!profile) return null;
  const params = parseParams(profile.params);
  const rows: DeployPlanRow[] = [];
  for (const id of input.deviceIds) {
    const d = await db.device.findFirst({ where: { id, orgId: input.orgId } });
    if (!d || d.kind !== 'active') continue;
    const own = parseParams(d.configParams);
    const { applies, skipped } = splitApplicable(
      effectiveParams(params, own),
      Object.keys(readingsOf(d)),
    );
    const plan = planDeploy(applies, readingsOf(d));
    rows.push({
      deviceId: d.id,
      name: d.name,
      applies: plan,
      notApplicable: skipped.map((p) => p.field),
      conforming: plan.every((p) => !p.willSet),
    });
  }
  return { profileName: profile.name, rows };
}

/** Values to push: everything the profile wants, for the settings the device reports. */
function pushValues(
  d: DeviceRow,
  profileParams: ConfigParam[],
): Record<string, string | number | boolean> {
  const { applies } = splitApplicable(
    effectiveParams(profileParams, parseParams(d.configParams)),
    Object.keys(readingsOf(d)),
  );
  const out: Record<string, string | number | boolean> = {};
  for (const p of applies) out[p.field] = p.value;
  return out;
}

async function applyToDevice(
  db: ConfigDb,
  d: DeviceRow,
  profileId: string,
  profileParams: ConfigParam[],
  actor: string | null,
  now: Date,
) {
  const state = isObject(d.configState) ? { ...d.configState } : {};
  await db.device.update({
    where: { id: d.id },
    data: {
      profileId,
      configState: { ...state, __push: pushValues(d, profileParams) } as Prisma.InputJsonValue,
    },
  });
  await log(
    db,
    d.orgId,
    d.id,
    {
      type: 'profile_assigned',
      newValue: profileId,
      oldValue: d.profileId,
      source: 'manual',
      actorId: actor,
    },
    now,
  );
}

/**
 * Deploys a profile: takes a snapshot of every device first (so it can be rolled back), then, when a
 * canary is asked for, applies it to those devices only and waits for a go-ahead for the rest.
 */
export async function startDeploy(
  db: ConfigDb,
  input: {
    orgId: string;
    profileId: string;
    deviceIds: string[];
    canaryCount: number;
    note?: string | null;
    userId: string | null;
  },
  now = new Date(),
): Promise<Result<{ id: string; stage: string }>> {
  const profile = await db.configProfile.findFirst({
    where: { id: input.profileId, orgId: input.orgId },
  });
  if (!profile) return bad('No such profile');
  const devices: DeviceRow[] = [];
  for (const id of new Set(input.deviceIds)) {
    const d = await db.device.findFirst({ where: { id, orgId: input.orgId } });
    if (d && d.kind === 'active') devices.push(d);
  }
  if (devices.length === 0) return bad('Pick at least one monitored device');
  const params = parseParams(profile.params);
  const snapshots: Record<string, { snapshotId: string; previousProfileId: string | null }> = {};
  for (const d of devices) {
    const snap = await takeSnapshot(
      db,
      { orgId: input.orgId, deviceId: d.id, reason: 'before_deploy', userId: input.userId },
      now,
    );
    if (snap.ok) snapshots[d.id] = { snapshotId: snap.value.id, previousProfileId: d.profileId };
  }
  const canary =
    input.canaryCount > 0 && devices.length > input.canaryCount
      ? devices.slice(0, input.canaryCount)
      : [];
  const first = canary.length ? canary : devices;
  for (const d of first) await applyToDevice(db, d, profile.id, params, input.userId, now);
  const stage = canary.length ? 'canary' : 'done';
  const deploy = await db.configDeploy.create({
    data: {
      orgId: input.orgId,
      profileId: profile.id,
      profileName: profile.name,
      profileVersion: profile.version,
      deviceIds: devices.map((d) => d.id),
      canaryIds: canary.map((d) => d.id),
      stage,
      snapshots: snapshots as unknown as Prisma.InputJsonValue,
      note: input.note ?? null,
      createdBy: input.userId,
    },
  });
  return { ok: true, value: { id: deploy.id, stage } };
}

/** The canary looked fine: apply the profile to the rest. */
export async function continueDeploy(
  db: ConfigDb,
  orgId: string,
  deployId: string,
  userId: string | null,
  now = new Date(),
): Promise<Result> {
  const deploy = await db.configDeploy.findFirst({ where: { id: deployId, orgId } });
  if (!deploy) return bad('No such deploy');
  if (deploy.stage !== 'canary') return bad('This deploy is not waiting for a go-ahead');
  const profile = await db.configProfile.findFirst({ where: { id: deploy.profileId, orgId } });
  if (!profile) return bad('The profile no longer exists');
  const params = parseParams(profile.params);
  for (const id of deploy.deviceIds.filter((x) => !deploy.canaryIds.includes(x))) {
    const d = await db.device.findFirst({ where: { id, orgId } });
    if (d) await applyToDevice(db, d, profile.id, params, userId, now);
  }
  await db.configDeploy.update({ where: { id: deploy.id }, data: { stage: 'done' } });
  return { ok: true, value: { id: deploy.id } };
}

/**
 * Puts every device of a deploy back: its earlier profile (or none) and the settings it had in the
 * snapshot taken before, sent back once.
 */
export async function rollbackDeploy(
  db: ConfigDb,
  orgId: string,
  deployId: string,
  userId: string | null,
  now = new Date(),
): Promise<Result> {
  const deploy = await db.configDeploy.findFirst({ where: { id: deployId, orgId } });
  if (!deploy) return bad('No such deploy');
  if (deploy.stage === 'rolled_back') return bad('This deploy has already been rolled back');
  const snaps = (isObject(deploy.snapshots) ? deploy.snapshots : {}) as Record<
    string,
    { snapshotId: string; previousProfileId: string | null }
  >;
  for (const [deviceId, s] of Object.entries(snaps)) {
    const d = await db.device.findFirst({ where: { id: deviceId, orgId } });
    if (!d || d.profileId !== deploy.profileId) continue;
    const snap = await db.deviceSnapshot.findFirst({ where: { id: s.snapshotId, orgId } });
    const before = (snap?.data as unknown as SnapshotData | undefined)?.feedback ?? {};
    const push: Record<string, string | number | boolean> = {};
    for (const [field, value] of Object.entries(before))
      if (
        field in CONFIG_FIELDS &&
        (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      )
        push[field] = value;
    await db.device.update({
      where: { id: d.id },
      data: {
        profileId: s.previousProfileId,
        configState: { __push: push } as Prisma.InputJsonValue,
      },
    });
    await log(
      db,
      orgId,
      d.id,
      {
        type: 'config_rolled_back',
        oldValue: deploy.profileId,
        newValue: s.previousProfileId,
        source: 'manual',
        actorId: userId,
      },
      now,
    );
  }
  await db.configDeploy.update({ where: { id: deploy.id }, data: { stage: 'rolled_back' } });
  return { ok: true, value: { id: deploy.id } };
}

/** Daily: keeps a scheduled snapshot of every monitored device that has said anything. */
export async function snapshotAll(db: ConfigDb, now = new Date()): Promise<number> {
  const devices = await db.device.findMany({ where: { kind: 'active' } });
  let n = 0;
  for (const d of devices) {
    if (!d.lastSeenAt) continue;
    const r = await takeSnapshot(
      db,
      { orgId: d.orgId, deviceId: d.id, reason: 'scheduled', userId: null },
      now,
    );
    if (r.ok) n++;
  }
  return n;
}
