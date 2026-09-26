import type { PrismaClient } from '@kestrel/db';

// Turning stored activity log rows into what people read: who did it, by name or role. Shared by the
// activity log page and the export. Functions take the database as a parameter so they can be tested
// without one.
export type AuditViewDb = Pick<PrismaClient, 'member' | 'staffUser' | 'mspGrant' | 'org'>;

export interface AuditRow {
  id: string;
  action: string;
  target: string | null;
  meta: unknown;
  createdAt: Date;
  actorId: string | null;
}

export interface AuditView {
  id: string;
  action: string;
  target: string | null;
  meta: Record<string, unknown>;
  createdAt: Date;
  actor: string;
}

// People from a service provider that looks (or looked) after this organisation, by name and provider.
async function providerLabels(
  db: AuditViewDb,
  orgId: string,
  userIds: string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const grants = await db.mspGrant.findMany({
    where: { customerOrgId: orgId, status: { in: ['active', 'ended'] } },
  });
  const providerIds = [...new Set(grants.map((g) => g.mspOrgId))];
  if (providerIds.length === 0) return new Map();
  const [members, orgs] = await Promise.all([
    db.member.findMany({ where: { userId: { in: userIds }, orgId: { in: providerIds } } }),
    db.org.findMany({ where: { id: { in: providerIds } } }),
  ]);
  const name = new Map(orgs.map((o) => [o.id, o.name]));
  return new Map(
    members.map((m) => [
      m.userId,
      `${m.email ?? 'Provider staff'} (${name.get(m.orgId) ?? 'provider'})`,
    ]),
  );
}

export async function viewAuditRows(
  db: AuditViewDb,
  orgId: string,
  rows: AuditRow[],
): Promise<AuditView[]> {
  const actorIds = [...new Set(rows.flatMap((r) => (r.actorId ? [r.actorId] : [])))];
  const actors = actorIds.length
    ? await db.member.findMany({
        where: { orgId, userId: { in: actorIds } },
        select: { userId: true, email: true },
      })
    : [];
  // A staff member acting in an act session is not a member: show them as Kestrel staff.
  const strangers = actorIds.filter((id) => !actors.some((a) => a.userId === id));
  const staffIds = new Set(
    strangers.length
      ? (await db.staffUser.findMany({ where: { userId: { in: strangers } } })).map((s) => s.userId)
      : [],
  );
  const providers = await providerLabels(
    db,
    orgId,
    strangers.filter((id) => !staffIds.has(id)),
  );
  const emailById = new Map(actors.map((a) => [a.userId, a.email]));
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    target: r.target,
    meta: (r.meta ?? {}) as Record<string, unknown>,
    createdAt: r.createdAt,
    actor: r.actorId
      ? (emailById.get(r.actorId) ??
        (staffIds.has(r.actorId) ? 'Kestrel staff' : (providers.get(r.actorId) ?? 'Former member')))
      : (r.meta as { staff?: boolean } | null)?.staff
        ? 'Kestrel staff'
        : 'System',
  }));
}
