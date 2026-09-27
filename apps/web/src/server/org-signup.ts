import type { Prisma, PrismaClient } from '@kestrel/db';
import {
  JOIN_DECLINE_COOLDOWN_DAYS,
  JOIN_REQUESTS_PER_DAY,
  companyDomain,
  nameSearchTerm,
  sameOrgName,
  trialKeys,
  type OrgRole,
} from '@kestrel/model';

// What happens around creating an organisation: spotting one that already exists, asking its
// owners to add you instead, and giving each person and company one free trial.
// Organisation names are labels, not identities, so a similar name only ever warns; it never blocks.
// Functions take the database as a parameter so they can be tested without one.
export type SignupDb = Pick<
  PrismaClient,
  'org' | 'member' | 'joinRequest' | 'trialClaim' | 'auditLog'
>;

export class SignupError extends Error {}

/** Who is asking. `emailConfirmed` gates every company-domain decision: only a confirmed address counts. */
export interface Person {
  userId: string;
  email: string | null;
  emailConfirmed: boolean;
}

/** The signed-in Supabase user as a Person. */
export const personOf = (user: {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
}): Person => ({
  userId: user.id,
  email: user.email?.toLowerCase() ?? null,
  emailConfirmed: !!user.email_confirmed_at,
});

const DAY = 86_400_000;
const MAX_LISTED = 5;

/** The person's company domain, or null when it is a free mail address or not confirmed. */
const trustedDomain = (p: Person) => (p.emailConfirmed ? companyDomain(p.email) : null);

