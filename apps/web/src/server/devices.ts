import { createHash } from 'node:crypto';
import { open, seal, signDeviceSet } from '@kestrel/crypto';
import { Prisma, type PrismaClient } from '@kestrel/db';
import {
  ASSET_FIELDS,
  DEVICE_FEEDBACK_FIELDS,
  DeviceDetails,
  DeviceControl,
  DISCOVERABLE_FIELDS,
  resolveGatewayId,
  identityFromDetails,
  inferFromDriver,
  mergeDiscovered,
  mergeManual,
  type AssetField,
  type DeviceReport,
  type FieldChange,
  type Provenance,
  type SignedDeviceSet,
} from '@kestrel/model';
import {
  DEVICE_GRACE_MS,
  openIncident,
  resolveIncident,
  type AlertJob,
  type MonitoringDb,
} from './monitoring';
import { evaluateConfig, type ConfigDb, type EnforceItem } from './config-service';
import { formatInZone } from '../lib/time';
import { siteTimezone } from './site-zone';
import { applyWatchedPoints, pointValuesPatch, pointsOf, validatePoints } from './device-points';
import { recordLatency, type LatencyDb } from './latency';
import { linkedRoomIds } from './device-sharing';
import { groupOutages, type GroupDb } from './incident-groups';
import type { SigningKey } from './signing';
import { applyAddressReport, checkTrackingInput, withTracking } from './address-tracking';

// v2 devices (docs/pivot-monitoring.md): the cloud's half. Functions take the database as a
// parameter so they can be tested without one, and return alert jobs instead of sending anything.
export type DevicesDb = Pick<
  PrismaClient,
  | 'device'
  | 'deviceEvent'
  | 'deviceHistory'
  | 'configProfile'
  | 'deviceSnapshot'
  | 'configDeploy'
  | 'room'
  | 'gateway'
  | 'incident'
  | 'credentialSet'
  | 'area'
  | 'site'
> &
  Partial<Pick<PrismaClient, 'latencyBucket' | 'deviceRoom'>>;

const secretsKey = () => process.env.KESTREL_SECRETS_KEY || undefined;
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

type DeviceRow = NonNullable<Awaited<ReturnType<DevicesDb['device']['findFirst']>>>;

// ---- History -------------------------------------------------------------------------------------

export interface EventInput {
  type: string;
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  source?: 'discovered' | 'manual' | 'system';
  actorId?: string | null;
  data?: Prisma.InputJsonValue;
}

