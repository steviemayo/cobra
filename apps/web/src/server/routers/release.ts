import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db, Prisma } from '@kestrel/db';
import { signManifest } from '@kestrel/crypto';
import { validateRoomModel } from '@kestrel/engine';
import { RoomModel } from '@kestrel/model';
import { writeAudit } from '../audit';
import { readPanel } from '../panel-settings';
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
      releases,
    };
  }),

  // Freeze the current design as an immutable, signed release and make it the one to run.
  publish: orgProcedure.input(z.object({ orgId, roomId })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    const room = await assertRoom(ctx.orgId, input.roomId);
    const draft = await db.roomDraft.findFirst({ where: { roomId: room.id, orgId: ctx.orgId } });
    if (!draft) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Design the room before publishing' });

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

    const create = async () => {
      const last = await db.release.aggregate({ where: { roomId: room.id }, _max: { number: true } });
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
          panel: readPanel(room.panel),
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
          createdBy: ctx.user.id,
        },
      });
    };
    let release;
    try {
      release = await create();
    } catch (e) {
      // Two people publishing at once: the loser retries with the next number.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') release = await create();
      else throw e;
    }
    await db.room.update({ where: { id: room.id }, data: { desiredReleaseId: release.id } });
    await writeAudit({
      orgId: ctx.orgId,
      actorId: ctx.user.id,
      action: 'release.publish',
      target: release.id,
      meta: { room: room.name, number: release.number },
    });
    return { id: release.id, number: release.number };
  }),

  // Point the room at any existing release. Choosing an older one is a rollback.
  deploy: orgProcedure
    .input(z.object({ orgId, roomId, releaseId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const room = await assertRoom(ctx.orgId, input.roomId);
      const release = await db.release.findFirst({
        where: { id: input.releaseId, roomId: room.id, orgId: ctx.orgId },
      });
      if (!release) throw new TRPCError({ code: 'NOT_FOUND', message: 'Release not found' });
      await db.room.update({ where: { id: room.id }, data: { desiredReleaseId: release.id } });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'release.deploy',
        target: release.id,
        meta: { room: room.name, number: release.number },
      });
      return { number: release.number };
    }),
});
