import { z } from 'zod';
import { db } from '@kestrel/db';
import { orgProcedure, requireRole, router } from '../trpc';

export const siteRouter = router({
  list: orgProcedure
    .input(z.object({ orgId: z.string().uuid() }))
    .query(({ ctx }) =>
      db.site.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: 'asc' } }),
    ),
  create: orgProcedure
    .input(z.object({ orgId: z.string().uuid(), name: z.string().trim().min(1).max(100) }))
    .mutation(({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      return db.site.create({ data: { orgId: ctx.orgId, name: input.name } });
    }),
});
