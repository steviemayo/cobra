import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { TransitionAction } from '@kestrel/model';
import { writeAudit } from '../audit';
import { deployGroup, planGroupDeploy } from '../group-deploy';
import { readOrgBranding } from '../panel-settings';
import { SigningNotConfigured, loadSigningKey } from '../signing';
import {
  GroupError,
  deleteGroup,
  groupProblems,
  loadGroup,
  loadGroupSimulation,
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
        onOpen: TransitionAction.optional(),
        onClose: TransitionAction.optional(),
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

  // The group and each room's current design, for the browser simulator.
  simulation: orgProcedure.input(z.object({ orgId, groupId })).query(async ({ ctx, input }) => {
    const sim = await loadGroupSimulation(db, ctx.orgId, input.groupId);
    if (!sim) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room group not found' });
    return sim;
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

  // What deploying the whole group would do, room by room, or what stops it. Changes nothing.
  deployPreview: orgProcedure.input(z.object({ orgId, groupId })).query(async ({ ctx, input }) => {
    try {
      return (await planGroupDeploy(db, ctx.orgId, input.groupId)).plan;
    } catch (e) {
      return asTrpc(e);
    }
  }),

  // Publish (where the design changed) and deploy every room and combined room of the group.
  deploy: orgProcedure.input(z.object({ orgId, groupId })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    let key;
    try {
      key = loadSigningKey();
    } catch (e) {
      if (e instanceof SigningNotConfigured)
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message });
      throw e;
    }
    const org = await db.org.findFirst({ where: { id: ctx.orgId }, select: { branding: true } });
    try {
      const results = await deployGroup(db, ctx.orgId, input.groupId, {
        key,
        orgBranding: readOrgBranding(org?.branding),
        userId: ctx.user.id,
      });
      // The same records as deploying each room by hand, plus one for the group.
      for (const r of results) {
        if (r.published)
          await writeAudit({
            orgId: ctx.orgId,
            actorId: ctx.user.id,
            action: 'release.publish',
            target: r.roomId,
            meta: { room: r.name, number: r.number },
          });
        if (r.deploymentId)
          await writeAudit({
            orgId: ctx.orgId,
            actorId: ctx.user.id,
            action: 'deployment.create',
            target: r.deploymentId,
            meta: { room: r.name, number: r.number },
          });
      }
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'group.deploy',
        target: input.groupId,
        meta: {
          rooms: results.length,
          deployed: results.filter((r) => r.deployed).length,
          published: results.filter((r) => r.published).length,
        },
      });
      return { results };
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
