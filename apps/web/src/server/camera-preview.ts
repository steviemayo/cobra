import type { PrismaClient } from '@kestrel/db';
import { BUILT_IN_DRIVERS, DeviceControl } from '@kestrel/model';
import { writeAudit } from './audit';
import { gatewayIdFor, type DevicesDb } from './devices';
import { effectiveStatus } from './gateway-status';
import { inScope, type SiteScope } from './site-scope';

// A live picture from a camera. The portal asks the camera's gateway for one still; the gateway takes
// it and sends it back in its next heartbeat; the portal shows it. The picture is held only so the
// browser can fetch it, handed over once, and then wiped. It is never written to a file, a log or the
// audit trail. A picture can show people, so it is off for an organisation until an owner turns it on,
// it is limited to owners, developers and support, and each request is audited.

export type PreviewDb = DevicesDb & Pick<PrismaClient, 'remoteCommand' | 'auditLog' | 'org'>;

export const MAX_SNAPSHOTS_PER_GATEWAY_MINUTE = 6;
/** What a gateway must say it can do before it is sent the command (an older one could not read it). */
export const SNAPSHOT_FEATURE = 'snapshot';
/** A request still waiting or running this long after it was asked for no longer blocks a new one. */
export const SNAPSHOT_IN_FLIGHT_MS = 2 * 60_000;
/** A picture nobody fetched in this long is wiped. */
export const SNAPSHOT_KEEP_MS = 2 * 60_000;
/** Base64 characters: about 1.5 MB of picture. The gateway refuses larger, so this only guards the cloud. */
const MAX_BASE64 = 2_200_000;

export type PreviewRequest = { ok: true; id: string } | { ok: false; error: string };

/** Whether an organisation has turned camera previews on. */
export async function previewEnabled(db: Pick<PrismaClient, 'org'>, orgId: string): Promise<boolean> {
  const org = await db.org.findFirst({ where: { id: orgId }, select: { cameraPreview: true } });
  return org?.cameraPreview === true;
}

/** Whether a device's driver can give a picture. */
export function canPreview(control: unknown): boolean {
  const c = DeviceControl.safeParse(control);
  return (
    c.success &&
    c.data.kind === 'driver' &&
    (BUILT_IN_DRIVERS[c.data.driverId]?.features ?? []).includes('snapshot')
  );
}

export async function requestSnapshot(
  db: PreviewDb,
  input: { orgId: string; deviceId: string; siteScope: SiteScope; requestedBy: string | null },
  now = new Date(),
): Promise<PreviewRequest> {
  if (!(await previewEnabled(db, input.orgId)))
    return { ok: false, error: 'Camera previews are switched off for this organisation. An owner can turn them on in Settings.' };
  const device = await db.device.findFirst({ where: { id: input.deviceId, orgId: input.orgId } });
  if (!device || !inScope(input.siteScope, device.siteId))
    return { ok: false, error: 'Device not found' };
  if (device.kind !== 'active' || !canPreview(device.control))
    return { ok: false, error: 'This device cannot give a picture' };

  const gatewayId = await gatewayIdFor(db, device);
  const gateway = gatewayId
    ? await db.gateway.findFirst({ where: { id: gatewayId, orgId: input.orgId } })
    : null;
  if (!gateway) return { ok: false, error: 'This device has no gateway polling it' };
  if (effectiveStatus(gateway, now.getTime()) !== 'online')
    return { ok: false, error: 'The gateway is offline, so the camera cannot be reached right now' };
  if (!gateway.features?.includes(SNAPSHOT_FEATURE))
    return { ok: false, error: 'This gateway needs updating before it can take a picture' };

  // Old pictures nobody fetched go first, so nothing lingers.
  await purgeSnapshots(db, now);

  const inFlight = await db.remoteCommand.findMany({
    where: {
      gatewayId: gateway.id,
      type: 'snapshot',
      status: { in: ['pending', 'sent'] },
      createdAt: { gte: new Date(now.getTime() - SNAPSHOT_IN_FLIGHT_MS) },
    },
  });
  if (inFlight.some((c) => (c.args as { deviceId?: string } | null)?.deviceId === device.id))
    return { ok: false, error: 'A picture is already on its way from this camera' };
  const recent = await db.remoteCommand.count({
    where: {
      gatewayId: gateway.id,
      type: 'snapshot',
      createdAt: { gte: new Date(now.getTime() - 60_000) },
    },
  });
  if (recent >= MAX_SNAPSHOTS_PER_GATEWAY_MINUTE)
    return { ok: false, error: 'Too many pictures requested from this gateway. Try again in a minute' };

  const created = await db.remoteCommand.create({
    data: {
      orgId: input.orgId,
      gatewayId: gateway.id,
      roomId: null,
      type: 'snapshot',
      args: { deviceId: device.id },
      status: 'pending',
      requestedBy: input.requestedBy,
      createdAt: now,
    },
  });
  await writeAudit(
    {
      orgId: input.orgId,
      actorId: input.requestedBy,
      action: 'camera.preview',
      target: device.id,
      meta: { commandId: created.id, device: device.name },
    },
    db,
  );
  return { ok: true, id: created.id };
}

