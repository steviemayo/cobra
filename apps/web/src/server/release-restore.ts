import type { Prisma, PrismaClient } from '@kestrel/db';
import { SignedManifest, stripBindings, type CustomDrivers } from '@kestrel/model';

// Putting a room's design back to what an earlier release froze. Only the working draft changes:
// nothing is published or deployed, so the person still reviews the result and publishes it. What
// the draft held before is kept as a saved version first, so this can be undone. These functions
// take the database as a parameter so they can be tested without one.
export type ReleaseRestoreDb = Pick<PrismaClient, 'release' | 'roomDraft' | 'roomDraftVersion'>;

export class ReleaseRestoreError extends Error {}

export type RestoreResult =
  | { changed: false }
  | { changed: true; revision: number; savedVersionId: string };

const stable = (m: unknown) =>
  JSON.stringify(m, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

export async function restoreReleaseDesign(
  db: ReleaseRestoreDb,
  input: { orgId: string; roomId: string; roomType: string; releaseId: string; userId: string | null },
): Promise<RestoreResult> {
  const release = await db.release.findFirst({
    where: { id: input.releaseId, roomId: input.roomId, orgId: input.orgId },
  });
  if (!release) throw new ReleaseRestoreError('Release not found');
  const signed = SignedManifest.safeParse(release.manifest);
  if (!signed.success) throw new ReleaseRestoreError('That release cannot be read');
  // A release for a gateway that cannot fetch bindings carries addresses and logins inline. The
  // draft never holds them, so they are taken out; the room's own bindings stay as they are.
  const { manifest } = signed.data;
  const model = stripBindings(manifest.model, (manifest.drivers ?? {}) as CustomDrivers).model;
  if (model.roomType !== input.roomType)
    throw new ReleaseRestoreError('That release is for a different room type');

  const draft = await db.roomDraft.findFirst({ where: { roomId: input.roomId, orgId: input.orgId } });
  if (!draft) throw new ReleaseRestoreError('This room has no design to restore into');
  if (stable(draft.model) === stable(model)) return { changed: false };

  const before = draft.revision;
  const saved = await db.roomDraftVersion.create({
    data: {
      orgId: input.orgId,
      draftId: draft.id,
      revision: before,
      label: `Before restoring release ${release.number}`,
      model: draft.model as Prisma.InputJsonValue,
      createdBy: input.userId,
    },
  });
  // Only if nobody saved in between, so a colleague's edit is never overwritten unseen.
  const { count } = await db.roomDraft.updateMany({
    where: { id: draft.id, revision: before },
    data: {
      model: model as unknown as Prisma.InputJsonValue,
      revision: before + 1,
      updatedBy: input.userId,
    },
  });
  if (count === 0) throw new ReleaseRestoreError('The design changed while restoring. Try again.');
  return { changed: true, revision: before + 1, savedVersionId: saved.id };
}
