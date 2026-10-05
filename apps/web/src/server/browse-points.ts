import type { PrismaClient } from '@kestrel/db';
import { BUILT_IN_DRIVERS, BrowsedPoint, BrowsedPoints, DeviceControl } from '@kestrel/model';
import { writeAudit } from './audit';
import { gatewayIdFor, type DevicesDb } from './devices';
import { effectiveStatus } from './gateway-status';
import { inScope, type SiteScope } from './site-scope';

// Picking a control point from the live device instead of typing its path. The portal asks the
// device's gateway to read the device's own tree and list what could be watched; the answer comes
// back in a later heartbeat and is read here. Nothing is changed on the device.

export type BrowseDb = DevicesDb & Pick<PrismaClient, 'remoteCommand' | 'auditLog'>;

export const MAX_BROWSES_PER_GATEWAY_MINUTE = 6;
/** What a gateway must say it can do before it is sent the command (an older one could not read it). */
export const BROWSE_FEATURE = 'browse-points';

export type BrowseRequest = { ok: true; id: string } | { ok: false; error: string };

export async function requestBrowsePoints(
  db: BrowseDb,
  input: { orgId: string; deviceId: string; siteScope: SiteScope; requestedBy: string | null },
  now = new Date(),
): Promise<BrowseRequest> {
  const device = await db.device.findFirst({ where: { id: input.deviceId, orgId: input.orgId } });
  if (!device || !inScope(input.siteScope, device.siteId))
    return { ok: false, error: 'Device not found' };
  const control = DeviceControl.safeParse(device.control);
  if (device.kind !== 'active' || !control.success || control.data.kind !== 'driver')
    return { ok: false, error: 'This device is not monitored through a driver' };
  if (!BUILT_IN_DRIVERS[control.data.driverId]?.browse)
    return { ok: false, error: 'This device’s driver cannot list what it reports' };

  const gatewayId = await gatewayIdFor(db, device);
  const gateway = gatewayId
    ? await db.gateway.findFirst({ where: { id: gatewayId, orgId: input.orgId } })
    : null;
  if (!gateway) return { ok: false, error: 'This device has no gateway polling it' };
  if (effectiveStatus(gateway, now.getTime()) !== 'online')
    return {
      ok: false,
      error: 'The gateway is offline, so the device cannot be browsed right now',
    };
  if (!gateway.features?.includes(BROWSE_FEATURE))
    return { ok: false, error: 'This gateway needs updating before it can list a device’s points' };

  const recent = await db.remoteCommand.count({
    where: {
      gatewayId: gateway.id,
      type: 'browse_points',
      createdAt: { gte: new Date(now.getTime() - 60_000) },
    },
  });
  if (recent >= MAX_BROWSES_PER_GATEWAY_MINUTE)
    return { ok: false, error: 'Too many requests for this gateway. Try again in a minute' };

  const created = await db.remoteCommand.create({
    data: {
      orgId: input.orgId,
      gatewayId: gateway.id,
      roomId: null,
      type: 'browse_points',
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
      action: 'command.request',
      target: device.id,
      meta: { commandId: created.id, type: 'browse_points', device: device.name },
    },
    db,
  );
  return { ok: true, id: created.id };
}

export interface BrowseResultView {
  status: string;
  /** What the gateway (or the portal) said went wrong, as written. Shown as plain text. */
  error: string | null;
  points: BrowsedPoint[];
  truncated: boolean;
}

/**
 * What a browse found. Null when there is no such request in this organisation (or on a gateway
 * the caller's site scope cannot see). The gateway's answer is read defensively: anything that does
 * not fit is dropped, since it only fills a pick-list that a person checks.
 */
export async function browseResult(
  db: Pick<PrismaClient, 'remoteCommand' | 'gateway'>,
  input: { orgId: string; commandId: string; siteScope: SiteScope },
): Promise<BrowseResultView | null> {
  const cmd = await db.remoteCommand.findFirst({
    where: { id: input.commandId, orgId: input.orgId, type: 'browse_points' },
  });
  if (!cmd) return null;
  const gateway = await db.gateway.findFirst({ where: { id: cmd.gatewayId, orgId: input.orgId } });
  if (!gateway || !inScope(input.siteScope, gateway.siteId)) return null;
  const base = { status: cmd.status, error: cmd.error ?? null };
  if (cmd.status !== 'succeeded') return { ...base, points: [], truncated: false };
  const raw = (cmd.output ?? {}) as { points?: unknown; truncated?: unknown };
  const points = Array.isArray(raw.points)
    ? raw.points.flatMap((p) => {
        const parsed = BrowsedPoint.safeParse(p);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const checked = BrowsedPoints.safeParse({ points, truncated: raw.truncated === true });
  return checked.success
    ? { ...base, points: checked.data.points, truncated: checked.data.truncated }
    : { ...base, points: [], truncated: false };
}
