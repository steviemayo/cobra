import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@kestrel/db';
import type { OrgRole } from '@kestrel/model';
import { writeAudit } from './audit';

// A service provider adding people to a customer's team after the customer exists (PA-1 to PA-8).
// Only a provider's owner, only while the customer's owner has allowed it on the connection, and
// only for roles that leave the customer's owners in control: support and viewer always, owner or
// developer only when the customer has none.

export class ProviderMemberError extends Error {}

export type ProviderMembersDb = Pick<
  PrismaClient,
  'org' | 'member' | 'invite' | 'mspGrant' | 'auditLog'
>;

const INVITE_DAYS = 7;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** The roles a provider may hand out, given what the customer already has. */
export function rolesProviderMayGive(have: { hasOwner: boolean; hasDev: boolean }): OrgRole[] {
  const roles: OrgRole[] = ['customer_viewer', 'support'];
  if (!have.hasDev) roles.push('dev');
  if (!have.hasOwner) roles.push('owner');
  return roles;
}

export interface AddContext {
  /** Why the provider cannot add people, or null when it can. */
  blocked: string | null;
  roles: OrgRole[];
  mspName: string | null;
}

const OFF =
  'This customer has not allowed your organisation to add people to its team. Ask one of its owners to turn it on for your connection.';

/**
 * Whether this person, acting for a provider, may add people to the customer, and with which roles.
 * Checked every time, never cached: the connection, the permission and the provider role can all change.
 */
export async function addContext(
  db: ProviderMembersDb,
  args: { mspOrgId: string; customerOrgId: string; userId: string; now?: Date },
): Promise<AddContext> {
  const now = args.now ?? new Date();
  const none = (blocked: string): AddContext => ({ blocked, roles: [], mspName: null });
  const msp = await db.org.findFirst({ where: { id: args.mspOrgId, kind: 'msp' } });
  if (!msp) return none('Only a service provider can add people this way.');
  const me = await db.member.findFirst({ where: { orgId: args.mspOrgId, userId: args.userId } });
  if (!me || me.role !== 'owner')
    return none('Only an owner of your organisation can add people to a customer.');
  const grant = await db.mspGrant.findFirst({
    where: { mspOrgId: args.mspOrgId, customerOrgId: args.customerOrgId, status: 'active' },
  });
  if (!grant || (grant.endsAt && grant.endsAt.getTime() <= now.getTime()))
    return none('Your organisation is not connected to this customer.');
  if (grant.role !== 'manage' || grant.siteIds.length > 0)
    return none(
      'Adding people needs the Manage connection for the whole organisation, not just some sites.',
    );
  if (!grant.mayAddPeople) return none(OFF);
  const [hasOwner, hasDev] = await Promise.all([
    db.member.findFirst({ where: { orgId: args.customerOrgId, role: 'owner' } }),
    db.member.findFirst({ where: { orgId: args.customerOrgId, role: 'dev' } }),
  ]);
  return {
    blocked: null,
    roles: rolesProviderMayGive({ hasOwner: !!hasOwner, hasDev: !!hasDev }),
    mspName: msp.name,
  };
}

/** Sends an invitation on the provider's behalf. The link is returned once; only its hash is kept. */
export async function inviteViaProvider(
  db: ProviderMembersDb,
  args: {
    mspOrgId: string;
    customerOrgId: string;
    userId: string;
    email: string;
    role: OrgRole;
    now?: Date;
  },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const now = args.now ?? new Date();
  const ctx = await addContext(db, args);
  if (ctx.blocked) throw new ProviderMemberError(ctx.blocked);
  if (!ctx.roles.includes(args.role))
    throw new ProviderMemberError(
      args.role === 'owner' || args.role === 'dev'
        ? `This customer already has ${args.role === 'owner' ? 'an owner' : 'a developer'}, so only its owners can add another.`
        : 'That role cannot be given.',
    );
  const email = args.email.trim().toLowerCase();
  if (await db.member.findFirst({ where: { orgId: args.customerOrgId, email } }))
    throw new ProviderMemberError('That person is already a member.');
  // A new invitation replaces any still-open one for the same address.
  await db.invite.updateMany({
    where: { orgId: args.customerOrgId, email, acceptedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });
  const token = randomBytes(24).toString('base64url');
  const invite = await db.invite.create({
    data: {
      orgId: args.customerOrgId,
      email,
      role: args.role,
      tokenHash: hashToken(token),
      invitedBy: args.userId,
      viaMspOrgId: args.mspOrgId,
      expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000),
    },
  });
  const meta = { email, role: args.role, provider: ctx.mspName };
  // The customer's owners see this in their activity, with the provider named.
  await writeAudit(
    {
      orgId: args.customerOrgId,
      actorId: null,
      action: 'invite.create_by_provider',
      target: invite.id,
      meta,
    },
    db,
  );
  await writeAudit(
    {
      orgId: args.mspOrgId,
      actorId: args.userId,
      action: 'invite.create_for_customer',
      target: args.customerOrgId,
      meta,
    },
    db,
  );
  return { id: invite.id, token, expiresAt: invite.expiresAt };
}

