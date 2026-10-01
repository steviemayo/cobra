import type { Prisma, PrismaClient } from '@kestrel/db';
import { StaffRole } from '@kestrel/model';

// Who is Kestrel staff, and browsing what staff have done. Functions take the database (and the
// lookup of accounts by email) as parameters so they can be tested without either.
export type TeamDb = Pick<PrismaClient, 'staffUser' | 'staffAudit' | 'org'>;

export class TeamError extends Error {}

/** Finds a Kestrel account by email. The real one asks Supabase; tests pass a list. */
export interface AccountLookup {
  findByEmail(email: string): Promise<{ id: string; email: string } | null>;
}

export interface TeamMember {
  id: string;
  userId: string;
  email: string | null;
  roles: string[];
  createdAt: Date;
}

export async function listTeam(db: TeamDb): Promise<TeamMember[]> {
  const rows = await db.staffUser.findMany({ orderBy: { createdAt: 'asc' } });
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    email: r.email,
    roles: r.roles,
    createdAt: r.createdAt,
  }));
}

const isAdmin = (roles: readonly string[]) => roles.includes('admin');

/** Someone must always be able to manage the team, so the last admin can not be demoted or removed. */
async function otherAdmins(db: TeamDb, userId: string): Promise<number> {
  const staff = await db.staffUser.findMany({});
  return staff.filter((s) => s.userId !== userId && isAdmin(s.roles)).length;
}

/**
 * Give someone staff access, or change their roles. They must already have a Kestrel account
 * (they sign up like anyone else first).
 */
export async function setStaff(
  db: TeamDb,
  accounts: AccountLookup,
  input: { email: string; roles: string[]; by: string },
): Promise<TeamMember> {
  const email = input.email.trim().toLowerCase();
  const roles = [...new Set(input.roles)];
  if (roles.length === 0) throw new TeamError('Choose at least one role');
  for (const r of roles)
    if (!StaffRole.safeParse(r).success) throw new TeamError(`Unknown role “${r}”`);
  const account = await accounts.findByEmail(email);
  if (!account)
    throw new TeamError('No Kestrel account has that email. They need to sign up first.');

  const existing = await db.staffUser.findFirst({ where: { userId: account.id } });
  const before = existing ? [...existing.roles] : [];
  if (
    existing &&
    isAdmin(existing.roles) &&
    !isAdmin(roles) &&
    (await otherAdmins(db, account.id)) === 0
  )
    throw new TeamError('This is the only admin. Make someone else an admin first.');

  const row = existing
    ? await db.staffUser.update({ where: { id: existing.id }, data: { email, roles } })
    : await db.staffUser.create({
        data: { userId: account.id, email, roles, createdBy: input.by },
      });
  await db.staffAudit.create({
    data: {
      staffUserId: input.by,
      action: existing ? 'staff.set_roles' : 'staff.add',
      meta: { email, roles, before } as Prisma.InputJsonValue,
    },
  });
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    roles: row.roles,
    createdAt: row.createdAt,
  };
}

/** Take away someone's staff access. */
export async function removeStaff(
  db: TeamDb,
  input: { userId: string; by: string },
): Promise<void> {
  const existing = await db.staffUser.findFirst({ where: { userId: input.userId } });
  if (!existing) throw new TeamError('That person is not staff');
  if (isAdmin(existing.roles) && (await otherAdmins(db, input.userId)) === 0)
    throw new TeamError('This is the only admin. Make someone else an admin first.');
  await db.staffUser.delete({ where: { id: existing.id } });
  await db.staffAudit.create({
    data: {
      staffUserId: input.by,
      action: 'staff.remove',
      meta: { email: existing.email, roles: existing.roles } as Prisma.InputJsonValue,
    },
  });
}

// ---- The staff audit trail ----------------------------------------------------------------------

export const AUDIT_PAGE = 50;

