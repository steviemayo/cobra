import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db, type Prisma } from '@kestrel/db';
import { RoomModel, STARTER_TEMPLATES } from '@kestrel/model';

export function toJson(model: RoomModel): Prisma.InputJsonValue {
  return model as unknown as Prisma.InputJsonValue;
}

export async function assertRoom(orgId: string, roomId: string) {
  const room = await db.room.findFirst({ where: { id: roomId, orgId } });
  if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
  return room;
}

// templateId is either a Kestrel starter slug or an org template uuid (always org-scoped).
export async function findTemplateModel(orgId: string, templateId: string): Promise<RoomModel> {
  if (z.string().uuid().safeParse(templateId).success) {
    const t = await db.template.findFirst({ where: { id: templateId, orgId } });
    if (!t) throw new TRPCError({ code: 'NOT_FOUND', message: 'Template not found' });
    return RoomModel.parse(t.model);
  }
  const starter = STARTER_TEMPLATES.find((s) => s.id === templateId);
  if (!starter) throw new TRPCError({ code: 'NOT_FOUND', message: 'Template not found' });
  return starter.model;
}