/** A provider withdraws an invitation it sent that has not been accepted. */
export async function revokeViaProvider(
  db: ProviderMembersDb,
  args: { mspOrgId: string; customerOrgId: string; userId: string; inviteId: string; now?: Date },
): Promise<void> {
  const ctx = await addContext(db, args);
  if (ctx.blocked) throw new ProviderMemberError(ctx.blocked);
  const { count } = await db.invite.updateMany({
    where: {
      id: args.inviteId,
      orgId: args.customerOrgId,
      viaMspOrgId: args.mspOrgId,
      acceptedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: args.now ?? new Date() },
  });
  if (count === 0) throw new ProviderMemberError('Invitation not found.');
  await writeAudit(
    {
      orgId: args.customerOrgId,
      actorId: null,
      action: 'invite.revoke_by_provider',
      target: args.inviteId,
      meta: { provider: ctx.mspName },
    },
    db,
  );
}

export interface ProviderAddedView {
  members: { id: string; email: string | null; role: string; createdAt: Date }[];
  pending: { id: string; email: string; role: string; createdAt: Date; expired: boolean }[];
}

/** The people this provider added to the customer, and its invitations still waiting. */
export async function addedByProvider(
  db: ProviderMembersDb,
  mspOrgId: string,
  customerOrgId: string,
  now = new Date(),
): Promise<ProviderAddedView> {
  const [members, invites] = await Promise.all([
    db.member.findMany({
      where: { orgId: customerOrgId, addedByMspOrgId: mspOrgId },
      orderBy: { createdAt: 'asc' },
    }),
    db.invite.findMany({
      where: { orgId: customerOrgId, viaMspOrgId: mspOrgId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return {
    members: members.map((m) => ({
      id: m.id,
      email: m.email,
      role: m.role,
      createdAt: m.createdAt,
    })),
    pending: invites.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      createdAt: i.createdAt,
      expired: i.expiresAt.getTime() < now.getTime(),
    })),
  };
}

/** The customer's owner allows or stops its provider adding people. Audited on both sides. */
export async function setMayAddPeople(
  db: ProviderMembersDb,
  args: { customerOrgId: string; grantId: string; userId: string; on: boolean },
): Promise<void> {
  const grant = await db.mspGrant.findFirst({
    where: {
      id: args.grantId,
      customerOrgId: args.customerOrgId,
      status: { in: ['pending', 'active'] },
    },
  });
  if (!grant) throw new ProviderMemberError('That connection was not found.');
  if (grant.mayAddPeople === args.on) return;
  if (args.on && (grant.role !== 'manage' || grant.siteIds.length > 0))
    throw new ProviderMemberError(
      'Adding people needs the Manage connection for the whole organisation.',
    );
  await db.mspGrant.update({ where: { id: grant.id }, data: { mayAddPeople: args.on } });
  const action = args.on ? 'msp.add_people_allowed' : 'msp.add_people_stopped';
  await writeAudit(
    { orgId: args.customerOrgId, actorId: args.userId, action, target: grant.mspOrgId },
    db,
  );
  await writeAudit(
    { orgId: grant.mspOrgId, actorId: null, action, target: args.customerOrgId },
    db,
  );
}
