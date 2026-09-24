import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { RoomType } from '@kestrel/model';
import { orgProcedure, requireRole, router } from '../trpc';

export const roomRouter = router({
  list: orgProcedure
    .input(z.object({ orgId: z.string().uuid() }))
    .query(({ ctx }) =>
      db.room.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: 'asc' } }),
    ),
  create: orgProcedure
    .input(
      z.object({
        orgId: z.string().uuid(),
        siteId: z.string().uuid(),
        name: z.string().trim().min(1).max(100),
        type: RoomType,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const site = await db.site.findFirst({ where: { id: input.siteId, orgId: ctx.orgId } });
      if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'Site not found' });
      return db.room.create({
        data: { orgId: ctx.orgId, siteId: site.id, name: input.name, type: input.type },
      });
    }),
});
