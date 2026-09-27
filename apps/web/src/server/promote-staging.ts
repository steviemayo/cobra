import type { Prisma, PrismaClient } from '@kestrel/db';
import type { RoomModel } from '@kestrel/model';
import { STAGING } from './room-kinds';

// Promoting a staging room: its design goes into a live room's working draft. Nothing is published
// or deployed, so the design is reviewed and published as usual. What the live room's draft held is
// kept as a saved version first, so this can be undone. Addresses are not copied: a live room keeps
// its own. These functions take the database as a parameter so they can be tested without one.
export type PromoteDb = Pick<PrismaClient, 'room' | 'roomDraft' | 'roomDraftVersion'>;

export class PromoteError extends Error {}

export type PromoteResult = { changed: false } | { changed: true; revision: number };

const stable = (m: unknown) =>
  JSON.stringify(m, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

export async function promoteStaging(
  db: PromoteDb,
  input: {
    orgId: string;
    stagingId: string;
    targetId: string;
    /** The staging room's design, already stripped of addresses. */
    model: RoomModel;
    userId: string | null;
  },
): Promise<PromoteResult> {
  const staging = await db.room.findFirst({ where: { id: input.stagingId, orgId: input.orgId } });
  if (!staging || staging.kind !== STAGING) throw new PromoteError('That is not a staging room.');
  const target = await db.room.findFirst({ where: { id: input.targetId, orgId: input.orgId } });
  if (!target) throw new PromoteError('The room to promote into was not found.');
  if ((target.kind ?? 'standard') !== 'standard')
    throw new PromoteError('A staging design can only be promoted into an ordinary room.');
  if (target.siteId !== staging.siteId) throw new PromoteError('Choose a room at the same site.');
  if (target.type !== staging.type) throw new PromoteError('Choose a room of the same type.');

  const draft = await db.roomDraft.findFirst({ where: { roomId: target.id, orgId: input.orgId } });
  if (!draft) {
    await db.roomDraft.create({
      data: {
        orgId: input.orgId,
        roomId: target.id,
        model: input.model as unknown as Prisma.InputJsonValue,
        updatedBy: input.userId,
      },
    });
    return { changed: true, revision: 1 };
  }
  if (stable(draft.model) === stable(input.model)) return { changed: false };

  const before = draft.revision;
  await db.roomDraftVersion.create({
    data: {
      orgId: input.orgId,
      draftId: draft.id,
      revision: before,
      label: `Before promoting “${staging.name}”`,
      model: draft.model as Prisma.InputJsonValue,
      createdBy: input.userId,
    },
  });
  // Only if nobody saved in between, so a colleague's edit is never overwritten unseen.
  const { count } = await db.roomDraft.updateMany({
    where: { id: draft.id, revision: before },
    data: {
      model: input.model as unknown as Prisma.InputJsonValue,
      revision: before + 1,
      updatedBy: input.userId,
    },
  });
  if (count === 0) throw new PromoteError('The room’s design changed while promoting. Try again.');
  return { changed: true, revision: before + 1 };
}
