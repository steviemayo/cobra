import { open, seal } from '@kestrel/crypto';
import { Prisma, type PrismaClient } from '@kestrel/db';
import { DISCOVERABLE_FIELDS, mergeDiscovered, type Provenance } from '@kestrel/model';
import { openIncident, resolveIncident, type AlertJob, type MonitoringDb } from '../monitoring';
import { getProvider } from './registry';
import { realProviderDeps, type ExternalDevice, type ProviderDeps } from './types';

// Reads one integration and brings Kestrel up to date: devices it already knows (paired by the
// vendor id) get their live state, history and incidents; unpaired ones become new monitored
// rooms and devices only when the integration is set to create them. Nothing here talks to a
// gateway, so a room can be watched with none.
export type IntegrationDb = MonitoringDb &
  Pick<PrismaClient, 'integration' | 'device' | 'deviceHistory' | 'deviceEvent' | 'site'>;

/** An integration is read about this often. The cron job calls more often; this keeps vendor calls modest. */
export const SYNC_EVERY_MS = 2 * 60_000;
/** A vendor that cannot be reached for this long turns its devices to "unknown" instead of leaving old state. */
export const STALE_AFTER_MS = 15 * 60_000;
/** An offline device must stay offline this long before it becomes an incident (vendor clouds lag). */
export const OFFLINE_GRACE_MS = 2 * 60_000;

export interface SyncResult {
  ok: boolean;
  error?: string;
  seen: number;
  updated: number;
  created: number;
  skipped: number;
  jobs: AlertJob[];
}

type Integration = NonNullable<Awaited<ReturnType<IntegrationDb['integration']['findFirst']>>>;
type DeviceRow = NonNullable<Awaited<ReturnType<IntegrationDb['device']['findFirst']>>>;

const FEEDBACK_KEYS = ['inMeeting', 'roomState', 'occupied', 'activeApp', 'power', 'muted'];

export function inScope(i: Pick<Integration, 'siteIds'>, siteId: string): boolean {
  return i.siteIds.length === 0 || i.siteIds.includes(siteId);
}

export function unsealCredentials(
  i: Pick<Integration, 'sealed'>,
  key: string | undefined,
): unknown {
  if (!key)
    throw new Error('This server has no KESTREL_SECRETS_KEY, so integrations cannot sign in');
  return JSON.parse(open(i.sealed, key));
}

