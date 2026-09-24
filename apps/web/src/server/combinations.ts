import type { PrismaClient } from '@kestrel/db';
import type { CombinationConfig, CombinationReport } from '@kestrel/model';

// Combined rooms: which rooms can be joined into one, and what each side does while joined.
// The gateway owns the live state; the cloud keeps the definition and the last reported state.
export type CombinationDb = Pick<PrismaClient, 'roomCombination' | 'room'>;

export interface CombinationInput {
  primaryRoomId: string;
  secondaryRoomIds: string[];
}

/**
 * A combination only works if every room is in the organisation, at one site, on one gateway,
 * and belongs to no other combination (a room can't answer to two primaries). Returns what is
 * wrong, in words, or null.
 */
export async function combinationProblem(
  db: CombinationDb,
  orgId: string,
  input: CombinationInput,
  exceptId?: string,
): Promise<string | null> {
  const ids = [input.primaryRoomId, ...input.secondaryRoomIds];
  if (input.secondaryRoomIds.length === 0) return 'Choose at least one room to combine with';
  if (new Set(ids).size !== ids.length) return 'A room can only appear once in a combination';
  const rooms = (await db.room.findMany({ where: { orgId, id: { in: ids } } })) as {
    id: string;
    name: string;
    siteId: string;
    gatewayId: string | null;
  }[];
  if (rooms.length !== ids.length) return 'One of those rooms was not found';
  const unassigned = rooms.find((r) => !r.gatewayId);
  if (unassigned) return `“${unassigned.name}” is not assigned to a gateway yet`;
  if (new Set(rooms.map((r) => r.gatewayId)).size !== 1)
    return 'Combined rooms must all run on the same gateway';
  if (new Set(rooms.map((r) => r.siteId)).size !== 1)
    return 'Combined rooms must be at the same site';

  const others = (await db.roomCombination.findMany({ where: { orgId } })).filter(
    (c) => c.id !== exceptId,
  );
  const taken = new Map<string, string>();
  for (const c of others)
    for (const r of [c.primaryRoomId, ...c.secondaryRoomIds]) taken.set(r, c.name);
  const clash = rooms.find((r) => taken.has(r.id));
  if (clash) return `“${clash.name}” is already part of “${taken.get(clash.id)}”`;
  return null;
}

/** The combinations a gateway should know about: those whose rooms all run on it. */
export async function combinationsForGateway(
  db: CombinationDb,
  gateway: { id: string; orgId: string },
): Promise<CombinationConfig[]> {
  const [combos, rooms] = await Promise.all([
    db.roomCombination.findMany({ where: { orgId: gateway.orgId } }),
    db.room.findMany({ where: { orgId: gateway.orgId, gatewayId: gateway.id } }),
  ]);
  const own = new Set(rooms.map((r) => r.id));
  return combos
    .filter((c) => [c.primaryRoomId, ...c.secondaryRoomIds].every((r) => own.has(r)))
    .map((c) => ({
      id: c.id,
      name: c.name,
      primaryRoomId: c.primaryRoomId,
      secondaryRoomIds: c.secondaryRoomIds,
      secondaryVideo: c.secondaryVideo as 'follow' | 'blank',
      secondaryAudio: c.secondaryAudio as 'follow' | 'blank',
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Records which combinations a gateway says are joined. It can only speak for its own. */
export async function recordCombined(
  db: CombinationDb,
  gateway: { id: string; orgId: string },
  reports: CombinationReport[],
): Promise<void> {
  if (reports.length === 0) return;
  const own = new Set((await combinationsForGateway(db, gateway)).map((c) => c.id));
  for (const r of reports)
    if (own.has(r.id))
      await db.roomCombination.updateMany({
        where: { id: r.id, orgId: gateway.orgId },
        data: { combined: r.combined },
      });
}
