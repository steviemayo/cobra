import { z } from 'zod';
import { db } from '@kestrel/db';
import { orgProcedure, requireRole, router } from '../trpc';

// People from a service provider that looks (or looked) after this organisation, by name and provider.
async function providerLabels(orgId: string, userIds: string[]): Promise<Map<string, string>> {
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

export const auditRouter = router({
  list: orgProcedure
    .input(
      z.object({ orgId: z.string().uuid(), limit: z.number().int().min(1).max(200).default(50) }),
    )
    .query(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const rows = await db.auditLog.findMany({
        where: { orgId: ctx.orgId },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
      });
      const actors = await db.member.findMany({
        where: {
          orgId: ctx.orgId,
          userId: { in: [...new Set(rows.flatMap((r) => (r.actorId ? [r.actorId] : [])))] },
        },
        select: { userId: true, email: true },
      });
      // A staff member acting in an act session is not a member: show them as Kestrel staff.
      const strangers = [...new Set(rows.flatMap((r) => (r.actorId ? [r.actorId] : [])))].filter(
        (id) => !actors.some((a) => a.userId === id),
      );
      const staffIds = new Set(
        (await db.staffUser.findMany({ where: { userId: { in: strangers } } })).map(
          (s) => s.userId,
        ),
      );
      const providers = await providerLabels(
        ctx.orgId,
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
            (staffIds.has(r.actorId)
              ? 'Kestrel staff'
              : (providers.get(r.actorId) ?? 'Former member')))
          : (r.meta as { staff?: boolean } | null)?.staff
            ? 'Kestrel staff'
            : 'System',
      }));
    }),
});
