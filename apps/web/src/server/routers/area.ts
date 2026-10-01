import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { writeAudit } from '../audit';
import { createArea, deleteArea, updateArea } from '../devices';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const id = z.string().uuid();
const name = z.string().trim().min(1).max(80);
const label = z.string().trim().max(40).nullable().optional();

function fail(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

// Areas: how a customer groups the rooms of a site (a building, a level, a wing).
export const areaRouter = router({
  list: orgProcedure.input(z.object({ orgId, siteId: id.optional() })).query(({ ctx, input }) =>
    db.area.findMany({
      where: { orgId: ctx.orgId, ...(input.siteId ? { siteId: input.siteId } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
  ),

  create: orgProcedure
    .input(z.object({ orgId, siteId: id, parentId: id.nullable().optional(), name, label }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const res = await createArea(db, { ...input, orgId: ctx.orgId });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'area.create',
        target: res.value.id,
        meta: { name: input.name },
      });
      return res.value;
    }),

  update: orgProcedure
    .input(
      z.object({
        orgId,
        areaId: id,
        name: name.optional(),
        label,
        parentId: id.nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const res = await updateArea(db, { ...input, orgId: ctx.orgId });
      if (!res.ok) return fail(res.message);
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'area.update',
        target: input.areaId,
      });
      return res.value;
    }),

  delete: orgProcedure.input(z.object({ orgId, areaId: id })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const res = await deleteArea(db, ctx.orgId, input.areaId);
    if (!res.ok) return fail(res.message);
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'area.delete',
      target: input.areaId,
    });
    return res.value;
  }),

  /** Puts a room in an area (or takes it out) and sets its tags. The area must be in the room's site. */
  placeRoom: orgProcedure
    .input(
      z.object({
        orgId,
        roomId: id,
        areaId: id.nullable().optional(),
        tags: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const room = await db.room.findFirst({ where: { id: input.roomId, orgId: ctx.orgId } });
      if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such room' });
      const data: { areaId?: string | null; tags?: string[] } = {};
      if ('areaId' in input) {
        if (input.areaId) {
          const area = await db.area.findFirst({ where: { id: input.areaId, orgId: ctx.orgId } });
          if (!area || area.siteId !== room.siteId)
            return fail("That area is not in the room's site");
        }
        data.areaId = input.areaId ?? null;
      }
      if (input.tags) data.tags = [...new Set(input.tags)];
      await db.room.update({ where: { id: room.id }, data });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'room.place',
        target: room.id,
      });
      return { id: room.id };
    }),
});
