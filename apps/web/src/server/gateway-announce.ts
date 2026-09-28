import type { PrismaClient } from '@kestrel/db';
import { hashSecret, open, seal, secretMatches } from '@kestrel/crypto';
import { AnnounceRequest, type AnnounceResponse } from '@kestrel/model';
import { newEnrollToken } from './gateway-service';

// Gateways that are running but have no definition in any organisation. They announce themselves
// (unauthenticated by nature: they have no credential yet), staff see them in the staff portal and,
// once they have confirmed with the customer, give them to an organisation and site. The gateway
// then picks up an enrolment token and enrols like any other.
export type AnnounceDb = Pick<PrismaClient, 'unclaimedGateway' | 'gateway' | 'site' | 'auditLog'>;

/** Bounds on an endpoint anyone can reach: how many are held at once, and how many one address adds a day. */
export const MAX_OPEN_UNCLAIMED = 500;
export const MAX_NEW_PER_ADDRESS_PER_DAY = 10;
export const RETRY_UNCLAIMED_S = 60;
export const RETRY_DISMISSED_S = 3600;
const RETRY_CLAIMED_S = 10;
const PRUNE_UNSEEN_MS = 30 * 86_400_000;
const PRUNE_CLAIMED_MS = 7 * 86_400_000;

export type AnnounceResult =
  | { status: 200; body: AnnounceResponse }
  | { status: 400 | 403 | 429 | 503; body: { error: string } };

/** What a gateway that says it is here gets back. Nothing else about the platform is revealed. */
export async function announce(
  db: AnnounceDb,
  raw: unknown,
  ctx: { ip: string | null; key: string | undefined },
  now = new Date(),
): Promise<AnnounceResult> {
  const parsed = AnnounceRequest.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { error: 'Bad announcement' } };
  const a = parsed.data;
  const seen = {
    hostname: a.hostname ?? null,
    os: a.os ?? null,
    version: a.gatewayVersion,
    localAddresses: a.localAddresses,
    publicIp: ctx.ip,
    lastSeenAt: now,
  };

  const row = await db.unclaimedGateway.findFirst({ where: { installId: a.installId } });
  if (!row) {
    const held = await db.unclaimedGateway.count({
      where: { status: { in: ['open', 'dismissed'] } },
    });
    if (held >= MAX_OPEN_UNCLAIMED)
      return { status: 429, body: { error: 'Too many unclaimed gateways' } };
    if (ctx.ip) {
      const fromHere = await db.unclaimedGateway.count({
        where: { publicIp: ctx.ip, firstSeenAt: { gte: new Date(now.getTime() - 86_400_000) } },
      });
      if (fromHere >= MAX_NEW_PER_ADDRESS_PER_DAY)
        return { status: 429, body: { error: 'Too many new gateways from this address' } };
    }
    await db.unclaimedGateway.create({
      data: {
        installId: a.installId,
        secretHash: hashSecret(a.secret),
        status: 'open',
        firstSeenAt: now,
        ...seen,
      },
    });
    return { status: 200, body: { status: 'unclaimed', retrySeconds: RETRY_UNCLAIMED_S } };
  }

  // Someone who only knows the (public) install id must not get a token: the secret proves it.
  if (!secretMatches(a.secret, row.secretHash))
    return { status: 403, body: { error: 'Not recognised' } };
  await db.unclaimedGateway.update({ where: { id: row.id }, data: seen });

  if (row.status === 'dismissed')
    return { status: 200, body: { status: 'dismissed', retrySeconds: RETRY_DISMISSED_S } };
  if (row.status !== 'claimed')
    return { status: 200, body: { status: 'unclaimed', retrySeconds: RETRY_UNCLAIMED_S } };

  // Claimed: hand over the enrolment token until the gateway has used it (a lost reply is retried).
  const gw = row.claimedGatewayId
    ? await db.gateway.findFirst({ where: { id: row.claimedGatewayId } })
    : null;
  const usable =
    gw &&
    !gw.enrolledAt &&
    gw.enrollTokenExpiresAt &&
    gw.enrollTokenExpiresAt.getTime() > now.getTime() &&
    row.claimTokenSealed &&
    ctx.key;
  if (!usable) return { status: 200, body: { status: 'claimed', retrySeconds: 300 } };
  return {
    status: 200,
    body: {
      status: 'claimed',
      enrollToken: open(row.claimTokenSealed!, ctx.key!),
      retrySeconds: RETRY_CLAIMED_S,
    },
  };
}

export class AnnounceError extends Error {}

export type Unclaimed = Awaited<ReturnType<typeof listUnclaimed>>[number];

