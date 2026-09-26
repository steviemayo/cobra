import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db, type Prisma } from '@kestrel/db';
import { RoomModel, STARTER_TEMPLATES, stripBindings } from '@kestrel/model';
import { pinDrivers } from '../custom-drivers';

export function toJson(model: RoomModel): Prisma.InputJsonValue {
  return model as unknown as Prisma.InputJsonValue;
}

export async function assertRoom(orgId: string, roomId: string) {
  const room = await db.room.findFirst({ where: { id: roomId, orgId } });
  if (!room) throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
  return room;
}

/**
 * The room without addresses or logins. Templates carry none (docs/driver-classes.md, DC-5): a
 * room made from one starts as "needs setup". Custom drivers the room uses say which of their
 * settings are addresses and logins; a driver we cannot find falls back to well-known names.
 */
export async function designOnly(orgId: string, model: RoomModel): Promise<RoomModel> {
  const pinned = await pinDrivers(db, orgId, model);
  return stripBindings(model, pinned.ok ? pinned.drivers : {}).model;
}

// templateId is either a Kestrel starter slug or an org template uuid (always org-scoped).
export async function findTemplateModel(orgId: string, templateId: string): Promise<RoomModel> {
  if (z.string().uuid().safeParse(templateId).success) {
    const t = await db.template.findFirst({ where: { id: templateId, orgId } });
    if (!t) throw new TRPCError({ code: 'NOT_FOUND', message: 'Template not found' });
    return designOnly(orgId, RoomModel.parse(t.model));
  }
  const starter = STARTER_TEMPLATES.find((s) => s.id === templateId);
  if (!starter) throw new TRPCError({ code: 'NOT_FOUND', message: 'Template not found' });
  return designOnly(orgId, starter.model);
}
