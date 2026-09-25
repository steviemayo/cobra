import { z } from 'zod';
import { db } from '@kestrel/db';
import { orgProcedure, requireRole, router } from '../trpc';

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
      const emailById = new Map(actors.map((a) => [a.userId, a.email]));
      return rows.map((r) => ({
        id: r.id,
        action: r.action,
        target: r.target,
        meta: (r.meta ?? {}) as Record<string, unknown>,
        createdAt: r.createdAt,
        actor: r.actorId
          ? (emailById.get(r.actorId) ??
            (staffIds.has(r.actorId) ? 'Kestrel staff' : 'Former member'))
          : (r.meta as { staff?: boolean } | null)?.staff
            ? 'Kestrel staff'
            : 'System',
      }));
    }),
});
