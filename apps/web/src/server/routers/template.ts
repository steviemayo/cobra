import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { RoomModel, STARTER_TEMPLATES } from '@kestrel/model';
import { orgProcedure, requireRole, router } from '../trpc';
import { assertRoom, findTemplateModel, toJson } from './room-model-helpers';

const meta = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(''),
});

export const templateRouter = router({
  list: orgProcedure.input(z.object({ orgId: z.string().uuid() })).query(async ({ ctx }) => {
    const org = await db.template.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, description: true, roomType: true, createdAt: true },
    });
    return {
      starters: STARTER_TEMPLATES.map(({ id, name, description, roomType }) => ({
        id,
        name,
        description,
        roomType,
      })),
      org,
    };
  }),

  get: orgProcedure
    .input(z.object({ orgId: z.string().uuid(), templateId: z.string().min(1) }))
    .query(({ ctx, input }) => findTemplateModel(ctx.orgId, input.templateId)),

  // Save a room's current draft as an org template.
  createFromRoom: orgProcedure
    .input(meta.extend({ orgId: z.string().uuid(), roomId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const room = await assertRoom(ctx.orgId, input.roomId);
      const draft = await db.roomDraft.findFirst({ where: { roomId: room.id, orgId: ctx.orgId } });
      if (!draft) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room has no draft' });
      return db.template.create({
        data: {
          orgId: ctx.orgId,
          name: input.name,
          description: input.description,
          roomType: room.type,
          model: toJson(RoomModel.parse(draft.model)),
          createdBy: ctx.user.id,
        },
        select: { id: true, name: true },
      });
    }),

  // Copy a starter or org template into a new org template.
  clone: orgProcedure
    .input(meta.extend({ orgId: z.string().uuid(), templateId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const model = await findTemplateModel(ctx.orgId, input.templateId);
      return db.template.create({
        data: {
          orgId: ctx.orgId,
          name: input.name,
          description: input.description,
          roomType: model.roomType,
          model: toJson(model),
          createdBy: ctx.user.id,
        },
        select: { id: true, name: true },
      });
    }),

  delete: orgProcedure
    .input(z.object({ orgId: z.string().uuid(), templateId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      const { count } = await db.template.deleteMany({
        where: { id: input.templateId, orgId: ctx.orgId },
      });
      if (count === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Template not found' });
      return { ok: true };
    }),
});