async function log(db: DevicesDb, orgId: string, deviceId: string, e: EventInput, at: Date) {
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

const asProvenance = (v: unknown): Provenance => (isObject(v) ? (v as Provenance) : {});

/** Applies a field merge to a patch and records what changed. Returns whether a swap needs a decision. */
/** The driver a device's control names, if it uses one. */
function driverIdOf(control: unknown): string | null {
  const c = isObject(control) ? control : null;
  return c && c.kind === 'driver' && typeof c.driverId === 'string' ? c.driverId : null;
}

async function applyField(
  db: DevicesDb,
  row: DeviceRow,
  patch: Record<string, unknown>,
  prov: Provenance,
  field: AssetField,
  merge: (cur: {
    value: string | null;
    provenance: Provenance[AssetField];
  }) => ReturnType<typeof mergeManual>,
  actorId: string | null,
  now: Date,
): Promise<boolean> {
  const current = { value: (patch[field] ?? row[field]) as string | null, provenance: prov[field] };
  const r = merge(current);
  patch[field] = r.value;
  if (r.provenance) prov[field] = r.provenance;
  else delete prov[field];
  const c: FieldChange | undefined = r.change;
  if (!c) return false;
  await log(
    db,
    row.orgId,
    row.id,
    {
      type: 'field_changed',
      field,
      oldValue: c.oldValue,
      newValue: c.newValue,
      source: c.source,
      actorId: c.source === 'manual' ? actorId : null,
    },
    now,
  );
  if (c.possibleSwap) {
    await log(
      db,
      row.orgId,
      row.id,
      { type: 'swap_flagged', field, oldValue: c.oldValue, newValue: c.newValue, source: c.source },
      now,
    );
    return true;
  }
  return false;
}

// ---- Which gateway -------------------------------------------------------------------------------

/**
 * The gateway that polls a device: its own, else its room's, else the site's default (the one the
 * site names, else its oldest gateway).
 */
export async function gatewayIdFor(
  db: DevicesDb,
  d: Pick<DeviceRow, 'gatewayId' | 'roomId' | 'siteId' | 'orgId'>,
) {
  const room = d.roomId
    ? await db.room.findFirst({ where: { id: d.roomId, orgId: d.orgId } })
    : null;
  const siteDefault = async () => {
    const site = await db.site.findFirst({ where: { id: d.siteId, orgId: d.orgId } });
    const named = site?.defaultGatewayId
      ? await db.gateway.findFirst({
          where: { id: site.defaultGatewayId, orgId: d.orgId, siteId: d.siteId },
        })
      : null;
    if (named) return named.id;
    // Not chosen (or the chosen one was removed): the site's oldest gateway.
    return (
      (
        await db.gateway.findMany({
          where: { siteId: d.siteId, orgId: d.orgId },
          orderBy: { createdAt: 'asc' },
        })
      )[0]?.id ?? null
    );
  };
  return resolveGatewayId({
    deviceGatewayId: d.gatewayId,
    roomGatewayId: room?.gatewayId ?? null,
    siteGatewayId: d.gatewayId || room?.gatewayId ? null : await siteDefault(),
  });
}

/** The active devices a gateway should poll. */
export async function devicesForGateway(
  db: DevicesDb,
  gw: { id: string; orgId: string; siteId: string },
) {
  const all = await db.device.findMany({
    where: { orgId: gw.orgId, siteId: gw.siteId, kind: 'active' },
  });
  const out: DeviceRow[] = [];
  for (const d of all) if (d.control && (await gatewayIdFor(db, d)) === gw.id) out.push(d);
  return out;
}

// ---- What a gateway gets -------------------------------------------------------------------------

async function credentialFields(
  db: DevicesDb,
  orgId: string,
  id: string | null,
  key: string | undefined,
) {
  if (!id) return { fields: {} as Record<string, unknown>, updatedAt: 0 };
  const row = await db.credentialSet.findFirst({ where: { id, orgId } });
  if (!row) return { fields: {}, updatedAt: 0 };
  if (!key)
    throw new Error('A device uses a credential set but the server has no KESTREL_SECRETS_KEY');
  const parsed: unknown = JSON.parse(open(row.sealed, key));
  return { fields: isObject(parsed) ? parsed : {}, updatedAt: row.updatedAt.getTime() };
}

/**
 * The devices a gateway polls, with each one's settings, addresses and logins merged (settings,
 * then the credential set, then its own addresses, then its own logins), signed. The version
 * changes when any device or credential set it uses changes.
 */
export async function signedDeviceSetFor(
  db: DevicesDb,
  gw: { id: string; orgId: string; siteId: string },
  signing: SigningKey,
  key = secretsKey(),
): Promise<SignedDeviceSet> {
  const rows = (await devicesForGateway(db, gw)).sort((a, b) => a.id.localeCompare(b.id));
  const devices = [];
  const stamp: string[] = [];
  for (const d of rows) {
    const control = DeviceControl.safeParse(d.control);
    if (!control.success) continue;
    if (d.sealed && !key)
      throw new Error('A device has stored logins but the server has no KESTREL_SECRETS_KEY');
    const set = await credentialFields(db, gw.orgId, d.credentialSetId, key);
    const own = d.sealed ? (JSON.parse(open(d.sealed, key!)) as Record<string, unknown>) : {};
    devices.push({
      id: d.id,
      name: d.name,
      category: d.category,
      control: control.data,
      settings: withTracking(
        {
          ...(isObject(d.settings) ? d.settings : {}),
          ...set.fields,
          ...(isObject(d.values) ? d.values : {}),
          ...own,
        },
        d,
      ),
      points: pointsOf(d.points),
    });
    stamp.push(`${d.id}:${d.version}:${set.updatedAt}`);
  }
  const version = createHash('sha256').update(stamp.join('|')).digest('hex').slice(0, 16);
  return signDeviceSet({ orgId: gw.orgId, gatewayId: gw.id, version, devices }, signing);
}

/** The version a gateway should be running, without opening any logins. */
export async function deviceSetVersion(
  db: DevicesDb,
  gw: { id: string; orgId: string; siteId: string },
) {
  const rows = (await devicesForGateway(db, gw)).sort((a, b) => a.id.localeCompare(b.id));
  const stamp: string[] = [];
  for (const d of rows) {
    if (!d.control) continue;
    const set = d.credentialSetId
      ? await db.credentialSet.findFirst({ where: { id: d.credentialSetId, orgId: gw.orgId } })
      : null;
    stamp.push(`${d.id}:${d.version}:${set?.updatedAt.getTime() ?? 0}`);
  }
  return createHash('sha256').update(stamp.join('|')).digest('hex').slice(0, 16);
}

// ---- What a gateway reports ----------------------------------------------------------------------

/**
 * Applies the devices a gateway reports on its own: live state, feedback and details, the asset
 * fields the device can answer for itself (each merged by `mergeDiscovered`), the history of what
 * changed, and a device_offline incident when one stays silent.
 */
export async function ingestDeviceReports(
  db: DevicesDb,
  gw: { id: string; orgId: string; siteId: string },
  reports: DeviceReport[],
  now: Date,
): Promise<{ jobs: AlertJob[]; enforce: EnforceItem[] }> {
  const jobs: AlertJob[] = [];
  const enforce: EnforceItem[] = [];
  const profileCache = new Map<string, import('@kestrel/model').ConfigParam[]>();
  const add = (j: AlertJob | null) => void (j && jobs.push(j));
  if (reports.length === 0) return { jobs, enforce };
  const mine = new Map((await devicesForGateway(db, gw)).map((d) => [d.id, d]));
  const monitoring = db as unknown as MonitoringDb;
  for (const rep of reports) {
    const row = mine.get(rep.deviceId);
    if (!row) continue;
    const patch: Record<string, unknown> = { lastSeenAt: now };
    let since = row.since ?? now;
    // A confirmed report says how long the device has really been quiet.
    const quietSince =
      !rep.online && rep.confirmed && rep.offlineForMs !== undefined
        ? new Date(now.getTime() - rep.offlineForMs)
        : now;
    if (row.online !== rep.online || !row.since) {
      patch.online = rep.online;
      patch.since = quietSince;
      since = quietSince;
    }
    if (rep.name && rep.name !== row.name && !row.name) patch.name = rep.name;
    if (rep.feedback && JSON.stringify(rep.feedback) !== JSON.stringify(row.feedback ?? null))
      patch.feedback = rep.feedback as Prisma.InputJsonValue;
    const details = rep.details ? DeviceDetails.safeParse(rep.details) : null;
    if (details?.success && JSON.stringify(details.data) !== JSON.stringify(row.details ?? null))
      patch.details = details.data as Prisma.InputJsonValue;
    if (rep.firmware && rep.firmware !== row.firmware) patch.firmwareSince = now;
    // What each control point reads, for the device's page.
    const values = pointValuesPatch(row, rep);
    if (values) patch.pointValues = values as Prisma.InputJsonValue;

    // What the device says about itself fills and refreshes the asset record.
    const prov = asProvenance(row.provenance);
    const seen: Partial<Record<AssetField, string>> = {
      ...(details?.success ? identityFromDetails(details.data) : {}),
      ...(rep.firmware ? { firmware: rep.firmware } : {}),
    };
    // A tracked device the gateway found at a new address: the address it is given moves with it.
    const moved = applyAddressReport(row, rep.address, rep.online, patch, now);
    if (rep.address?.mac && row.addressMode === 'tracked') seen.mac = rep.address.mac;
    const configured = moved
      ? moved.to
      : isObject(row.values)
        ? (row.values.host ?? row.values.address ?? row.values.ip)
        : undefined;
    if (typeof configured === 'string') seen.ip = configured;
    if (moved)
      await log(
        db,
        row.orgId,
        row.id,
        {
          type: 'address_changed',
          field: 'address',
          oldValue: moved.from,
          newValue: moved.to,
          source: 'discovered',
          data: { how: moved.how },
        },
        now,
      );
    let swap = row.swapPending;
    for (const field of DISCOVERABLE_FIELDS) {
      if (!seen[field]) continue;
      const flagged = await applyField(
        db,
        row,
        patch,
        prov,
        field,
        (cur) => mergeDiscovered(field, cur, seen[field], now.toISOString()),
        null,
        now,
      );
      swap = swap || flagged;
    }
    // A make or model nobody has set and the device did not report comes from its driver.
    const implied = inferFromDriver(driverIdOf(row.control));
    for (const f of ['make', 'model'] as const) {
      const have = (patch[f] ?? row[f]) as string | null;
      if (implied[f] && !seen[f] && !(have && have.trim())) {
        patch[f] = implied[f];
        prov[f] = { source: 'discovered', inferred: true, at: now.toISOString() };
      }
    }
    patch.provenance = prov as Prisma.InputJsonValue;
    patch.swapPending = swap;
    // What changed in the device's readings, for usage sessions and its charts.
    const history: { field: string; value: string }[] = [];
    if (patch.online !== undefined) history.push({ field: 'online', value: String(rep.online) });
    const before = (isObject(row.feedback) ? row.feedback : {}) as Record<string, unknown>;
    for (const f of DEVICE_FEEDBACK_FIELDS) {
      const v = rep.feedback?.[f];
      if (v !== undefined && String(v) !== String(before[f]))
        history.push({ field: f, value: String(v) });
    }
    await db.device.update({ where: { id: row.id }, data: patch });
    // How the device answered the gateway's pings since the last heartbeat.
    if (rep.latency && db.latencyBucket)
      await recordLatency(
        db as Pick<LatencyDb, 'latencyBucket'>,
        { id: row.id, orgId: gw.orgId, siteId: row.siteId },
        rep.latency,
        now,
      );

    // Held settings: notice a change, and collect what a gateway should put back.
    const readings = { ...(isObject(row.feedback) ? row.feedback : {}), ...(rep.feedback ?? {}) };
    if (rep.online) {
      const cfg = await evaluateConfig(db as unknown as ConfigDb, row, readings, now, profileCache);
      jobs.push(...cfg.jobs);
      enforce.push(...cfg.enforce);
      if (cfg.state !== null)
        await db.device.update({
          where: { id: row.id },
          data: { configState: cfg.state as unknown as Prisma.InputJsonValue },
        });
    }

    if (history.length > 0)
      await db.deviceHistory.createMany({
        data: history.map((h) => ({
          orgId: gw.orgId,
          deviceId: row.id,
          roomId: row.roomId,
          field: h.field,
          value: h.value,
          at: now,
        })),
      });

    // Watched control points: an incident for each that is out of bounds, resolved when it is fine.
    for (const j of await applyWatchedPoints(db, row, gw, rep, now)) jobs.push(j);

    const subject = `device:${row.id}`;
    // A shared device serves several rooms: one incident, listing every room it affects.
    const alsoRooms = await linkedRoomIds(db, row.orgId, row.id);
    const affected = [...new Set([...(row.roomId ? [row.roomId] : []), ...alsoRooms])];
    const homeRoom = affected[0] ?? null;
    const names = affected.length
      ? (await db.room.findMany({ where: { id: { in: affected } } })).map((r) => r.name)
      : [];
    const roomName = names.length ? names.join(', ') : null;
    if (rep.online)
      add(
        await resolveIncident(
          monitoring,
          { orgId: gw.orgId, kind: 'device_offline', subject },
          now,
        ),
      );
    // The gateway has already waited out a run of quick failed checks when it says `confirmed`.
    else if (rep.confirmed || now.getTime() - since.getTime() >= DEVICE_GRACE_MS)
      add(
        await openIncident(
          monitoring,
          {
            orgId: gw.orgId,
            roomId: homeRoom,
            roomIds: affected.slice(1),
            gatewayId: gw.id,
            kind: 'device_offline',
            subject,
            severity: 'warning',
            title: `${row.name} is offline`,
            detail: `${row.name}${roomName ? ` (${names.length > 1 ? 'affects' : 'in'} ${roomName})` : ''} has not answered since ${formatInZone(since, await siteTimezone(db, row.siteId))}.`,
          },
          now,
        ),
      );
  }
  // Devices that went quiet together on one network are one problem.
  return { jobs: await groupOutages(db as unknown as GroupDb, gw, jobs, now), enforce };
}

/** As `ingestDeviceReports`, for callers that only want the alerts. */
export async function recordDeviceReports(
  db: DevicesDb,
  gw: { id: string; orgId: string; siteId: string },
  reports: DeviceReport[],
  now: Date,
): Promise<AlertJob[]> {
  return (await ingestDeviceReports(db, gw, reports, now)).jobs;
}

// ---- Changes people make -------------------------------------------------------------------------

export interface DeviceInput {
  name?: string;
  category?: string;
  roomId?: string | null;
  gatewayId?: string | null;
  control?: unknown;
  settings?: Record<string, unknown>;
  values?: Record<string, unknown>;
  /** Logins, sealed before storing. Replaces the stored logins when present. */
  secrets?: Record<string, unknown>;
  credentialSetId?: string | null;
  status?: string;
  assetTag?: string | null;
  installedOn?: Date | null;
  warrantyEndsOn?: Date | null;
  endOfLifeOn?: Date | null;
  supplier?: string | null;
  notes?: string | null;
  make?: string | null;
  model?: string | null;
  serial?: string | null;
  mac?: string | null;
  ip?: string | null;
  firmware?: string | null;
  /** fixed (default) or tracked: the gateway finds the device again if its address changes. */
  addressMode?: 'fixed' | 'tracked';
  /** Tracked only: a name the gateway can look up. */
  hostname?: string | null;
}

const PLAIN = [
  'name',
  'category',
  'status',
  'assetTag',
  'installedOn',
  'warrantyEndsOn',
  'endOfLifeOn',
  'supplier',
  'notes',
] as const;

const show = (v: unknown) =>
  v === null || v === undefined
    ? null
    : v instanceof Date
      ? v.toISOString().slice(0, 10)
      : String(v);

export type DeviceResult<T = { id: string }> =
  { ok: true; value: T } | { ok: false; message: string };
const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** A room's site, checked to belong to the organisation. */
async function checkRoom(db: DevicesDb, orgId: string, roomId: string) {
  return db.room.findFirst({ where: { id: roomId, orgId } });
}

async function checkGateway(db: DevicesDb, orgId: string, siteId: string, gatewayId: string) {
  return db.gateway.findFirst({ where: { id: gatewayId, orgId, siteId } });
}

export async function createDevice(
  db: DevicesDb,
  input: {
    orgId: string;
    siteId: string;
    kind: 'active' | 'passive';
    actorId: string | null;
  } & DeviceInput & { name: string; category: string },
  now = new Date(),
): Promise<DeviceResult> {
  const site = await db.site.findFirst({ where: { id: input.siteId, orgId: input.orgId } });
  if (!site) return bad('No such site');
  if (input.roomId) {
    const room = await checkRoom(db, input.orgId, input.roomId);
    if (!room || room.siteId !== input.siteId) return bad('That room is not in this site');
  }
  if (input.gatewayId && !(await checkGateway(db, input.orgId, input.siteId, input.gatewayId)))
    return bad('That gateway is not in this site');
  let control: Prisma.InputJsonValue | undefined;
  if (input.kind === 'active') {
    const parsed = DeviceControl.safeParse(input.control);
    if (!parsed.success) return bad('An active device needs a driver');
    control = parsed.data as Prisma.InputJsonValue;
  }
  const key = secretsKey();
  const hasSecrets = !!input.secrets && Object.keys(input.secrets).length > 0;
  if (hasSecrets && !key) return bad('Storing logins needs KESTREL_SECRETS_KEY on the server');
  const tracking = checkTrackingInput(input, input.addressMode === 'tracked');
  if (!tracking.ok) return bad(tracking.message);
  if (input.addressMode === 'tracked' && input.kind !== 'active')
    return bad('Only a monitored device can have its address tracked.');
  const prov: Provenance = {};
  const data: Record<string, unknown> = {};
  for (const f of ASSET_FIELDS) {
    const v = input[f];
    if (v && v.trim()) {
      data[f] = v.trim();
      prov[f] = {
        source: 'manual',
        at: now.toISOString(),
        ...(input.actorId ? { by: input.actorId } : {}),
      };
    }
  }
  // A tracked device's MAC is kept in one form so the gateway can compare it.
  if (input.addressMode === 'tracked' && typeof tracking.mac === 'string' && tracking.mac)
    data.mac = tracking.mac;
  // What the driver implies (the make, and the model when the driver is for one product) fills
  // whatever was left blank; the device's own report replaces it later.
  const implied = inferFromDriver(driverIdOf(control));
  for (const f of ['make', 'model'] as const)
    if (implied[f] && !data[f]) {
      data[f] = implied[f];
      prov[f] = { source: 'discovered', inferred: true, at: now.toISOString() };
    }
  const created = await db.device.create({
    data: {
      orgId: input.orgId,
      siteId: input.siteId,
      roomId: input.roomId ?? null,
      name: input.name,
      kind: input.kind,
      category: input.category,
      control: control ?? undefined,
      settings: (input.settings ?? {}) as Prisma.InputJsonValue,
      values: (input.values ?? {}) as Prisma.InputJsonValue,
      sealed: hasSecrets ? seal(JSON.stringify(input.secrets), key!) : null,
      credentialSetId: input.credentialSetId ?? null,
      gatewayId: input.kind === 'active' ? (input.gatewayId ?? null) : null,
      addressMode: input.kind === 'active' ? (input.addressMode ?? 'fixed') : 'fixed',
      hostname: input.addressMode === 'tracked' ? (tracking.hostname ?? null) : null,
      status: input.status ?? 'in_service',
      assetTag: input.assetTag ?? null,
      installedOn: input.installedOn ?? null,
      warrantyEndsOn: input.warrantyEndsOn ?? null,
      endOfLifeOn: input.endOfLifeOn ?? null,
      supplier: input.supplier ?? null,
      notes: input.notes ?? null,
      provenance: prov as Prisma.InputJsonValue,
      version: 1,
      swapPending: false,
      retiredIdentities: [],
      ...data,
    },
  });
  await log(
    db,
    input.orgId,
    created.id,
    { type: 'created', newValue: input.name, source: 'manual', actorId: input.actorId },
    now,
  );
  return { ok: true, value: { id: created.id } };
}

/** Edits a device. Asset fields become manual values; moves, gateway and driver changes are recorded. */
export async function updateDevice(
  db: DevicesDb,
  input: { orgId: string; deviceId: string; actorId: string | null; patch: DeviceInput },
  now = new Date(),
): Promise<DeviceResult> {
  const row = await db.device.findFirst({ where: { id: input.deviceId, orgId: input.orgId } });
  if (!row) return bad('No such device');
  const p = { ...input.patch };
  const patch: Record<string, unknown> = {};
  const key = secretsKey();

  for (const f of PLAIN) {
    if (!(f in p) || p[f] === undefined) continue;
    if (show(p[f]) === show(row[f])) continue;
    patch[f] = p[f];
    await log(
      db,
      row.orgId,
      row.id,
      {
        type: f === 'status' ? 'status_changed' : 'field_changed',
        field: f,
        oldValue: show(row[f]),
        newValue: show(p[f]),
        source: 'manual',
        actorId: input.actorId,
      },
      now,
    );
  }
  if ('roomId' in p && p.roomId !== row.roomId) {
    if (p.roomId) {
      const room = await checkRoom(db, row.orgId, p.roomId);
      if (!room || room.siteId !== row.siteId) return bad('That room is not in this site');
    }
    patch.roomId = p.roomId ?? null;
    await log(
      db,
      row.orgId,
      row.id,
      {
        type: 'moved',
        field: 'room',
        oldValue: row.roomId,
        newValue: p.roomId ?? null,
        source: 'manual',
        actorId: input.actorId,
      },
      now,
    );
  }
  if ('gatewayId' in p && p.gatewayId !== row.gatewayId) {
    if (p.gatewayId && !(await checkGateway(db, row.orgId, row.siteId, p.gatewayId)))
      return bad('That gateway is not in this site');
    patch.gatewayId = p.gatewayId ?? null;
    patch.version = row.version + 1;
    await log(
      db,
      row.orgId,
      row.id,
      {
        type: 'gateway_changed',
        oldValue: row.gatewayId,
        newValue: p.gatewayId ?? null,
        source: 'manual',
        actorId: input.actorId,
      },
      now,
    );
  }
  let bump = false;
  if (p.control !== undefined) {
    const parsed = DeviceControl.safeParse(p.control);
    if (!parsed.success) return bad('That driver is not valid');
    if (JSON.stringify(parsed.data) !== JSON.stringify(row.control)) {
      const upgrade = row.kind === 'passive';
      patch.control = parsed.data as Prisma.InputJsonValue;
      if (upgrade) patch.kind = 'active';
      bump = true;
      // Control points the new driver can't read are dropped, with what was read for them.
      const kept = pointsOf(row.points);
      if (kept.length > 0 && validatePoints(parsed.data, kept) !== null) {
        patch.points = [] as unknown as Prisma.InputJsonValue;
        patch.pointValues = Prisma.DbNull;
        await log(
          db,
          row.orgId,
          row.id,
          {
            type: 'field_changed',
            field: 'control points',
            oldValue: `${kept.length}`,
            newValue: '0',
            source: 'manual',
            actorId: input.actorId,
          },
          now,
        );
      }
      await log(
        db,
        row.orgId,
        row.id,
        {
          type: upgrade ? 'upgraded' : 'field_changed',
          field: 'driver',
          newValue: JSON.stringify(parsed.data),
          source: 'manual',
          actorId: input.actorId,
        },
        now,
      );
    }
  }
  for (const f of ['settings', 'values'] as const)
    if (p[f] !== undefined && JSON.stringify(p[f]) !== JSON.stringify(row[f])) {
      patch[f] = p[f] as Prisma.InputJsonValue;
      bump = true;
      await log(
        db,
        row.orgId,
        row.id,
        {
          type: 'field_changed',
          field: f === 'values' ? 'address' : 'settings',
          source: 'manual',
          actorId: input.actorId,
        },
        now,
      );
    }
  const mode = p.addressMode ?? row.addressMode;
  const tracking = checkTrackingInput(p, mode === 'tracked');
  if (!tracking.ok) return bad(tracking.message);
  if (mode === 'tracked' && typeof tracking.mac === 'string' && tracking.mac) p.mac = tracking.mac;
  if (p.addressMode !== undefined && p.addressMode !== row.addressMode) {
    if (p.addressMode === 'tracked' && row.kind !== 'active')
      return bad('Only a monitored device can have its address tracked.');
    patch.addressMode = p.addressMode;
    if (p.addressMode === 'fixed') {
      patch.addressSuggestion = Prisma.DbNull;
      patch.refindAt = null;
    }
    bump = true;
    await log(
      db,
      row.orgId,
      row.id,
      {
        type: 'field_changed',
        field: 'address tracking',
        oldValue: row.addressMode,
        newValue: p.addressMode,
        source: 'manual',
        actorId: input.actorId,
      },
      now,
    );
  }
  if (p.hostname !== undefined && (tracking.hostname ?? null) !== (row.hostname ?? null)) {
    patch.hostname = tracking.hostname ?? null;
    bump = true;
    await log(
      db,
      row.orgId,
      row.id,
      {
        type: 'field_changed',
        field: 'hostname',
        oldValue: row.hostname,
        newValue: tracking.hostname ?? null,
        source: 'manual',
        actorId: input.actorId,
      },
      now,
    );
  }
  // The MAC, serial and name are what a gateway recognises a tracked device by, so a change to any of them goes to it.
  if (
    mode === 'tracked' &&
    ((p.mac !== undefined && p.mac !== row.mac) ||
      (p.serial !== undefined && p.serial !== row.serial) ||
      (p.name !== undefined && p.name !== row.name))
  )
    bump = true;
  if (p.secrets !== undefined) {
    const has = Object.keys(p.secrets).length > 0;
    if (has && !key) return bad('Storing logins needs KESTREL_SECRETS_KEY on the server');
    patch.sealed = has ? seal(JSON.stringify(p.secrets), key!) : null;
    bump = true;
    await log(
      db,
      row.orgId,
      row.id,
      { type: 'field_changed', field: 'login', source: 'manual', actorId: input.actorId },
      now,
    );
  }
  if ('credentialSetId' in p && p.credentialSetId !== row.credentialSetId) {
    patch.credentialSetId = p.credentialSetId ?? null;
    bump = true;
    await log(
      db,
      row.orgId,
      row.id,
      { type: 'field_changed', field: 'credential set', source: 'manual', actorId: input.actorId },
      now,
    );
  }
  if (bump) patch.version = row.version + 1;

  const prov = asProvenance(row.provenance);
  let swap = row.swapPending;
  for (const f of ASSET_FIELDS) {
    if (!(f in p) || p[f] === undefined) continue;
    const flagged = await applyField(
      db,
      row,
      patch,
      prov,
      f,
      (cur) => mergeManual(f, cur, p[f], now.toISOString(), input.actorId ?? undefined),
      input.actorId,
      now,
    );
    swap = swap || flagged;
  }
  patch.provenance = prov as Prisma.InputJsonValue;
  patch.swapPending = swap;
  await db.device.update({ where: { id: row.id }, data: patch });
  return { ok: true, value: { id: row.id } };
}

/**
 * Someone answers "the serial changed": it was a replacement (the old identity is retired with the
 * date) or a correction (a typo, no swap). Either way the notice goes.
 */
export async function resolveSwap(
  db: DevicesDb,
  input: {
    orgId: string;
    deviceId: string;
    outcome: 'replaced' | 'correction';
    actorId: string | null;
    note?: string;
  },
  now = new Date(),
): Promise<DeviceResult> {
  const row = await db.device.findFirst({ where: { id: input.deviceId, orgId: input.orgId } });
  if (!row) return bad('No such device');
  if (!row.swapPending) return bad('Nothing is waiting for a decision on this device');
  const patch: Record<string, unknown> = { swapPending: false };
  if (input.outcome === 'replaced') {
    const flagged = await db.deviceEvent.findMany({
      where: { deviceId: row.id, type: 'swap_flagged' },
      orderBy: { at: 'desc' },
    });
    // The oldest values of each flagged field since the last decision are what was retired.
    const retired: Record<string, string | null> = {};
    for (const e of flagged.reverse())
      if (e.field && !(e.field in retired)) retired[e.field] = e.oldValue;
    const list = Array.isArray(row.retiredIdentities) ? row.retiredIdentities : [];
    patch.retiredIdentities = [
      ...list,
      {
        retiredAt: now.toISOString(),
        fields: retired,
        ...(input.note ? { note: input.note } : {}),
      },
    ] as Prisma.InputJsonValue;
  }
  await db.device.update({ where: { id: row.id }, data: patch });
  await log(
    db,
    row.orgId,
    row.id,
    {
      type: input.outcome === 'replaced' ? 'swap_confirmed' : 'swap_dismissed',
      source: 'manual',
      actorId: input.actorId,
      ...(input.note ? { data: { note: input.note } } : {}),
    },
    now,
  );
  return { ok: true, value: { id: row.id } };
}

export type AlignScope = 'org' | 'site' | 'room';

/**
 * Sets the install, warranty-end and end-of-life dates on every device in a room, a site or the
 * whole organisation, for quick alignment. By default only blanks are filled; `overwrite` replaces
 * dates already recorded. Each change goes through updateDevice, so it is logged like a manual edit.
 */
export async function alignDates(
  db: DevicesDb,
  input: {
    orgId: string;
    scope: AlignScope;
    scopeId: string | null;
    installedOn?: Date | null;
    warrantyEndsOn?: Date | null;
    endOfLifeOn?: Date | null;
    overwrite: boolean;
    actorId: string | null;
  },
  now = new Date(),
): Promise<DeviceResult<{ matched: number; updated: number }>> {
  const where: Record<string, unknown> = { orgId: input.orgId };
  if (input.scope !== 'org') {
    if (!input.scopeId) return bad('Choose where to apply the dates');
    if (input.scope === 'site') {
      if (!(await db.site.findFirst({ where: { id: input.scopeId, orgId: input.orgId } })))
        return bad('No such site');
      where.siteId = input.scopeId;
    } else {
      if (!(await checkRoom(db, input.orgId, input.scopeId))) return bad('No such room');
      where.roomId = input.scopeId;
    }
  }
  const dates = (['installedOn', 'warrantyEndsOn', 'endOfLifeOn'] as const).filter(
    (f) => input[f] instanceof Date,
  );
  if (dates.length === 0) return bad('Enter at least one date');
  const rows = await db.device.findMany({ where });
  let updated = 0;
  for (const row of rows) {
    const patch: DeviceInput = {};
    for (const f of dates)
      if ((input.overwrite || !row[f]) && show(input[f]) !== show(row[f])) patch[f] = input[f];
    if (Object.keys(patch).length === 0) continue;
    const res = await updateDevice(
      db,
      { orgId: input.orgId, deviceId: row.id, actorId: input.actorId, patch },
      now,
    );
    if (res.ok) updated++;
  }
  return { ok: true, value: { matched: rows.length, updated } };
}

export async function deleteDevice(
  db: DevicesDb,
  orgId: string,
  deviceId: string,
): Promise<DeviceResult> {
  const row = await db.device.findFirst({ where: { id: deviceId, orgId } });
  if (!row) return bad('No such device');
  await resolveIncident(
    db as unknown as MonitoringDb,
    { orgId, kind: 'device_offline', subject: `device:${deviceId}` },
    new Date(),
  );
  await db.device.delete({ where: { id: deviceId } });
  return { ok: true, value: { id: deviceId } };
}

// ---- Areas ---------------------------------------------------------------------------------------

export const MAX_AREA_DEPTH = 3;

async function depthOf(db: DevicesDb, orgId: string, parentId: string | null): Promise<number> {
  let depth = 0;
  let cursor = parentId;
  while (cursor && depth <= MAX_AREA_DEPTH) {
    const a = await db.area.findFirst({ where: { id: cursor, orgId } });
    if (!a) break;
    depth++;
    cursor = a.parentId;
  }
  return depth;
}

export async function createArea(
  db: DevicesDb,
  input: {
    orgId: string;
    siteId: string;
    parentId?: string | null;
    name: string;
    label?: string | null;
  },
): Promise<DeviceResult> {
  const site = await db.site.findFirst({ where: { id: input.siteId, orgId: input.orgId } });
  if (!site) return bad('No such site');
  if (input.parentId) {
    const parent = await db.area.findFirst({ where: { id: input.parentId, orgId: input.orgId } });
    if (!parent || parent.siteId !== input.siteId)
      return bad('That parent area is not in this site');
  }
  if ((await depthOf(db, input.orgId, input.parentId ?? null)) >= MAX_AREA_DEPTH)
    return bad(`Areas can nest ${MAX_AREA_DEPTH} levels deep`);
  const clash = await db.area.findFirst({
    where: { siteId: input.siteId, parentId: input.parentId ?? null, name: input.name },
  });
  if (clash) return bad('There is already an area with that name here');
  const a = await db.area.create({
    data: {
      orgId: input.orgId,
      siteId: input.siteId,
      parentId: input.parentId ?? null,
      name: input.name,
      label: input.label ?? null,
    },
  });
  return { ok: true, value: { id: a.id } };
}

export async function updateArea(
  db: DevicesDb,
  input: {
    orgId: string;
    areaId: string;
    name?: string;
    label?: string | null;
    parentId?: string | null;
  },
): Promise<DeviceResult> {
  const a = await db.area.findFirst({ where: { id: input.areaId, orgId: input.orgId } });
  if (!a) return bad('No such area');
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.label !== undefined) data.label = input.label;
  if ('parentId' in input && input.parentId !== a.parentId) {
    if (input.parentId) {
      if (input.parentId === a.id) return bad('An area cannot sit inside itself');
      const parent = await db.area.findFirst({ where: { id: input.parentId, orgId: input.orgId } });
      if (!parent || parent.siteId !== a.siteId) return bad('That parent area is not in this site');
      // No loops: the new parent must not be one of this area's own descendants.
      for (let cur: string | null = parent.parentId; cur;) {
        if (cur === a.id) return bad('An area cannot sit inside its own child');
        cur =
          (await db.area.findFirst({ where: { id: cur, orgId: input.orgId } }))?.parentId ?? null;
      }
    }
    if ((await depthOf(db, input.orgId, input.parentId ?? null)) >= MAX_AREA_DEPTH)
      return bad(`Areas can nest ${MAX_AREA_DEPTH} levels deep`);
    data.parentId = input.parentId ?? null;
  }
  await db.area.update({ where: { id: a.id }, data });
  return { ok: true, value: { id: a.id } };
}

export async function deleteArea(
  db: DevicesDb,
  orgId: string,
  areaId: string,
): Promise<DeviceResult> {
  const a = await db.area.findFirst({ where: { id: areaId, orgId } });
  if (!a) return bad('No such area');
  await db.area.delete({ where: { id: areaId } });
  return { ok: true, value: { id: areaId } };
}
