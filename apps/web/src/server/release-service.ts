import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@kestrel/db';
import { signManifest } from '@kestrel/crypto';
import { validateRoomModel } from '@kestrel/engine';
import { RoomModel, type PanelBranding, type PinnedDriver } from '@kestrel/model';
import { pinDrivers, type DriverDb } from './custom-drivers';
import { effectivePanel, readPanel } from './panel-settings';
import type { SigningKey } from './signing';

// Turning a room's draft into a signed, immutable release. Shared by publishing one room and by
// deploying a whole room group. These functions take the database as a parameter so they can be
// tested without one.
export type ReleaseDb = Pick<PrismaClient, 'release' | 'roomDraft'> & DriverDb;

export interface PublishableRoom {
  id: string;
  name: string;
  panel: unknown;
}

export type Publishable =
  | {
      ok: true;
      draft: { revision: number };
      model: RoomModel;
      drivers: Record<string, PinnedDriver>;
    }
  | { ok: false; code: 'BAD_REQUEST'; message: string };

/** Whether the room's draft can be published, and what a release of it would contain. */
export async function checkPublishable(
  db: ReleaseDb,
  orgId: string,
  room: { id: string },
): Promise<Publishable> {
  const draft = await db.roomDraft.findFirst({ where: { roomId: room.id, orgId } });
  if (!draft)
    return { ok: false, code: 'BAD_REQUEST', message: 'Design the room before publishing' };
  const model = RoomModel.parse(draft.model);
  const errors = validateRoomModel(model).issues.filter((i) => i.severity === 'error');
  if (errors.length)
    return {
      ok: false,
      code: 'BAD_REQUEST',
      message: `Fix ${errors.length} design problem${errors.length === 1 ? '' : 's'} first: ${errors[0]!.message}`,
    };
  const pinned = await pinDrivers(db, orgId, model);
  if (!pinned.ok) return { ok: false, code: 'BAD_REQUEST', message: pinned.problems[0]! };
  return { ok: true, draft: { revision: draft.revision }, model, drivers: pinned.drivers };
}

/** Sign and store the next release of a room. Two people publishing at once: the loser retries. */
export async function createRelease(
  db: ReleaseDb,
  input: {
    orgId: string;
    room: PublishableRoom;
    checked: Extract<Publishable, { ok: true }>;
    key: SigningKey;
    orgBranding: PanelBranding;
    userId: string | null;
  },
) {
  const { orgId, room, checked, key, orgBranding, userId } = input;
  const create = async () => {
    const last = await db.release.aggregate({ where: { roomId: room.id }, _max: { number: true } });
    const number = (last._max.number ?? 0) + 1;
    const id = randomUUID();
    const signed = signManifest(
      {
        manifestVersion: 1,
        orgId,
        roomId: room.id,
        roomName: room.name,
        releaseId: id,
        releaseNumber: number,
        createdAt: new Date().toISOString(),
        model: checked.model,
        drivers: checked.drivers,
        panel: effectivePanel(readPanel(room.panel), orgBranding),
      },
      key,
    );
    return db.release.create({
      data: {
        id,
        orgId,
        roomId: room.id,
        number,
        manifest: signed as unknown as Prisma.InputJsonValue,
        hash: signed.hash,
        draftRevision: checked.draft.revision,
        createdBy: userId,
      },
    });
  };
  try {
    return await create();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return create();
    throw e;
  }
}
