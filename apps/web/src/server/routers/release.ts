import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db, Prisma } from '@kestrel/db';
import { signManifest } from '@kestrel/crypto';
import { diffRoomModels, summariseChanges, validateRoomModel } from '@kestrel/engine';
import { RoomModel, SignedManifest } from '@kestrel/model';
import { writeAudit } from '../audit';
import { createDeployment } from '../deployment-service';
import { effectivePanel, readOrgBranding, readPanel } from '../panel-settings';
import { SigningNotConfigured, loadSigningKey } from '../signing';
import { orgProcedure, requireRole, router } from '../trpc';
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
    return {
      desiredReleaseId: room.desiredReleaseId,
      reportedReleaseId: room.reportedReleaseId,
      reportedStatus: room.reportedStatus,
      reportedError: room.reportedError,
      reportedAt: room.reportedAt,
      hasGateway: !!room.gatewayId,
      releases,
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

  // Freeze the current design as an immutable, signed release. With `deploy` it also starts running
  // on the room's gateway straight away; otherwise it waits to be deployed.
  publish: orgProcedure
    .input(z.object({ orgId, roomId, deploy: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const room = await assertRoom(ctx.orgId, input.roomId);
      const draft = await db.roomDraft.findFirst({ where: { roomId: room.id, orgId: ctx.orgId } });
      if (!draft)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Design the room before publishing' });

      const model = RoomModel.parse(draft.model);
      const errors = validateRoomModel(model).issues.filter((i) => i.severity === 'error');
      if (errors.length)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Fix ${errors.length} design problem${errors.length === 1 ? '' : 's'} first: ${errors[0]!.message}`,
        });

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
      const orgBranding = readOrgBranding(orgRow?.branding);

      const create = async () => {
        const last = await db.release.aggregate({
          where: { roomId: room.id },
          _max: { number: true },
        });
        const number = (last._max.number ?? 0) + 1;
        const id = randomUUID();
        const signed = signManifest(
          {
            manifestVersion: 1,
            orgId: ctx.orgId,
            roomId: room.id,
            roomName: room.name,
            releaseId: id,
            releaseNumber: number,
            createdAt: new Date().toISOString(),
            model,
            panel: effectivePanel(readPanel(room.panel), orgBranding),
          },
          key,
        );
        return db.release.create({
          data: {
            id,
            orgId: ctx.orgId,
            roomId: room.id,
            number,
            manifest: signed as unknown as Prisma.InputJsonValue,
            hash: signed.hash,
            draftRevision: draft.revision,
            createdBy: ctx.user.id,
          },
        });
      };
      let release;
      try {
        release = await create();
      } catch (e) {
        // Two people publishing at once: the loser retries with the next number.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          release = await create();
        else throw e;
      }
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
