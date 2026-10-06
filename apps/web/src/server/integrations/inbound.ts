import { secretMatches } from '@kestrel/crypto';
import { openIncident, resolveIncident, type AlertJob, type MonitoringDb } from '../monitoring';
import { inScope, type IntegrationDb } from './sync';
import { parseTeamsEvents, type TeamsEvent } from './teams';
import { getProvider } from './registry';

// What happens when a vendor calls Kestrel (push integrations): check the secret, find the device
// the event is about, and turn it into device state or an incident. The same rules as a pull sync:
// paired devices only, unless the integration creates rooms.

export type InboundResult =
  | { ok: true; handled: number; ignored: number; jobs: AlertJob[] }
  | { ok: false; status: 401 | 404 | 400; message: string };

type Integration = NonNullable<Awaited<ReturnType<IntegrationDb['integration']['findFirst']>>>;
type DeviceRow = NonNullable<Awaited<ReturnType<IntegrationDb['device']['findFirst']>>>;

/** The device an event is about: paired by Microsoft's device id, room account or hostname. */
async function findDevice(
  db: IntegrationDb,
  integration: Integration,
  keys: string[],
): Promise<DeviceRow | null> {
  for (const key of keys) {
    const hit = await db.device.findFirst({
      where: { integrationId: integration.id, externalId: key },
    });
    if (hit) return hit;
  }
  return null;
}

async function createDevice(
  db: IntegrationDb,
  integration: Integration,
  key: string,
  name: string,
  now: Date,
): Promise<DeviceRow | null> {
  const siteId = integration.defaultSiteId;
  if (!integration.autoCreate || !siteId || !inScope(integration, siteId)) return null;
  if (!(await db.site.findFirst({ where: { id: siteId, orgId: integration.orgId } }))) return null;
  const room =
    (await db.room.findFirst({ where: { orgId: integration.orgId, siteId, name } })) ??
    (await db.room.create({
      data: { orgId: integration.orgId, siteId, name, type: 'meeting', monitorOnly: true },
    }));
  const device = await db.device.create({
    data: {
      orgId: integration.orgId,
      siteId,
      roomId: room.id,
      name,
      kind: 'active',
      category: 'conference_system',
      make: 'Microsoft',
      model: 'Teams Rooms',
      integrationId: integration.id,
      externalId: key,
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
      newValue: name,
      source: 'discovered',
      data: { integration: integration.provider },
      at: now,
    },
  });
  return device;
}

async function applyTeamsEvent(
  db: IntegrationDb,
  integration: Integration,
  ev: TeamsEvent,
  now: Date,
): Promise<{ handled: boolean; jobs: AlertJob[] }> {
  const keys = ev.kind === 'incident' ? ev.keys : [ev.key];
  let device = await findDevice(db, integration, keys);
  // Closing something we never opened is nothing to do; opening for an unpaired room needs autoCreate.
  if (!device && (ev.kind === 'state' || ev.open) && keys[0])
    device = await createDevice(db, integration, keys[0], ev.name, now);
  if (!device || !inScope(integration, device.siteId)) return { handled: false, jobs: [] };

  const monitoring = db as unknown as MonitoringDb;
  const jobs: AlertJob[] = [];
  const add = (j: AlertJob | null) => void (j && jobs.push(j));
  const base = { orgId: device.orgId, roomId: device.roomId, siteId: device.siteId };

  if (ev.kind === 'state') {
    const changed = device.online !== ev.online;
    await db.device.update({
      where: { id: device.id },
      data: { lastSeenAt: now, ...(changed ? { online: ev.online, since: now } : {}) },
    });
    if (changed)
      await db.deviceHistory.createMany({
        data: [
          {
            orgId: device.orgId,
            deviceId: device.id,
            roomId: device.roomId,
            field: 'online',
            value: String(ev.online),
            at: now,
          },
        ],
      });
    const key = {
      orgId: device.orgId,
      kind: 'device_offline' as const,
      subject: `device:${device.id}`,
    };
    if (ev.online) add(await resolveIncident(monitoring, key, now));
    else
      add(
        await openIncident(
          monitoring,
          {
            ...base,
            ...key,
            severity: 'warning',
            title: `${device.name} is offline`,
            detail: `${integration.name} reports ${device.name} offline.`,
          },
          now,
        ),
      );
    return { handled: true, jobs };
  }

  // A device that sends us an incident is plainly in touch with Microsoft.
  await db.device.update({
    where: { id: device.id },
    data: {
      lastSeenAt: now,
      ...(device.online === null ? { online: true, since: now } : {}),
    },
  });
  const key = {
    orgId: device.orgId,
    kind: 'room_fault' as const,
    subject: `teams:${ev.incidentId}:${device.id}`,
  };
  if (ev.open)
    add(
      await openIncident(
        monitoring,
        {
          ...base,
          ...key,
          severity: ev.severity,
          title: `${device.name}: ${ev.signal}`,
          detail: ev.description,
        },
        now,
      ),
    );
  else add(await resolveIncident(monitoring, key, now));
  return { handled: true, jobs };
}

/** Handles one webhook call for an integration. The secret is the credential; one leak reaches one integration. */
export async function handleInbound(
  db: IntegrationDb,
  input: { integrationId: string; secret: string; body: unknown },
  now = new Date(),
): Promise<InboundResult> {
  const integration = await db.integration.findFirst({ where: { id: input.integrationId } });
  // The same answer for "no such integration" and "wrong secret": nothing to probe.
  if (
    !integration ||
    !integration.enabled ||
    !integration.inboundHash ||
    !secretMatches(input.secret, integration.inboundHash)
  )
    return { ok: false, status: 401, message: 'Not allowed' };
  const provider = getProvider(integration.provider);
  if (provider?.mode !== 'push')
    return { ok: false, status: 404, message: 'This connection does not take calls' };
  const events = parseTeamsEvents(input.body);
  let handled = 0;
  const jobs: AlertJob[] = [];
  for (const ev of events) {
    const r = await applyTeamsEvent(db, integration, ev, now);
    if (r.handled) handled++;
    jobs.push(...r.jobs);
  }
  await db.integration.update({
    where: { id: integration.id },
    data: { lastSyncAt: now, lastOkAt: now, lastError: null },
  });
  return { ok: true, handled, ignored: events.length - handled, jobs };
}
