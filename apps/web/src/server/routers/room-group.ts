import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { writeAudit } from '../audit';
import {
  GroupError,
  deleteGroup,
  groupProblems,
  loadGroup,
  saveGroup,
  syncCombinedRooms,
} from '../room-groups';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const groupId = z.string().uuid();

const Body = z.object({
  name: z.string().trim().min(1).max(80),
  siteId: z.string().uuid(),
  roomIds: z.array(z.string().uuid()).min(2).max(50),
  dividers: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(80),
        roomIds: z.array(z.string().uuid()).min(2).max(20),
      }),
    )
    .max(100),
});

function asTrpc(e: unknown): never {
  if (e instanceof GroupError) throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
  throw e;
}

export const roomGroupRouter = router({
  list: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    const groups = await db.roomGroup.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { createdAt: 'asc' },
      include: { site: { select: { name: true } } },
    });
    const views = await Promise.all(groups.map((g) => loadGroup(db, ctx.orgId, g.id)));
    return groups.map((g, i) => {
      const v = views[i]!;
      return {
        id: g.id,
        name: g.name,
        siteId: g.siteId,
        siteName: g.site.name,
        rooms: v.rooms.map((r) => r.name),
        dividerCount: v.dividers.length,
        combinedCount: v.combined.length,
        createdCount: v.combined.filter((c) => c.roomId).length,
        problems: v.problems,
      };
    });
  }),

  get: orgProcedure.input(z.object({ orgId, groupId })).query(async ({ ctx, input }) => {
    const view = await loadGroup(db, ctx.orgId, input.groupId);
    if (!view) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room group not found' });
    return view;
  }),

  // Check a layout without saving it, so the editor can show problems and what it would make.
  check: orgProcedure
    .input(Body.extend({ orgId, groupId: groupId.optional() }))
    .query(async ({ ctx, input }) => ({
      problems: await groupProblems(db, ctx.orgId, { ...input, groupId: input.groupId }),
    })),

  save: orgProcedure
    .input(Body.extend({ orgId, groupId: groupId.optional() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      try {
        const id = await saveGroup(db, ctx.orgId, input);
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: input.groupId ? 'group.update' : 'group.create',
          target: id,
          meta: { name: input.name, rooms: input.roomIds.length, dividers: input.dividers.length },
        });
        return { id };
      } catch (e) {
        return asTrpc(e);
      }
    }),

  // Create the combined rooms the dividers allow, and remove ones they no longer allow.
  syncCombined: orgProcedure
    .input(z.object({ orgId, groupId }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      try {
        const result = await syncCombinedRooms(db, ctx.orgId, input.groupId);
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'group.sync',
          target: input.groupId,
          meta: { created: result.created.length, removed: result.removed.length },
        });
        return result;
      } catch (e) {
        return asTrpc(e);
      }
    }),

  delete: orgProcedure.input(z.object({ orgId, groupId })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    try {
      const res = await deleteGroup(db, ctx.orgId, input.groupId);
      if (!res.deleted)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `These combined rooms have been deployed and must be removed first: ${res.deployed.join(', ')}`,
        });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'group.delete',
        target: input.groupId,
      });
      return { ok: true };
    } catch (e) {
      return asTrpc(e);
    }
  }),
});
