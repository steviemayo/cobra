import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { writeAudit } from '../audit';
import { combinationProblem } from '../combinations';
import { queueCombine } from '../control-service';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const combinationId = z.string().uuid();
const Body = z.object({
  name: z.string().trim().min(1).max(80),
  primaryRoomId: z.string().uuid(),
  secondaryRoomIds: z.array(z.string().uuid()).min(1).max(10),
  secondaryVideo: z.enum(['follow', 'blank']).default('follow'),
  secondaryAudio: z.enum(['follow', 'blank']).default('follow'),
});

async function find(ctxOrgId: string, id: string) {
  const c = await db.roomCombination.findFirst({ where: { id, orgId: ctxOrgId } });
  if (!c) throw new TRPCError({ code: 'NOT_FOUND', message: 'Combination not found' });
  return c;
}

export const combinationRouter = router({
  list: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    const [combos, rooms] = await Promise.all([
      db.roomCombination.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: 'asc' } }),
      db.room.findMany({
        where: { orgId: ctx.orgId },
        select: { id: true, name: true, gatewayId: true },
      }),
    ]);
    const name = new Map(rooms.map((r) => [r.id, r.name]));
    return combos.map((c) => ({
      id: c.id,
      name: c.name,
      primaryRoomId: c.primaryRoomId,
      primaryName: name.get(c.primaryRoomId) ?? 'Deleted room',
      secondaryRoomIds: c.secondaryRoomIds,
      secondaryNames: c.secondaryRoomIds.map((id) => name.get(id) ?? 'Deleted room'),
      secondaryVideo: c.secondaryVideo,
      secondaryAudio: c.secondaryAudio,
      combined: c.combined,
    }));
  }),

  create: orgProcedure.input(Body.extend({ orgId })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const problem = await combinationProblem(db, ctx.orgId, input);
    if (problem) throw new TRPCError({ code: 'BAD_REQUEST', message: problem });
    const c = await db.roomCombination.create({
      data: {
        orgId: ctx.orgId,
        name: input.name,
        primaryRoomId: input.primaryRoomId,
        secondaryRoomIds: input.secondaryRoomIds,
        secondaryVideo: input.secondaryVideo,
        secondaryAudio: input.secondaryAudio,
      },
    });
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'combination.create',
      target: c.id,
      meta: { name: c.name },
    });
    return { id: c.id };
  }),

  update: orgProcedure
    .input(Body.extend({ orgId, combinationId }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const existing = await find(ctx.orgId, input.combinationId);
      const problem = await combinationProblem(db, ctx.orgId, input, existing.id);
      if (problem) throw new TRPCError({ code: 'BAD_REQUEST', message: problem });
      await db.roomCombination.update({
        where: { id: existing.id },
        data: {
          name: input.name,
          primaryRoomId: input.primaryRoomId,
          secondaryRoomIds: input.secondaryRoomIds,
          secondaryVideo: input.secondaryVideo,
          secondaryAudio: input.secondaryAudio,
        },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'combination.update',
        target: existing.id,
        meta: { name: input.name },
      });
      return { ok: true };
    }),

  delete: orgProcedure
    .input(z.object({ orgId, combinationId }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const c = await find(ctx.orgId, input.combinationId);
      await db.roomCombination.delete({ where: { id: c.id } });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'combination.delete',
        target: c.id,
        meta: { name: c.name },
      });
      return { ok: true };
    }),

  // Join or split. The gateway does it and confirms in its next heartbeat.
  setCombined: orgProcedure
    .input(z.object({ orgId, combinationId, combined: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const res = await queueCombine(db, {
        orgId: ctx.orgId,
        combinationId: input.combinationId,
        combined: input.combined,
        by: ctx.user.id,
      });
      if (!res.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: res.error });
      return { ok: true };
    }),
});
