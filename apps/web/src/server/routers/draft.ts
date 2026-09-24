import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db, type Prisma } from '@kestrel/db';
import { RoomModel, newRoomModel } from '@kestrel/model';
import { orgProcedure, requireRole, router } from '../trpc';
import { assertRoom, findTemplateModel, toJson } from './room-model-helpers';

const roomInput = z.object({ orgId: z.string().uuid(), roomId: z.string().uuid() });

export const draftRouter = router({
  get: orgProcedure.input(roomInput).query(async ({ ctx, input }) => {
    const draft = await db.roomDraft.findFirst({
      where: { roomId: input.roomId, orgId: ctx.orgId },
    });
    if (!draft) return null;
    return {
      revision: draft.revision,
      updatedAt: draft.updatedAt,
      model: RoomModel.parse(draft.model),
    };
  }),

  init: orgProcedure
    .input(roomInput.extend({ templateId: z.string().min(1).optional() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const room = await assertRoom(ctx.orgId, input.roomId);
      const existing = await db.roomDraft.findUnique({ where: { roomId: room.id } });
      if (existing) throw new TRPCError({ code: 'CONFLICT', message: 'Draft already exists' });
      const model = input.templateId
        ? await findTemplateModel(ctx.orgId, input.templateId)
        : newRoomModel(room.type);
      if (model.roomType !== room.type)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Template is for a different room type',
        });
      const draft = await db.roomDraft.create({
        data: { orgId: ctx.orgId, roomId: room.id, model: toJson(model), updatedBy: ctx.user.id },
      });
      return { revision: draft.revision, model };
    }),

  // Autosave. `baseRevision` must match the stored revision, otherwise another editor saved first.
  save: orgProcedure
    .input(roomInput.extend({ baseRevision: z.number().int().min(1), model: RoomModel }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const room = await assertRoom(ctx.orgId, input.roomId);
      if (input.model.roomType !== room.type)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Model room type does not match room',
        });
      const { count } = await db.roomDraft.updateMany({
        where: { roomId: room.id, orgId: ctx.orgId, revision: input.baseRevision },
        data: {
          model: toJson(input.model),
          revision: { increment: 1 },
          updatedBy: ctx.user.id,
        },
      });
      if (count === 0)
        throw new TRPCError({ code: 'CONFLICT', message: 'Draft changed since you loaded it' });
      return { revision: input.baseRevision + 1 };
    }),

  saveVersion: orgProcedure
    .input(roomInput.extend({ label: z.string().trim().max(100).optional() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const draft = await db.roomDraft.findFirst({
        where: { roomId: input.roomId, orgId: ctx.orgId },
      });
      if (!draft) throw new TRPCError({ code: 'NOT_FOUND', message: 'Draft not found' });
      const v = await db.roomDraftVersion.create({
        data: {
          orgId: ctx.orgId,
          draftId: draft.id,
          revision: draft.revision,
          label: input.label || null,
          model: draft.model as Prisma.InputJsonValue,
          createdBy: ctx.user.id,
        },
      });
      return { id: v.id, revision: v.revision };
    }),

  versions: orgProcedure.input(roomInput).query(async ({ ctx, input }) => {
    const draft = await db.roomDraft.findFirst({
      where: { roomId: input.roomId, orgId: ctx.orgId },
      select: { id: true },
    });
    if (!draft) return [];
    return db.roomDraftVersion.findMany({
      where: { draftId: draft.id, orgId: ctx.orgId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, revision: true, label: true, createdAt: true, createdBy: true },
    });
  }),

  // Restore overwrites the working draft; the pre-restore state is kept as a version first.
  restoreVersion: orgProcedure
    .input(roomInput.extend({ versionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const draft = await db.roomDraft.findFirst({
        where: { roomId: input.roomId, orgId: ctx.orgId },
      });
      if (!draft) throw new TRPCError({ code: 'NOT_FOUND', message: 'Draft not found' });
      const version = await db.roomDraftVersion.findFirst({
        where: { id: input.versionId, draftId: draft.id, orgId: ctx.orgId },
      });
      if (!version) throw new TRPCError({ code: 'NOT_FOUND', message: 'Version not found' });
      const restored = RoomModel.parse(version.model);
      const updated = await db.$transaction(async (tx) => {
        await tx.roomDraftVersion.create({
          data: {
            orgId: ctx.orgId,
            draftId: draft.id,
            revision: draft.revision,
            label: 'Before restore',
            model: draft.model as Prisma.InputJsonValue,
            createdBy: ctx.user.id,
          },
        });
        return tx.roomDraft.update({
          where: { id: draft.id },
          data: { model: toJson(restored), revision: { increment: 1 }, updatedBy: ctx.user.id },
        });
      });
      return { revision: updated.revision, model: restored };
    }),
});