export interface StaffAuditFilter {
  staffUserId?: string;
  orgId?: string;
  /** Matches the start of the action, such as "session." */
  action?: string;
  /** Rows older than this (the last row of the previous page). */
  before?: Date;
  limit?: number;
}

export interface StaffAuditRow {
  id: string;
  at: Date;
  action: string;
  staff: string;
  orgId: string | null;
  orgName: string | null;
  target: string | null;
  meta: Record<string, unknown>;
}

/** The staff trail, newest first, with names instead of ids. */
export async function listStaffAudit(
  db: TeamDb,
  filter: StaffAuditFilter = {},
): Promise<{ rows: StaffAuditRow[]; more: boolean }> {
  const limit = Math.min(filter.limit ?? AUDIT_PAGE, 200);
  const found = await db.staffAudit.findMany({
    where: {
      ...(filter.staffUserId ? { staffUserId: filter.staffUserId } : {}),
      ...(filter.orgId ? { orgId: filter.orgId } : {}),
      ...(filter.action ? { action: { startsWith: filter.action } } : {}),
      ...(filter.before ? { createdAt: { lt: filter.before } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
  });
  const page = found.slice(0, limit);
  const [staff, orgs] = await Promise.all([
    db.staffUser.findMany({
      where: { userId: { in: [...new Set(page.map((r) => r.staffUserId))] } },
    }),
    db.org.findMany({
      where: { id: { in: [...new Set(page.flatMap((r) => (r.orgId ? [r.orgId] : [])))] } },
    }),
  ]);
  const email = new Map(staff.map((s) => [s.userId, s.email]));
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  return {
    more: found.length > limit,
    rows: page.map((r) => ({
      id: r.id,
      at: r.createdAt,
      action: r.action,
      staff: email.get(r.staffUserId) ?? 'Former staff',
      orgId: r.orgId,
      orgName: r.orgId ? (orgName.get(r.orgId) ?? 'Deleted organisation') : null,
      target: r.target,
      meta: (r.meta ?? {}) as Record<string, unknown>,
    })),
  };
}

const s = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** What a staff trail row means, in words: "<staff> <this text>". */
export function describeStaffAudit(action: string, meta: Record<string, unknown>): string {
  switch (action) {
    case 'org.view':
      return 'opened the organisation page';
    case 'session.start':
    case 'staff.session.start':
      return `started a support session${meta.mode ? ` (${s(meta.mode)})` : ''}${meta.reason ? `: “${s(meta.reason)}”` : ''}`;
    case 'session.end':
    case 'staff.session.end':
      return 'ended a support session';
    case 'session.act':
      return 'made a change during a support session';
    case 'session.blocked':
      return 'tried to open a support session but the organisation blocks staff access';
    case 'license.set':
    case 'license.adjust':
      return `adjusted the licence${meta.reason ? `: “${s(meta.reason)}”` : ''}`;
    case 'license.revoke':
      return 'removed a licence adjustment';
    case 'note.add':
      return 'added a note';
    case 'org.retention':
      return `changed how long the activity log is kept (${s(meta.from)} to ${s(meta.to)} days)`;
    case 'org.audit_export':
      return `downloaded the activity log (${s(meta.rows)} rows)`;
    case 'org.delete.schedule':
      return `scheduled the organisation for deletion on ${s(meta.deleteAfter).slice(0, 10)}: “${s(meta.reason)}”`;
    case 'org.delete.restore':
      return 'restored the organisation before it was deleted';
    case 'org.delete.purge':
      return `deleted the organisation “${s(meta.name)}” for good`;
    case 'staff.add':
      return `gave ${s(meta.email)} staff access (${Array.isArray(meta.roles) ? meta.roles.join(', ') : ''})`;
    case 'staff.set_roles':
      return `changed the roles of ${s(meta.email)} to ${Array.isArray(meta.roles) ? meta.roles.join(', ') : ''}`;
    case 'staff.remove':
      return `removed ${s(meta.email)} from staff`;
    default:
      return action.replace(/[._]/g, ' ');
  }
}
