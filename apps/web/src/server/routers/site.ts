import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { writeAudit } from '../audit';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const name = z.string().trim().min(1).max(100);
const timezone = z
  .string()
  .trim()
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown timezone');

async function findSite(ctxOrgId: string, siteId: string) {
  const site = await db.site.findFirst({ where: { id: siteId, orgId: ctxOrgId } });
  if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'Site not found' });
  return site;
}

export const siteRouter = router({
  list: orgProcedure.input(z.object({ orgId })).query(({ ctx }) =>
    db.site.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { rooms: true, gateways: true } } },
    }),
  ),

  get: orgProcedure
    .input(z.object({ orgId, siteId: z.string().uuid() }))
    .query(({ ctx, input }) => findSite(ctx.orgId, input.siteId)),

  create: orgProcedure
    .input(z.object({ orgId, name, timezone: timezone.optional() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const site = await db.site.create({
        data: {
          orgId: ctx.orgId,
          name: input.name,
          ...(input.timezone && { timezone: input.timezone }),
        },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'site.create',
        target: site.id,
        meta: { name: site.name },
      });
      return site;
    }),

  update: orgProcedure
    .input(
      z.object({
        orgId,
        siteId: z.string().uuid(),
        name: name.optional(),
        timezone: timezone.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const site = await findSite(ctx.orgId, input.siteId);
      const updated = await db.site.update({
        where: { id: site.id },
        data: { name: input.name ?? site.name, timezone: input.timezone ?? site.timezone },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'site.update',
        target: site.id,
        meta: { name: updated.name, timezone: updated.timezone },
      });
      return updated;
    }),

  delete: orgProcedure
    .input(z.object({ orgId, siteId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const site = await findSite(ctx.orgId, input.siteId);
      const [rooms, gateways] = await Promise.all([
        db.room.count({ where: { siteId: site.id, orgId: ctx.orgId } }),
        db.gateway.count({ where: { siteId: site.id, orgId: ctx.orgId } }),
      ]);
      if (rooms > 0 || gateways > 0)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Move or delete this site’s rooms and gateways first',
        });
      await db.site.delete({ where: { id: site.id } });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'site.delete',
        target: site.id,
        meta: { name: site.name },
      });
      return { ok: true };
    }),
});