export type PreviewView =
  | { status: 'waiting' }
  | { status: 'ready'; contentType: 'image/jpeg'; data: string; takenAt: Date }
  | { status: 'failed'; error: string }
  /** Already shown once, or not fetched in time. The picture is gone. */
  | { status: 'gone' };

/**
 * The picture, once. The first successful read hands it over and wipes it; any later read, or one
 * after it expired, says it is gone. Only the person who asked can read it. Null when there is no
 * such request for the caller.
 */
export async function snapshotResult(
  db: Pick<PrismaClient, 'remoteCommand' | 'gateway'>,
  input: { orgId: string; commandId: string; siteScope: SiteScope; requestedBy: string | null },
  now = new Date(),
): Promise<PreviewView | null> {
  const cmd = await db.remoteCommand.findFirst({
    where: { id: input.commandId, orgId: input.orgId, type: 'snapshot' },
  });
  if (!cmd || (cmd.requestedBy ?? null) !== input.requestedBy) return null;
  const gateway = await db.gateway.findFirst({ where: { id: cmd.gatewayId, orgId: input.orgId } });
  if (!gateway || !inScope(input.siteScope, gateway.siteId)) return null;

  if (cmd.status === 'pending' || cmd.status === 'sent') return { status: 'waiting' };
  if (cmd.status === 'failed' || cmd.status === 'expired')
    return { status: 'failed', error: cmd.error ?? 'The camera did not give a picture' };
  if (cmd.status !== 'succeeded') return { status: 'gone' };

  const raw = (cmd.output ?? {}) as { contentType?: unknown; data?: unknown };
  const data = typeof raw.data === 'string' ? raw.data : '';
  // Take it before reading it out: of two reads racing, only one gets the picture.
  const { count } = await db.remoteCommand.updateMany({
    where: { id: cmd.id, status: 'succeeded' },
    data: { status: 'delivered', output: {} },
  });
  if (count === 0) return { status: 'gone' };
  if (
    raw.contentType !== 'image/jpeg' ||
    data.length === 0 ||
    data.length > MAX_BASE64 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data) ||
    // A JPEG starts FF D8, which is "/9j/" in base64.
    !data.startsWith('/9j/')
  )
    return { status: 'failed', error: 'The camera did not send a usable picture' };
  return { status: 'ready', contentType: 'image/jpeg', data, takenAt: cmd.finishedAt ?? now };
}

/** Wipes pictures nobody fetched. Cheap, and run whenever a picture is asked for and on the periodic sweep. */
export async function purgeSnapshots(
  db: Pick<PrismaClient, 'remoteCommand'>,
  now = new Date(),
): Promise<void> {
  await db.remoteCommand.updateMany({
    where: {
      type: 'snapshot',
      status: 'succeeded',
      finishedAt: { lt: new Date(now.getTime() - SNAPSHOT_KEEP_MS) },
    },
    data: { status: 'discarded', output: {} },
  });
}