async function audit(
  db: SignupDb,
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

export interface SimilarOrgs {
  /** Organisations of the same kind whose owners have the person's company domain. */
  colleagues: { id: string; name: string; requested: boolean }[];
  /** Another organisation of the same kind has a very similar name (nothing more is revealed about it). */
  similarName: boolean;
}

/**
 * Before creating an organisation: which existing ones might already be theirs. Colleagues are found
 * by company domain (never a free mail provider, and only for a confirmed address); a similar name
 * alone reveals nothing but that one exists.
 */
export async function findSimilar(
  db: SignupDb,
  args: { name: string; kind: string; person: Person },
): Promise<SimilarOrgs> {
  const mine = new Set(
    (await db.member.findMany({ where: { userId: args.person.userId } })).map((m) => m.orgId),
  );

  const colleagues: SimilarOrgs['colleagues'] = [];
  const domain = trustedDomain(args.person);
  if (domain) {
    const owners = await db.member.findMany({
      where: { role: 'owner', email: { endsWith: `@${domain}`, mode: 'insensitive' } },
    });
    const ids = [...new Set(owners.map((o) => o.orgId))].filter((id) => !mine.has(id));
    if (ids.length > 0) {
      const orgs = await db.org.findMany({
        where: { id: { in: ids }, kind: args.kind },
        orderBy: { createdAt: 'asc' },
        take: MAX_LISTED,
      });
      const pending = new Set(
        (
          await db.joinRequest.findMany({
            where: { userId: args.person.userId, status: 'pending' },
          })
        ).map((r) => r.orgId),
      );
      for (const o of orgs) colleagues.push({ id: o.id, name: o.name, requested: pending.has(o.id) });
    }
  }

  let similarName = false;
  const term = nameSearchTerm(args.name);
  if (term) {
    const candidates = await db.org.findMany({
      where: { kind: args.kind, name: { contains: term, mode: 'insensitive' } },
      take: 50,
    });
    const known = new Set(colleagues.map((c) => c.id));
    similarName = candidates.some(
      (o) => !mine.has(o.id) && !known.has(o.id) && sameOrgName(o.name, args.name),
    );
  }
  return { colleagues, similarName };
}

// ---- Join requests ------------------------------------------------------------------------------

/**
 * Asks an organisation's owners to add the person. Only someone with a confirmed address at the same
 * company domain as one of its owners can ask, so a stranger cannot ping an organisation by guessing
 * its name. Asking twice does nothing new. Returns whether a new request was made (the caller
 * then tells the owners).
 */
export async function requestToJoin(
  db: SignupDb,
  args: { person: Person; orgId: string },
  now = new Date(),
): Promise<{ id: string; created: boolean; orgName: string }> {
  const { person } = args;
  const domain = trustedDomain(person);
  const unavailable = new SignupError('You can’t ask to join that organisation.');
  if (!domain || !person.email) throw unavailable;

  const org = await db.org.findFirst({ where: { id: args.orgId } });
  const owner = org
    ? await db.member.findFirst({
        where: { orgId: org.id, role: 'owner', email: { endsWith: `@${domain}`, mode: 'insensitive' } },
      })
    : null;
  if (!org || !owner) throw unavailable;

  if (await db.member.findFirst({ where: { orgId: org.id, userId: person.userId } }))
    throw new SignupError('You are already a member of that organisation.');

  const pending = await db.joinRequest.findFirst({
    where: { orgId: org.id, userId: person.userId, status: 'pending' },
  });
  if (pending) return { id: pending.id, created: false, orgName: org.name };

  const declined = await db.joinRequest.findFirst({
    where: {
      orgId: org.id,
      userId: person.userId,
      status: 'declined',
      decidedAt: { gte: new Date(now.getTime() - JOIN_DECLINE_COOLDOWN_DAYS * DAY) },
    },
  });
  if (declined)
    throw new SignupError(
      'The owners of that organisation declined your request recently. Ask them to invite you.',
    );

  const today = await db.joinRequest.count({
    where: { userId: person.userId, createdAt: { gte: new Date(now.getTime() - DAY) } },
  });
  if (today >= JOIN_REQUESTS_PER_DAY)
    throw new SignupError('You have sent several requests today. Try again tomorrow.');

  const email = person.email.toLowerCase();
  const request = await db.joinRequest.create({
    data: { orgId: org.id, userId: person.userId, email, createdAt: now },
  });
  await audit(db, org.id, person.userId, 'member.join_request', request.id, { email });
  return { id: request.id, created: true, orgName: org.name };
}

/** The requests waiting for an owner of the organisation, oldest first. */
export async function pendingRequests(db: SignupDb, orgId: string) {
  const rows = await db.joinRequest.findMany({
    where: { orgId, status: 'pending' },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({ id: r.id, email: r.email, createdAt: r.createdAt }));
}

export const pendingRequestCount = (db: SignupDb, orgId: string) =>
  db.joinRequest.count({ where: { orgId, status: 'pending' } });

/** An owner approves (adding the person at the role they choose) or declines a request. */
export async function decideRequest(
  db: SignupDb,
  args: {
    orgId: string;
    requestId: string;
    by: string;
    decision: { approve: true; role: OrgRole } | { approve: false };
  },
  now = new Date(),
): Promise<void> {
  const request = await db.joinRequest.findFirst({
    where: { id: args.requestId, orgId: args.orgId, status: 'pending' },
  });
  if (!request) throw new SignupError('That request is no longer waiting.');

  if (args.decision.approve) {
    const role = args.decision.role;
    if (!(await db.member.findFirst({ where: { orgId: args.orgId, userId: request.userId } })))
      await db.member.create({
        data: { orgId: args.orgId, userId: request.userId, email: request.email, role },
      });
    await db.joinRequest.update({
      where: { id: request.id },
      data: { status: 'approved', role, decidedBy: args.by, decidedAt: now },
    });
    await audit(db, args.orgId, args.by, 'member.join_approve', request.id, {
      email: request.email,
      role,
    });
  } else {
    await db.joinRequest.update({
      where: { id: request.id },
      data: { status: 'declined', decidedBy: args.by, decidedAt: now },
    });
    await audit(db, args.orgId, args.by, 'member.join_decline', request.id, {
      email: request.email,
    });
  }
}

/** The requester withdraws a request that is still waiting. */
export async function cancelRequest(
  db: SignupDb,
  args: { userId: string; requestId: string },
): Promise<void> {
  const { count } = await db.joinRequest.updateMany({
    where: { id: args.requestId, userId: args.userId, status: 'pending' },
    data: { status: 'cancelled' },
  });
  if (count === 0) throw new SignupError('That request is no longer waiting.');
}

/** A person's own requests that still matter: waiting, or declined recently. */
export async function myRequests(db: SignupDb, userId: string, now = new Date()) {
  const rows = await db.joinRequest.findMany({
    where: { userId, status: { in: ['pending', 'declined'] } },
    orderBy: { createdAt: 'desc' },
  });
  const since = now.getTime() - JOIN_DECLINE_COOLDOWN_DAYS * DAY;
  const recent = rows.filter(
    (r) => r.status === 'pending' || (r.decidedAt && r.decidedAt.getTime() >= since),
  );
  const orgs = await db.org.findMany({ where: { id: { in: recent.map((r) => r.orgId) } } });
  const name = new Map(orgs.map((o) => [o.id, o.name]));
  return recent.map((r) => ({
    id: r.id,
    orgName: name.get(r.orgId) ?? 'an organisation',
    status: r.status as 'pending' | 'declined',
    createdAt: r.createdAt,
  }));
}

// ---- Trials -------------------------------------------------------------------------------------

/**
 * Takes the one free trial for this person, mailbox and company domain. False when any of them has
 * already had one (or another sign-up got there first): the organisation then starts without a trial.
 * Only customer organisations use a trial; a service provider has no rooms to try.
 */
export async function claimTrial(db: Pick<SignupDb, 'trialClaim'>, person: Person): Promise<boolean> {
  if (!person.email) return false;
  const keys = trialKeys(person.userId, person.email);
  const or: Record<string, string>[] = [{ userId: keys.userId }];
  if (keys.emailKey) or.push({ emailKey: keys.emailKey });
  if (keys.domainKey) or.push({ domainKey: keys.domainKey });
  if (await db.trialClaim.findFirst({ where: { OR: or } })) return false;
  try {
    await db.trialClaim.create({
      data: { userId: keys.userId, emailKey: keys.emailKey, domainKey: keys.domainKey },
    });
    return true;
  } catch (e) {
    // The unique columns settle a race between two sign-ups: the loser's insert fails.
    if ((e as { code?: string }).code === 'P2002') return false;
    throw e;
  }
}

export const attachTrialClaim = (db: Pick<SignupDb, 'trialClaim'>, userId: string, orgId: string) =>
  db.trialClaim.updateMany({ where: { userId }, data: { orgId } });

/** Gives the trial back when the organisation could not be created after all. */
export const releaseTrialClaim = (db: Pick<SignupDb, 'trialClaim'>, userId: string) =>
  db.trialClaim.deleteMany({ where: { userId, orgId: null } });
