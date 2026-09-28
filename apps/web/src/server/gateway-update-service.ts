import type { Prisma, PrismaClient } from '@kestrel/db';
import { GatewayUpdateReport, type GatewayUpdateOrder } from '@kestrel/model';
import { bundleDigest, channelRelease, type ChannelRelease } from './gateway-release';
import {
  canSelfUpdate,
  compareVersions,
  planUpdate,
  type Channel,
  type UpdateAction,
} from './gateway-updates';

// Asking a gateway to update, and what a heartbeat does about it. Functions take the database (and
// the release lookup) as parameters so they can be tested without either.
export type UpdateDb = Pick<PrismaClient, 'gateway' | 'auditLog'>;
export type ReleaseLookup = (channel: Channel) => Promise<ChannelRelease | null>;

export type UpdateResult = { ok: true } | { ok: false; error: string };

async function audit(
  db: UpdateDb,
  orgId: string,
  actorId: string | null,
  action: string,
  target: string,
  meta: Record<string, unknown>,
) {
  await db.auditLog.create({
    data: { orgId, actorId, action, target, meta: meta as Prisma.InputJsonValue },
  });
}

/** Asks a gateway to update to what its channel has published, now or from `when`. */
export async function requestUpdate(
  db: UpdateDb,
  input: { orgId: string; gatewayId: string; when: Date | null; userId: string | null },
  lookup: ReleaseLookup = channelRelease,
  now = new Date(),
): Promise<UpdateResult> {
  const gw = await db.gateway.findFirst({ where: { id: input.gatewayId, orgId: input.orgId } });
  if (!gw) return { ok: false, error: 'Gateway not found' };
  if (!gw.enrolledAt) return { ok: false, error: 'This gateway has not connected yet' };
  if (!canSelfUpdate(gw.features))
    return {
      ok: false,
      error: 'This gateway needs one manual update before the portal can update it.',
    };
  const release = await lookup(gw.channel);
  if (!release?.version)
    return { ok: false, error: 'The portal could not read the latest release. Try again shortly.' };
  if (gw.version && compareVersions(gw.version, release.version) >= 0)
    return {
      ok: false,
      error: `This gateway is already on ${gw.version}, the newest on ${gw.channel}.`,
    };
  const notBefore = input.when && input.when.getTime() > now.getTime() ? input.when : now;
  await db.gateway.update({
    where: { id: gw.id },
    data: {
      updateNotBefore: notBefore,
      updateVersion: release.version,
      updateState: null,
      updateError: null,
      updateReportedAt: null,
    },
  });
  await audit(db, gw.orgId, input.userId, 'gateway.update.request', gw.id, {
    name: gw.name,
    from: gw.version,
    to: release.version,
    at: notBefore.toISOString(),
  });
  return { ok: true };
}

export async function cancelUpdate(
  db: UpdateDb,
  input: { orgId: string; gatewayId: string; userId: string | null },
): Promise<UpdateResult> {
  const gw = await db.gateway.findFirst({ where: { id: input.gatewayId, orgId: input.orgId } });
  if (!gw) return { ok: false, error: 'Gateway not found' };
  await db.gateway.update({
    where: { id: gw.id },
    data: {
      updateNotBefore: null,
      updateVersion: null,
      updateState: null,
      updateError: null,
      updateReportedAt: null,
    },
  });
  await audit(db, gw.orgId, input.userId, 'gateway.update.cancel', gw.id, { name: gw.name });
  return { ok: true };
}

export async function setAutoUpdate(
  db: UpdateDb,
  input: { orgId: string; gatewayId: string; on: boolean; userId: string | null },
): Promise<UpdateResult> {
  const gw = await db.gateway.findFirst({ where: { id: input.gatewayId, orgId: input.orgId } });
  if (!gw) return { ok: false, error: 'Gateway not found' };
  await db.gateway.update({ where: { id: gw.id }, data: { autoUpdate: input.on } });
  await audit(db, gw.orgId, input.userId, 'gateway.update.policy', gw.id, {
    name: gw.name,
    automatic: input.on,
  });
  return { ok: true };
}

type GatewayUpdateRow = {
  id: string;
  orgId: string;
  name: string;
  channel: Channel;
  features: string[];
  autoUpdate: boolean;
  updateNotBefore: Date | null;
  updateVersion: string | null;
  updateState: string | null;
  updateReportedAt: Date | null;
};

/**
 * Everything a heartbeat does about updates: note how the gateway says it is getting on, then work
 * out whether to clear the request, make one (Automatic policy), give up on a stalled one, or send
 * the order. Returns the order for the reply, if there is one. `reportedVersion` is the version this
 * heartbeat came from.
 */
export async function updateStep(
  db: UpdateDb,
  gw: GatewayUpdateRow,
  reportedVersion: string,
  rawReport: unknown,
  now: Date,
  lookup: ReleaseLookup = channelRelease,
): Promise<GatewayUpdateOrder | undefined> {
  const report = GatewayUpdateReport.safeParse(rawReport);
  let state = gw.updateState;
  let reportedAt = gw.updateReportedAt;
  if (report.success && gw.updateNotBefore) {
    state = report.data.state;
    reportedAt = now;
    await db.gateway.update({
      where: { id: gw.id },
      data: {
        updateState: report.data.state,
        updateError: report.data.error ?? null,
        updateReportedAt: now,
      },
    });
  }

  const wanted = !!gw.updateNotBefore || (gw.autoUpdate && canSelfUpdate(gw.features));
  // Only look at what is published when something could come of it; most heartbeats need nothing.
  const release = wanted ? await lookup(gw.channel) : null;
  const action: UpdateAction = planUpdate({
    reportedVersion,
    features: gw.features,
    autoUpdate: gw.autoUpdate,
    request: {
      notBefore: gw.updateNotBefore,
      version: gw.updateVersion,
      state,
      reportedAt,
    },
    release,
    now,
  });

  switch (action.kind) {
    case 'clear':
      if (gw.updateNotBefore || gw.updateVersion) {
        await db.gateway.update({
          where: { id: gw.id },
          data: {
            updateNotBefore: null,
            updateVersion: null,
            updateState: null,
            updateError: null,
            updateReportedAt: null,
          },
        });
        await audit(db, gw.orgId, null, 'gateway.update.done', gw.id, {
          name: gw.name,
          version: reportedVersion,
        });
      }
      return undefined;
    case 'request':
      await db.gateway.update({
        where: { id: gw.id },
        data: { updateNotBefore: action.notBefore, updateVersion: action.version },
      });
      await audit(db, gw.orgId, null, 'gateway.update.request', gw.id, {
        name: gw.name,
        to: action.version,
        automatic: true,
      });
      return orderFor(release, action.version);
    case 'fail':
      await db.gateway.update({
        where: { id: gw.id },
        data: { updateState: 'failed', updateError: action.error, updateReportedAt: now },
      });
      return undefined;
    case 'order':
      return orderFor(release, action.version);
    default:
      return undefined;
  }
}

/** The order for the reply: the version and the digest of the bundle to check. No digest, no order. */
function orderFor(release: ChannelRelease | null, version: string): GatewayUpdateOrder | undefined {
  if (!release) return undefined;
  const bundle = bundleDigest(release);
  // A container install updates from its image and has no use for a bundle, so the version alone
  // is a valid order; the gateway decides which it needs and refuses a bundle order without a digest.
  return { version, ...(bundle ? { bundle } : {}) };
}
