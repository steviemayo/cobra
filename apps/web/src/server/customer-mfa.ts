import type { PrismaClient } from '@kestrel/db';
import { writeAudit } from './audit';
import { recordStaffAudit, type StaffDb } from './staff';

// Customer two-step sign-in (LR-15). Anyone may set up an authenticator app. An organisation owner can
// require it for the organisation's owners and developers. Pure rules and database changes live here;
// asking Supabase about someone's factors is in `customer-mfa-admin.ts`, so this can be tested.

/** The roles an organisation can require an authenticator app for. */
export const MFA_ROLES = ['owner', 'dev'] as const;

export type MfaGate = 'ok' | 'challenge' | 'enrol';

/**
 * What a signed-in person must do before using the portal:
 * - with an authenticator app set up, a session that has not yet given a code must give one,
 *   whatever their role (otherwise the app would protect nothing);
 * - without one, an owner or developer of an organisation that requires it must set one up.
 */
export function mfaGate(input: {
  /** Whether the person has a verified authenticator app. */
  hasFactor: boolean;
  /** Whether this session has already given a code. */
  verified: boolean;
  /** Their roles in organisations that require an authenticator app. */
  requiredRoles: string[];
}): MfaGate {
  if (input.hasFactor) return input.verified ? 'ok' : 'challenge';
  return input.requiredRoles.some((r) => (MFA_ROLES as readonly string[]).includes(r))
    ? 'enrol'
    : 'ok';
}

export class MfaError extends Error {}

export type MfaDb = Pick<PrismaClient, 'org' | 'member' | 'auditLog'>;

export interface MfaMemberView {
  userId: string;
  email: string | null;
  role: string;
  /** Whether they have an authenticator app set up. */
  enrolled: boolean;
}

/**
 * Turns the requirement on or off for an organisation. Only an owner may. Turning it on needs the
 * owner to have an authenticator app already, or they would lock themselves out on the next page.
 */
export async function setRequireMfa(
  db: MfaDb,
  args: {
    orgId: string;
    userId: string;
    role: string;
    on: boolean;
    /** Whether the person making the change has a verified authenticator app. */
    actorHasFactor: boolean;
  },
): Promise<void> {
  if (args.role !== 'owner')
    throw new MfaError('Only an owner can change whether two-step sign-in is required.');
  if (args.on && !args.actorHasFactor)
    throw new MfaError(
      'Set up your own authenticator app first, so you are not locked out when this is switched on.',
    );
  const org = await db.org.findFirst({ where: { id: args.orgId } });
  if (!org) throw new MfaError('No such organisation.');
  if (org.requireMfa === args.on) return;
  await db.org.update({ where: { id: args.orgId }, data: { requireMfa: args.on } });
  await writeAudit(
    {
      orgId: args.orgId,
      actorId: args.userId,
      action: args.on ? 'security.mfa_required' : 'security.mfa_optional',
    },
    db,
  );
}

/** The roles a person holds in organisations that require an authenticator app. */
export async function requiredRolesFor(
  db: Pick<PrismaClient, 'member'>,
  userId: string,
): Promise<string[]> {
  const rows = await db.member.findMany({
    where: { userId },
    include: { org: { select: { requireMfa: true } } },
  });
  return rows.filter((m) => m.org.requireMfa).map((m) => m.role);
}

/**
 * Staff clear someone's authenticator apps so they can set a new one up, for a lost phone. Needs a
 * reason, only works on someone who belongs to the organisation, and is recorded on both sides.
 */
export async function resetMfa(
  db: MfaDb & StaffDb,
  effects: { clearFactors(userId: string): Promise<number> },
  args: { orgId: string; userId: string; staffUserId: string; reason: string },
): Promise<{ removed: number }> {
  const reason = args.reason.trim();
  if (reason.length < 5) throw new MfaError('Give a reason of at least 5 characters.');
  if (reason.length > 500) throw new MfaError('Keep the reason under 500 characters.');
  const member = await db.member.findFirst({
    where: { orgId: args.orgId, userId: args.userId },
  });
  if (!member) throw new MfaError('That person is not in this organisation.');
  const removed = await effects.clearFactors(args.userId);
  await writeAudit(
    {
      orgId: args.orgId,
      actorId: null,
      action: 'security.mfa_reset',
      target: args.userId,
      meta: { staff: true, removed },
    },
    db,
  );
  await recordStaffAudit(db, {
    staffUserId: args.staffUserId,
    action: 'security.mfa_reset',
    orgId: args.orgId,
    meta: { userId: args.userId, reason, removed },
  });
  return { removed };
}
