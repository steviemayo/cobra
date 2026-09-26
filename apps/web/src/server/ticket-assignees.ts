import type { PrismaClient } from '@kestrel/db';
import { effectiveMspRole, grantTakesTickets, type GrantRole, type OrgRole } from '@kestrel/model';

// Who a support request can be assigned to: the organisation's own team, and people from a service
// provider that has an active connection which takes tickets. Assignment stores the person's user
// id, so it works for either. Functions take the database as a parameter so they can be tested
// without one.
export type AssigneeDb = Pick<PrismaClient, 'member' | 'mspGrant' | 'org' | 'room' | 'ticket'>;

export interface Assignee {
  userId: string;
  /** Shown to people: the email, and the provider in brackets for provider staff. */
  label: string;
  /** The provider they belong to, or null for the organisation's own team. */
  provider: string | null;
}

interface Grant {
  mspOrgId: string;
  role: GrantRole;
  /** Empty: the whole organisation. */
  siteIds: string[];
}

async function activeGrants(db: AssigneeDb, orgId: string): Promise<Grant[]> {
  const grants = await db.mspGrant.findMany({ where: { customerOrgId: orgId, status: 'active' } });
  return grants
    .filter((g) => grantTakesTickets(g.role as GrantRole))
    .map((g) => ({ mspOrgId: g.mspOrgId, role: g.role as GrantRole, siteIds: g.siteIds }));
}

/**
 * People a ticket can be assigned to. A provider limited to some sites only appears for a ticket
 * about a room at one of those sites, because that is all they can see.
 */
export async function assigneesFor(
  db: AssigneeDb,
  orgId: string,
  ticket: { roomId: string | null },
): Promise<Assignee[]> {
  const own = (await db.member.findMany({ where: { orgId } })).filter(
    (m) => m.role !== 'customer_viewer',
  );
  const out: Assignee[] = own.map((m) => ({
    userId: m.userId,
    label: m.email ?? 'Team member',
    provider: null,
  }));

  const grants = await activeGrants(db, orgId);
  if (grants.length === 0) return out;
  const siteOf = ticket.roomId
    ? (await db.room.findFirst({ where: { id: ticket.roomId, orgId } }))?.siteId
    : undefined;
  const orgs = await db.org.findMany({ where: { id: { in: grants.map((g) => g.mspOrgId) } } });
  const name = new Map(orgs.map((o) => [o.id, o.name]));

  for (const g of grants) {
    if (g.siteIds.length > 0 && (!siteOf || !g.siteIds.includes(siteOf))) continue;
    for (const m of await db.member.findMany({ where: { orgId: g.mspOrgId } })) {
      if (out.some((a) => a.userId === m.userId)) continue;
      // Their power here is the lower of their own role and what the connection allows.
      if (effectiveMspRole(m.role as OrgRole, g.role) === 'customer_viewer') continue;
      const provider = name.get(g.mspOrgId) ?? 'Service provider';
      out.push({
        userId: m.userId,
        label: `${m.email ?? 'Provider staff'} (${provider})`,
        provider,
      });
    }
  }
  return out;
}

/** The person if this ticket can be assigned to them, otherwise null. */
export async function findAssignee(
  db: AssigneeDb,
  orgId: string,
  ticket: { roomId: string | null },
  userId: string,
): Promise<Assignee | null> {
  return (await assigneesFor(db, orgId, ticket)).find((a) => a.userId === userId) ?? null;
}

/**
 * How to show whoever a ticket is assigned to, including provider staff. Someone who can no longer
 * be assigned (they left, or the connection ended) reads as a former member.
 */
export async function assigneeLabel(
  db: AssigneeDb,
  orgId: string,
  userId: string,
): Promise<string> {
  const own = await db.member.findFirst({ where: { orgId, userId } });
  if (own) return own.email ?? 'Team member';
  for (const g of await activeGrants(db, orgId)) {
    const m = await db.member.findFirst({ where: { orgId: g.mspOrgId, userId } });
    if (m) {
      const provider =
        (await db.org.findFirst({ where: { id: g.mspOrgId } }))?.name ?? 'Service provider';
      return `${m.email ?? 'Provider staff'} (${provider})`;
    }
  }
  return 'Former member';
}

/**
 * Unassigns tickets whose assignee is no longer someone this organisation can assign to: provider
 * staff after their connection ended, or a member who left. Returns how many were cleared.
 */
export async function clearStaleAssignees(db: AssigneeDb, orgId: string): Promise<number> {
  const assigned = await db.ticket.findMany({ where: { orgId } });
  const ids = [...new Set(assigned.flatMap((t) => (t.assignedTo ? [t.assignedTo] : [])))];
  if (ids.length === 0) return 0;
  const own = new Set((await db.member.findMany({ where: { orgId } })).map((m) => m.userId));
  const provider = new Set<string>();
  for (const g of await activeGrants(db, orgId))
    for (const m of await db.member.findMany({ where: { orgId: g.mspOrgId } }))
      provider.add(m.userId);
  const stale = ids.filter((id) => !own.has(id) && !provider.has(id));
  if (stale.length === 0) return 0;
  const { count } = await db.ticket.updateMany({
    where: { orgId, assignedTo: { in: stale } },
    data: { assignedTo: null },
  });
  return count;
}
