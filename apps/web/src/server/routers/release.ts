import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { diffRoomModels, summariseChanges } from '@kestrel/engine';
import { RoomModel, SignedManifest } from '@kestrel/model';
import { writeAudit } from '../audit';
import { createDeployment } from '../deployment-service';
import { orgPanelBranding } from '../provider-brand';
import { gatewayTooOld, setupProblem } from '../deploy-check';
import { ReleaseRestoreError, restoreReleaseDesign } from '../release-restore';
import { checkPublishable, createRelease } from '../release-service';
import { SigningNotConfigured, loadSigningKey } from '../signing';
import { controlProcedure, orgProcedure, requireRole, router } from '../trpc';
import { assertRoom } from './room-model-helpers';

const orgId = z.string().uuid();
const roomId = z.string().uuid();

export const releaseRouter = router({
  list: orgProcedure.input(z.object({ orgId, roomId })).query(async ({ ctx, input }) => {
    const room = await assertRoom(ctx.orgId, input.roomId);
    const releases = await db.release.findMany({
      where: { roomId: room.id, orgId: ctx.orgId },
      orderBy: { number: 'desc' },
      take: 50,
      select: { id: true, number: true, hash: true, createdAt: true, createdBy: true },
    });
    const userIds = [...new Set(releases.flatMap((r) => (r.createdBy ? [r.createdBy] : [])))];
    const members = userIds.length
      ? await db.member.findMany({
          where: { orgId: ctx.orgId, userId: { in: userIds } },
          select: { userId: true, email: true },
        })
      : [];
    const email = new Map(members.map((m) => [m.userId, m.email]));
    return {
      desiredReleaseId: room.desiredReleaseId,
      reportedReleaseId: room.reportedReleaseId,
      reportedStatus: room.reportedStatus,
      reportedError: room.reportedError,
      reportedAt: room.reportedAt,
      hasGateway: !!room.gatewayId,
      releases: releases.map((r) => ({ ...r, createdByEmail: r.createdBy ? (email.get(r.createdBy) ?? null) : null })),
    };
  }),

  // What changed, in plain words. `to` defaults to the current design; `from` to the release
  // before `to` (or the latest release, when `to` is the current design).
  diff: orgProcedure
    .input(
      z.object({
        orgId,
        roomId,
        toReleaseId: z.string().uuid().optional(),
        fromReleaseId: z.string().uuid().nullable().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const room = await assertRoom(ctx.orgId, input.roomId);
      const load = async (id: string) => {
        const r = await db.release.findFirst({ where: { id, roomId: room.id, orgId: ctx.orgId } });
        if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: 'Release not found' });
        return { number: r.number, model: SignedManifest.parse(r.manifest).manifest.model };
      };
      let to: { number: number | null; model: RoomModel };
      if (input.toReleaseId) to = await load(input.toReleaseId);
      else {
        const draft = await db.roomDraft.findFirst({
          where: { roomId: room.id, orgId: ctx.orgId },
        });
        if (!draft)
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'This room has no design yet' });
        to = { number: null, model: RoomModel.parse(draft.model) };
      }
      let from: { number: number; model: RoomModel } | null = null;
      if (input.fromReleaseId) from = await load(input.fromReleaseId);
      else if (input.fromReleaseId === undefined) {
        const before = await db.release.findFirst({
          where: {
            roomId: room.id,
            orgId: ctx.orgId,
            ...(to.number !== null && { number: { lt: to.number } }),
          },
          orderBy: { number: 'desc' },
        });
        if (before)
          from = {
            number: before.number,
            model: SignedManifest.parse(before.manifest).manifest.model,
          };
      }
      const changes = diffRoomModels(from?.model ?? null, to.model);
      return {
        from: from?.number ?? null,
        to: to.number,
        changes,
        summary: summariseChanges(changes),
      };
    }),

  // Put the working design back to what an earlier release froze. Publishes and deploys nothing; the
  // design as it was is kept as a saved version first, so this can be undone.
  restoreDesign: orgProcedure
    .input(z.object({ orgId, roomId, releaseId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const room = await assertRoom(ctx.orgId, input.roomId);
      try {
        const result = await restoreReleaseDesign(db, {
          orgId: ctx.orgId,
          roomId: room.id,
          roomType: room.type,
          releaseId: input.releaseId,
          userId: ctx.user.id,
        });
        if (result.changed)
          await writeAudit({
            orgId: ctx.orgId,
            actorId: ctx.user.id,
            action: 'release.restore_design',
            target: input.releaseId,
            meta: { room: room.name },
          });
        return result;
      } catch (e) {
        if (e instanceof ReleaseRestoreError) throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
        throw e;
      }
    }),

  // Freeze the current design as an immutable, signed release. With `deploy` it also starts running
  // on the room's gateway straight away; otherwise it waits to be deployed.
  publish: controlProcedure
    .input(z.object({ orgId, roomId, deploy: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const room = await assertRoom(ctx.orgId, input.roomId);
      const checked = await checkPublishable(db, ctx.orgId, room);
      if (!checked.ok) throw new TRPCError({ code: checked.code, message: checked.message });
      // Deploying means running on real devices, so their addresses must be in first.
      const setup = input.deploy && room.gatewayId ? setupProblem(checked.model, checked.bindings, checked.drivers) : null;
      if (setup) throw new TRPCError({ code: 'BAD_REQUEST', message: setup });
      const tooOld = input.deploy && room.gatewayId ? await gatewayTooOld(db, ctx.orgId, room.gatewayId, checked.model) : null;
      if (tooOld) throw new TRPCError({ code: 'BAD_REQUEST', message: tooOld });

      let key;
      try {
        key = loadSigningKey();
      } catch (e) {
        if (e instanceof SigningNotConfigured)
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message });
        throw e;
      }

      const orgRow = await db.org.findFirst({
        where: { id: ctx.orgId },
        select: { branding: true },
      });
      const release = await createRelease(db, {
        orgId: ctx.orgId,
        room,
        checked,
        key,
        orgBranding: await orgPanelBranding(db, ctx.orgId, orgRow?.branding),
        userId: ctx.user.id,
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'release.publish',
        target: release.id,
        meta: { room: room.name, number: release.number },
      });
      let deploymentId: string | null = null;
      if (input.deploy && room.gatewayId) {
        const deployment = await createDeployment(db, {
          orgId: ctx.orgId,
          roomId: room.id,
          gatewayId: room.gatewayId,
          releaseId: release.id,
          kind: 'deploy',
          createdBy: ctx.user.id,
          scheduledFor: null,
        });
        deploymentId = deployment.id;
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'deployment.create',
          target: deployment.id,
          meta: { room: room.name, number: release.number },
        });
      }
      return { id: release.id, number: release.number, deploymentId };
    }),
});
