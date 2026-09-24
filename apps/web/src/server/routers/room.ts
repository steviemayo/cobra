import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { RoomType } from '@kestrel/model';
import { writeAudit } from '../audit';
import { summariseDraft } from '../room-summary';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const roomId = z.string().uuid();
const name = z.string().trim().min(1).max(100);

async function assertSite(ctxOrgId: string, siteId: string) {
  const site = await db.site.findFirst({ where: { id: siteId, orgId: ctxOrgId } });
  if (!site) throw new TRPCError({ code: 'NOT_FOUND', message: 'Site not found' });
  return site;
}

export const roomRouter = router({
  list: orgProcedure
    .input(z.object({ orgId }))
    .query(({ ctx }) =>
      db.room.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: 'asc' } }),
    ),

  get: orgProcedure.input(z.object({ orgId, roomId })).query(async ({ ctx, input }) => {
    const room = await db.room.findFirst({
      where: { id: input.roomId, orgId: ctx.orgId },
      include: {
        site: { select: { id: true, name: true } },
        gateway: { select: { id: true, name: true, status: true } },
      },
    });
    if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
    return room;
  }),

  // Rooms with their site, gateway and a summary of the design draft, for lists and dashboards.
  overview: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    const rooms = await db.room.findMany({
      where: { orgId: ctx.orgId },
      orderBy: [{ createdAt: 'asc' }],
      include: {
        site: { select: { id: true, name: true } },
        gateway: { select: { id: true, name: true, status: true } },
        draft: { select: { revision: true, updatedAt: true, model: true } },
      },
    });
    return rooms.map(({ draft, ...room }) => ({
      ...room,
      draft: draft ? summariseDraft(draft) : null,
    }));
  }),

  create: orgProcedure
    .input(z.object({ orgId, siteId: z.string().uuid(), name, type: RoomType }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const site = await assertSite(ctx.orgId, input.siteId);
      const room = await db.room.create({
        data: { orgId: ctx.orgId, siteId: site.id, name: input.name, type: input.type },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'room.create',
        target: room.id,
        meta: { name: room.name, site: site.name, type: room.type },
      });
      return room;
    }),

  update: orgProcedure
    .input(z.object({ orgId, roomId, name: name.optional(), siteId: z.string().uuid().optional() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const room = await db.room.findFirst({ where: { id: input.roomId, orgId: ctx.orgId } });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
      const site = input.siteId ? await assertSite(ctx.orgId, input.siteId) : null;
      const updated = await db.room.update({
        where: { id: room.id },
        data: { name: input.name ?? room.name, ...(site && { siteId: site.id }) },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'room.update',
        target: room.id,
        meta: { name: updated.name, ...(site && { site: site.name }) },
      });
      return updated;
    }),

  delete: orgProcedure.input(z.object({ orgId, roomId })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const room = await db.room.findFirst({ where: { id: input.roomId, orgId: ctx.orgId } });
    if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
    await db.room.delete({ where: { id: room.id } });
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'room.delete',
      target: room.id,
      meta: { name: room.name },
    });
    return { ok: true };
  }),
});
