import type { Prisma, PrismaClient } from '@kestrel/db';
import type { RoomModel, RoomType } from '@kestrel/model';
import { readPlainBindings, setRoomBindings, type BindingsDb } from './bindings';

// Copying a room: a new room at the same site with the same design and gateway. Addresses are not
// copied, because every device in the new room has its own; the shared logins chosen for the
// original are, so only the addresses are left to fill in. The panel PIN and webhook secret stay
// with the original. These functions take the database as a parameter so they can be tested
// without one, and run inside one transaction in production.
export type DuplicateDb = Pick<PrismaClient, 'room' | 'roomDraft'> & BindingsDb;

export class DuplicateRoomError extends Error {}

export interface DuplicateInput {
  orgId: string;
  source: { id: string; siteId: string; type: RoomType; gatewayId: string | null };
  name: string;
  /** The source's design, already stripped of addresses. */
  model: RoomModel;
  userId: string | null;
}

const normal = (name: string) => name.trim().toLowerCase();

export async function duplicateRoom(
  db: DuplicateDb,
  input: DuplicateInput,
): Promise<{ id: string; name: string }> {
  const name = input.name.trim();
  // Rooms are found by name when filling in addresses from a sheet, so a name is used once a site.
  const same = await db.room.findMany({ where: { orgId: input.orgId, siteId: input.source.siteId } });
  if (same.some((r) => r.kind !== 'combined' && normal(r.name) === normal(name)))
    throw new DuplicateRoomError('A room with this name already exists at this site.');

  const room = await db.room.create({
    data: {
      orgId: input.orgId,
      siteId: input.source.siteId,
      name,
      type: input.source.type,
      ...(input.source.gatewayId ? { gatewayId: input.source.gatewayId } : {}),
    },
  });
  await db.roomDraft.create({
    data: {
      orgId: input.orgId,
      roomId: room.id,
      model: input.model as unknown as Prisma.InputJsonValue,
      updatedBy: input.userId,
    },
  });
  const { credentialSets } = await readPlainBindings(db, input.source.id);
  if (Object.keys(credentialSets).length > 0)
    await setRoomBindings(db, {
      orgId: input.orgId,
      roomId: room.id,
      userId: input.userId,
      values: {},
      credentialSets,
    });
  return { id: room.id, name };
}