/** Staff view: everything but the secret hash and the sealed token. */
export async function listUnclaimed(db: Pick<AnnounceDb, 'unclaimedGateway' | 'gateway'>) {
  const rows = await db.unclaimedGateway.findMany({ orderBy: { lastSeenAt: 'desc' }, take: 500 });
  const gateways = rows.some((r) => r.claimedGatewayId)
    ? await db.gateway.findMany({
        where: {
          id: { in: rows.flatMap((r) => (r.claimedGatewayId ? [r.claimedGatewayId] : [])) },
        },
      })
    : [];
  const byId = new Map(gateways.map((g) => [g.id, g]));
  return rows.map((r) => {
    const gw = r.claimedGatewayId ? byId.get(r.claimedGatewayId) : undefined;
    return {
      id: r.id,
      installId: r.installId,
      hostname: r.hostname,
      os: r.os,
      version: r.version,
      localAddresses: r.localAddresses,
      publicIp: r.publicIp,
      status: r.status,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
      claimedAt: r.claimedAt,
      /** For a claimed one: the gateway made from it, and whether it has connected yet. */
      claimed: gw
        ? { gatewayId: gw.id, orgId: gw.orgId, name: gw.name, enrolled: !!gw.enrolledAt }
        : null,
    };
  });
}

/** Gives an unclaimed gateway to an organisation and site as a new, pending gateway. */
export async function claimUnclaimed(
  db: AnnounceDb,
  input: { id: string; orgId: string; siteId: string; name: string; staffUserId: string },
  key: string | undefined,
  now = new Date(),
): Promise<{ gatewayId: string }> {
  if (!key)
    throw new AnnounceError(
      'The server has no KESTREL_SECRETS_KEY, so it cannot hold the enrolment token',
    );
  const row = await db.unclaimedGateway.findFirst({ where: { id: input.id } });
  if (!row) throw new AnnounceError('That gateway is not in the list any more');
  if (row.status === 'claimed') throw new AnnounceError('That gateway has already been claimed');
  const site = await db.site.findFirst({ where: { id: input.siteId, orgId: input.orgId } });
  if (!site) throw new AnnounceError('That site is not in that organisation');
  const name = input.name.trim();
  if (!name) throw new AnnounceError('Give the gateway a name');

  const t = newEnrollToken();
  const gw = await db.gateway.create({
    data: {
      orgId: input.orgId,
      siteId: site.id,
      name,
      enrollTokenHash: t.hash,
      enrollTokenExpiresAt: t.expiresAt,
      hostname: row.hostname,
      os: row.os,
    },
  });
  await db.unclaimedGateway.update({
    where: { id: row.id },
    data: {
      status: 'claimed',
      claimedGatewayId: gw.id,
      claimedBy: input.staffUserId,
      claimedAt: now,
      claimTokenSealed: seal(t.token, key),
    },
  });
  await db.auditLog.create({
    data: {
      orgId: input.orgId,
      actorId: null,
      action: 'gateway.claim',
      target: gw.id,
      meta: { name, hostname: row.hostname, claimedByStaff: input.staffUserId },
    },
  });
  return { gatewayId: gw.id };
}

/** Stops it being listed as needing attention; it announces only hourly from now on. */
export async function dismissUnclaimed(db: Pick<AnnounceDb, 'unclaimedGateway'>, id: string) {
  const { count } = await db.unclaimedGateway.updateMany({
    where: { id, status: 'open' },
    data: { status: 'dismissed' },
  });
  if (count === 0) throw new AnnounceError('That gateway is not waiting to be claimed');
}

export async function reopenUnclaimed(db: Pick<AnnounceDb, 'unclaimedGateway'>, id: string) {
  await db.unclaimedGateway.updateMany({
    where: { id, status: 'dismissed' },
    data: { status: 'open' },
  });
}

/**
 * Takes back a claim that was never used (the token expired, or it was the wrong customer): the
 * pending gateway is removed and the install goes back to waiting. Refuses once it has enrolled.
 */
export async function releaseClaim(db: AnnounceDb, id: string) {
  const row = await db.unclaimedGateway.findFirst({ where: { id } });
  if (!row || row.status !== 'claimed') throw new AnnounceError('That gateway is not claimed');
  const gw = row.claimedGatewayId
    ? await db.gateway.findFirst({ where: { id: row.claimedGatewayId } })
    : null;
  if (gw?.enrolledAt)
    throw new AnnounceError(
      'It has already connected as a gateway of that organisation. Delete it there instead.',
    );
  if (gw) await db.gateway.delete({ where: { id: gw.id } });
  await db.unclaimedGateway.update({
    where: { id },
    data: {
      status: 'open',
      claimedGatewayId: null,
      claimedBy: null,
      claimedAt: null,
      claimTokenSealed: null,
    },
  });
}

export async function deleteUnclaimed(db: Pick<AnnounceDb, 'unclaimedGateway'>, id: string) {
  await db.unclaimedGateway.deleteMany({ where: { id } });
}

/** Rows that have gone quiet: not seen for 30 days, or claimed and finished with for a week. */
export async function pruneUnclaimed(db: Pick<AnnounceDb, 'unclaimedGateway'>, now = new Date()) {
  const quiet = await db.unclaimedGateway.deleteMany({
    where: {
      status: { not: 'claimed' },
      lastSeenAt: { lt: new Date(now.getTime() - PRUNE_UNSEEN_MS) },
    },
  });
  const done = await db.unclaimedGateway.deleteMany({
    where: { status: 'claimed', claimedAt: { lt: new Date(now.getTime() - PRUNE_CLAIMED_MS) } },
  });
  return { unseen: quiet.count, claimed: done.count };
}
