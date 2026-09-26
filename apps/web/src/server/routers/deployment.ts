import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { writeAudit } from '../audit';
import { checkDeployable } from '../deploy-check';
import { roomDeployStates } from '../deployment-queries';
import { cancelScheduled, createDeployment } from '../deployment-service';
import { orgProcedure, requireRole, router } from '../trpc';
import { assertRoom } from './room-model-helpers';

const orgId = z.string().uuid();
const roomId = z.string().uuid();
const MAX_SCHEDULE_AHEAD_MS = 90 * 24 * 3_600_000;

const listSelect = {
  id: true,
  roomId: true,
  releaseId: true,
  status: true,
  kind: true,
  scheduledFor: true,
  createdBy: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  error: true,
  release: { select: { number: true } },
  room: { select: { name: true, siteId: true } },
  events: { select: { stage: true, at: true }, orderBy: { at: 'asc' } },
} as const;

export const deploymentRouter = router({
  // Every room's deploy state at once, for the org-wide Deployments page and room badges.
  overview: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => {
    const [states, rooms] = await Promise.all([
      roomDeployStates(ctx.orgId),
      db.room.findMany({
        where: { orgId: ctx.orgId },
        select: { id: true, name: true, siteId: true, gatewayId: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    const byRoom = new Map(states.map((s) => [s.roomId, s]));
    return rooms.flatMap((room) => {
      const state = byRoom.get(room.id);
      return state ? [{ room, ...state }] : [];
    });
  }),

  roomStatus: orgProcedure.input(z.object({ orgId, roomId })).query(async ({ ctx, input }) => {
    await assertRoom(ctx.orgId, input.roomId);
    const [state] = await roomDeployStates(ctx.orgId, [input.roomId]);
    return state!;
  }),

  list: orgProcedure
    .input(z.object({ orgId, roomId: roomId.optional(), limit: z.number().int().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      if (input.roomId) await assertRoom(ctx.orgId, input.roomId);
      const rows = await db.deployment.findMany({
        where: { orgId: ctx.orgId, ...(input.roomId && { roomId: input.roomId }) },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
        select: listSelect,
      });
      const userIds = [...new Set(rows.flatMap((r) => (r.createdBy ? [r.createdBy] : [])))];
      const members = userIds.length
        ? await db.member.findMany({
            where: { orgId: ctx.orgId, userId: { in: userIds } },
            select: { userId: true, email: true },
          })
        : [];
      const email = new Map(members.map((m) => [m.userId, m.email]));
      return rows.map((r) => ({ ...r, createdByEmail: r.createdBy ? (email.get(r.createdBy) ?? null) : null }));
    }),

  // Start a release now, or schedule it. Choosing an older release than the running one is a rollback.
  create: orgProcedure
    .input(
      z.object({
        orgId,
        roomId,
        releaseId: z.string().uuid(),
        /** ISO time to start at. Leave out to start now. */
        scheduledFor: z.string().datetime().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const room = await assertRoom(ctx.orgId, input.roomId);
      if (!room.gatewayId)
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Assign a gateway to this room first' });
      const release = await db.release.findFirst({
        where: { id: input.releaseId, roomId: room.id, orgId: ctx.orgId },
        select: { id: true, number: true },
      });
      if (!release) throw new TRPCError({ code: 'NOT_FOUND', message: 'Release not found' });

      const scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : null;
      if (scheduledFor && scheduledFor.getTime() > Date.now() + MAX_SCHEDULE_AHEAD_MS)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Schedule within the next 90 days' });

      const [state] = await roomDeployStates(ctx.orgId, [room.id]);
      if (state!.state === 'in_sync' && state!.desiredRelease?.id === release.id)
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Release ${release.number} is already running` });

      const ready = await checkDeployable(db, {
        orgId: ctx.orgId,
        roomId: room.id,
        gatewayId: room.gatewayId,
        releaseId: release.id,
      });
      if (!ready.ok) throw new TRPCError({ code: 'BAD_REQUEST', message: ready.message });

      const current = state!.desiredRelease;
      const deployment = await createDeployment(db, {
        orgId: ctx.orgId,
        roomId: room.id,
        gatewayId: room.gatewayId,
        releaseId: release.id,
        kind: current && release.number < current.number ? 'rollback' : 'deploy',
        createdBy: ctx.user.id,
        scheduledFor,
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: scheduledFor ? 'deployment.schedule' : 'deployment.create',
        target: deployment.id,
        meta: {
          room: room.name,
          number: release.number,
          kind: deployment.kind,
          ...(scheduledFor && { scheduledFor: scheduledFor.toISOString() }),
        },
      });
      return { id: deployment.id, status: deployment.status, kind: deployment.kind };
    }),

  // Only a deployment still waiting for its time can be cancelled.
  cancel: orgProcedure.input(z.object({ orgId, deploymentId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const dep = await db.deployment.findFirst({
      where: { id: input.deploymentId, orgId: ctx.orgId },
      select: { id: true, release: { select: { number: true } }, room: { select: { name: true } } },
    });
    if (!dep) throw new TRPCError({ code: 'NOT_FOUND', message: 'Deployment not found' });
    if (!(await cancelScheduled(db, ctx.orgId, dep.id)))
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only a scheduled deployment can be cancelled' });
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'deployment.cancel',
      target: dep.id,
      meta: { room: dep.room.name, number: dep.release.number },
    });
    return { ok: true };
  }),
});
