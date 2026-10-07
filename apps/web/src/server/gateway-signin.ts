import { randomUUID } from 'node:crypto';
import { signDocument } from '@kestrel/crypto';
import type { PrismaClient } from '@kestrel/db';
import { LOCAL_ACCESS_PURPOSE, type LocalAccessGrant, type LocalRole } from '@kestrel/model';
import { writeAudit } from './audit';
import { managedCustomers, type MspDb } from './msp';
import type { SigningKey } from './signing';

/** How long a person has to come back to the gateway with the grant; the gateway also refuses it after this. */
export const GRANT_SECONDS = 120;

export type SigninDb = Pick<PrismaClient, 'gateway' | 'member' | 'org' | 'auditLog'> & MspDb;

export interface SigninRequest {
  gatewayId: string;
  state: string;
  /** Where the browser should be sent back to: the origin the person used to open the gateway. */
  returnOrigin: string;
}

export type SigninCheck =
  | {
      ok: true;
      gateway: { id: string; name: string; orgId: string; orgName: string; siteName: string };
      role: LocalRole;
      returnOrigin: string;
    }
  | { ok: false; reason: 'bad_request' | 'unknown_gateway' | 'not_a_member' | 'bad_return' };

/** What a role in the organisation can do on the gateway's own page: change settings, or only look. */
export function localRoleFor(role: string): LocalRole {
  return role === 'owner' || role === 'dev' ? 'admin' : 'viewer';
}

const STATE = /^[A-Za-z0-9_-]{16,100}$/;

/** The origin of a URL, or null when it is not a plain http(s) address. */
function originOf(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Checks a request to sign in to a gateway's own page, without trusting anything in the link:
 * the person must belong to the gateway's organisation (directly, or through a service provider
 * that covers the gateway's site), and they can only be sent back to an address that gateway has
 * itself reported, so a link made by someone else cannot send a grant to a site of their choosing.
 */
export async function checkSignin(
  db: SigninDb,
  userId: string,
  req: SigninRequest,
): Promise<SigninCheck> {
  if (!STATE.test(req.state) || !/^[0-9a-f-]{36}$/i.test(req.gatewayId))
    return { ok: false, reason: 'bad_request' };
  const returnOrigin = originOf(req.returnOrigin);
  if (!returnOrigin) return { ok: false, reason: 'bad_request' };

  const gw = await db.gateway.findFirst({
    where: { id: req.gatewayId },
    select: {
      id: true,
      name: true,
      orgId: true,
      siteId: true,
      localUrls: true,
      org: { select: { name: true, deletedAt: true } },
      site: { select: { name: true } },
    },
  });
  if (!gw || gw.org.deletedAt) return { ok: false, reason: 'unknown_gateway' };

  // The same message for "no such gateway" and "not yours" would hide which exist; a person who is
  // not a member is told so, because they are signed in and it is the likely mistake.
  let role: string | null = null;
  const own = await db.member.findFirst({
    where: { orgId: gw.orgId, userId },
    select: { role: true },
  });
  if (own) role = own.role;
  else {
    const via = (await managedCustomers(db, userId)).find((c) => c.orgId === gw.orgId);
    if (via && (via.sites === null || via.sites.includes(gw.siteId))) role = via.role;
  }
  if (!role) return { ok: false, reason: 'not_a_member' };

  if (!gw.localUrls.some((u) => originOf(u) === returnOrigin))
    return { ok: false, reason: 'bad_return' };

  return {
    ok: true,
    gateway: { id: gw.id, name: gw.name, orgId: gw.orgId, orgName: gw.org.name, siteName: gw.site.name },
    role: localRoleFor(role),
    returnOrigin,
  };
}

/** Signs the grant for a checked request and says where to send the browser. Audited. */
export async function issueGrant(
  db: SigninDb,
  signing: SigningKey,
  user: { id: string; email: string | null; name: string | null },
  req: SigninRequest,
  now: Date = new Date(),
): Promise<{ ok: true; url: string; role: LocalRole } | Extract<SigninCheck, { ok: false }>> {
  const check = await checkSignin(db, user.id, req);
  if (!check.ok) return check;
  const org = await db.org.findFirst({
    where: { id: check.gateway.orgId },
    select: { gatewayLocalEpoch: true },
  });
  const nowS = Math.floor(now.getTime() / 1000);
  const payload: LocalAccessGrant = {
    id: randomUUID(),
    gatewayId: check.gateway.id,
    orgId: check.gateway.orgId,
    userId: user.id,
    email: user.email ?? user.id,
    name: user.name,
    role: check.role,
    state: req.state,
    issuedAt: nowS,
    expiresAt: nowS + GRANT_SECONDS,
    epoch: org?.gatewayLocalEpoch ?? 0,
  };
  const doc = signDocument(LOCAL_ACCESS_PURPOSE, payload, signing);
  const grant = Buffer.from(JSON.stringify(doc)).toString('base64url');
  await writeAudit(
    {
      orgId: check.gateway.orgId,
      actorId: user.id,
      action: 'gateway.local_signin',
      target: check.gateway.id,
      meta: { role: check.role, origin: check.returnOrigin },
    },
    db,
  );
  return {
    ok: true,
    role: check.role,
    url: `${check.returnOrigin}/auth/callback?grant=${grant}`,
  };
}