/** Reads one integration now. Never throws: a failure is recorded on the integration. */
export async function syncIntegration(
  db: IntegrationDb,
  integration: Integration,
  now: Date,
  deps: ProviderDeps = realProviderDeps(),
  secretsKey = process.env.KESTREL_SECRETS_KEY,
): Promise<SyncResult> {
  const result: SyncResult = { ok: false, seen: 0, updated: 0, created: 0, skipped: 0, jobs: [] };
  const provider = getProvider(integration.provider);
  let found: ExternalDevice[];
  try {
    if (!provider) throw new Error(`Unknown integration type "${integration.provider}"`);
    const creds = provider.credentials.parse(unsealCredentials(integration, secretsKey));
    found = await provider.list(creds, {
      ...deps,
      updateCredentials: async (next) => {
        if (!secretsKey) return;
        await db.integration.update({
          where: { id: integration.id },
          data: { sealed: seal(JSON.stringify(next), secretsKey) },
        });
      },
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : 'The sync failed';
    result.error = error;
    await db.integration.update({
      where: { id: integration.id },
      data: { lastSyncAt: now, lastError: error.slice(0, 500) },
    });
    // Old state is not trusted for long: after a while the vendor's devices show "unknown".
    if (!integration.lastOkAt || now.getTime() - integration.lastOkAt.getTime() > STALE_AFTER_MS)
      await db.device.updateMany({
        where: { integrationId: integration.id, online: { not: null } },
        data: { online: null },
      });
    return result;
  }
  result.seen = found.length;

  const known = new Map(
    (await db.device.findMany({ where: { integrationId: integration.id } })).map((d) => [
      d.externalId,
      d,
    ]),
  );
  for (const ext of found) {
    const row = known.get(ext.externalId);
    if (row) {
      if (!inScope(integration, row.siteId)) {
        result.skipped++;
        continue;
      }
      result.jobs.push(...(await applyReading(db, integration, row, ext, now)));
      result.updated++;
    } else if (integration.autoCreate && integration.defaultSiteId) {
      const created = await createFromExternal(db, integration, ext, now);
      if (created) {
        result.created++;
        result.jobs.push(...(await applyReading(db, integration, created, ext, now)));
      } else result.skipped++;
    } else result.skipped++;
  }

  await db.integration.update({
    where: { id: integration.id },
    data: { lastSyncAt: now, lastOkAt: now, lastError: null },
  });
  result.ok = true;
  return result;
}

async function createFromExternal(
  db: IntegrationDb,
  integration: Integration,
  ext: ExternalDevice,
  now: Date,
): Promise<DeviceRow | null> {
  const siteId = integration.defaultSiteId;
  if (!siteId || !inScope(integration, siteId)) return null;
  const site = await db.site.findFirst({ where: { id: siteId, orgId: integration.orgId } });
  if (!site) return null;
  // A room with the vendor's room name at that site, else a new monitored room.
  const roomName = ext.roomName ?? ext.name;
  let room = await db.room.findFirst({
    where: { orgId: integration.orgId, siteId, name: roomName },
  });
  if (!room)
    room = await db.room.create({
      data: {
        orgId: integration.orgId,
        siteId,
        name: roomName,
        type: 'meeting',
        monitorOnly: true,
      },
    });
  const device = await db.device.create({
    data: {
      orgId: integration.orgId,
      siteId,
      roomId: room.id,
      name: ext.name,
      kind: 'active',
      category: ext.category,
      integrationId: integration.id,
      externalId: ext.externalId,
      status: 'in_service',
      provenance: {},
      version: 1,
    },
  });
  await db.deviceEvent.create({
    data: {
      orgId: integration.orgId,
      deviceId: device.id,
      type: 'created',
      newValue: ext.name,
      source: 'discovered',
      data: { integration: integration.provider },
      at: now,
    },
  });
  return device;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Applies one reading to a paired device: state, history, asset fields, incidents. */
export async function applyReading(
  db: IntegrationDb,
  integration: Integration,
  row: DeviceRow,
  ext: ExternalDevice,
  now: Date,
): Promise<AlertJob[]> {
  const jobs: AlertJob[] = [];
  const patch: Record<string, unknown> = { lastSeenAt: now };
  const history: { field: string; value: string }[] = [];

  if (row.online !== ext.online || !row.since) {
    patch.online = ext.online;
    patch.since = now;
    if (ext.online !== null) history.push({ field: 'online', value: String(ext.online) });
  }
  const feedback = Object.fromEntries(
    Object.entries(ext.feedback ?? {}).filter(([k]) => FEEDBACK_KEYS.includes(k)),
  );
  const before = (row.feedback && typeof row.feedback === 'object' ? row.feedback : {}) as Record<
    string,
    unknown
  >;
  if (Object.keys(feedback).length && !same(feedback, row.feedback))
    patch.feedback = feedback as Prisma.InputJsonValue;
  for (const [k, v] of Object.entries(feedback))
    if (String(v) !== String(before[k])) history.push({ field: k, value: String(v) });

  // What the vendor knows about the box fills and refreshes the asset record (a typed value stays).
  const prov = (
    row.provenance && typeof row.provenance === 'object' ? { ...row.provenance } : {}
  ) as Provenance;
  let swap = row.swapPending;
  const seen: Record<string, string | null | undefined> = {
    model: ext.model,
    serial: ext.serial,
    mac: ext.mac,
    ip: ext.ip,
    firmware: ext.firmware,
  };
  for (const field of DISCOVERABLE_FIELDS) {
    if (!seen[field]) continue;
    const merged = mergeDiscovered(
      field,
      { value: (row[field] as string | null) ?? null, provenance: prov[field] },
      seen[field],
      now.toISOString(),
    );
    if (merged.value !== (row[field] ?? null)) patch[field] = merged.value;
    if (merged.provenance) prov[field] = merged.provenance;
    swap = swap || !!merged.change?.possibleSwap;
  }
  if (!row.make && ext.make) {
    patch.make = ext.make;
    prov.make = { source: 'discovered', at: now.toISOString() };
  }
  if (ext.firmware && ext.firmware !== row.firmware) patch.firmwareSince = now;
  patch.provenance = prov as Prisma.InputJsonValue;
  patch.swapPending = swap;

  await db.device.update({ where: { id: row.id }, data: patch });
  if (history.length)
    await db.deviceHistory.createMany({
      data: history.map((h) => ({
        orgId: row.orgId,
        deviceId: row.id,
        roomId: row.roomId,
        field: h.field,
        value: h.value,
        at: now,
      })),
    });

  const monitoring = db as unknown as MonitoringDb;
  const add = (j: AlertJob | null) => void (j && jobs.push(j));
  const base = { orgId: row.orgId, roomId: row.roomId, siteId: row.siteId };
  const since = (patch.since as Date | undefined) ?? row.since ?? now;

  const offlineKey = {
    orgId: row.orgId,
    kind: 'device_offline' as const,
    subject: `device:${row.id}`,
  };
  if (ext.online === true) add(await resolveIncident(monitoring, offlineKey, now));
  else if (ext.online === false && now.getTime() - since.getTime() >= OFFLINE_GRACE_MS)
    add(
      await openIncident(
        monitoring,
        {
          ...base,
          ...offlineKey,
          severity: 'warning',
          title: `${row.name} is offline`,
          detail: `${integration.name} reports ${row.name} offline.`,
        },
        now,
      ),
    );

  // Faults the vendor lists: one incident per device, replaced by the current list, closed when it empties.
  const faultKey = {
    orgId: row.orgId,
    kind: 'room_fault' as const,
    subject: `integration:${row.id}`,
  };
  const issues = ext.online === false ? [] : (ext.issues ?? []);
  if (issues.length)
    add(
      await openIncident(
        monitoring,
        {
          ...base,
          ...faultKey,
          severity: 'warning',
          title: `${row.name}: ${issues[0]}`,
          detail: issues.join('. '),
        },
        now,
      ),
    );
  else add(await resolveIncident(monitoring, faultKey, now));
  return jobs;
}

/** The cron job: reads every enabled integration that is due. */
export async function syncDue(
  db: IntegrationDb,
  now = new Date(),
  deps?: ProviderDeps,
): Promise<AlertJob[]> {
  const all = await db.integration.findMany({ where: { enabled: true } });
  const jobs: AlertJob[] = [];
  for (const i of all) {
    // A vendor that calls us (a webhook) has nothing to read.
    if (getProvider(i.provider)?.mode === 'push') continue;
    const every = Math.max(SYNC_EVERY_MS, getProvider(i.provider)?.intervalMs ?? 0);
    if (i.lastSyncAt && now.getTime() - i.lastSyncAt.getTime() < every) continue;
    try {
      jobs.push(...(await syncIntegration(db, i, now, deps)).jobs);
    } catch (e) {
      console.error('[integrations] sync failed', i.id, e);
    }
  }
  return jobs;
}
