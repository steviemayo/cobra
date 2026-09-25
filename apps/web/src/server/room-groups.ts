import type { Prisma, PrismaClient } from '@kestrel/db';
import {
  DEFAULT_ON_CLOSE,
  DEFAULT_ON_OPEN,
  RoomModel,
  TransitionAction,
  type RoomGroupSpec,
  type RoomType,
} from '@kestrel/model';
import {
  combinedKey,
  deriveCombinedModel,
  enumerateCombinedRooms,
  memberKey,
  validateGroupSpec,
} from '@kestrel/engine';

// Room groups: rooms that can be physically joined by movable walls, and the combined rooms that
// exist while they are. A combined room is an ordinary Room row (kind "combined") whose starting
// draft is derived from its members. The gateway will own which walls are open (later slice).
export type GroupDb = Pick<
  PrismaClient,
  'room' | 'roomGroup' | 'roomDivider' | 'roomDraft' | 'release'
>;

export interface GroupInput {
  /** Omit to create a new group. */
  groupId?: string;
  name: string;
  siteId: string;
  /** The ordinary rooms in the group, in the order they should read in names. */
  roomIds: string[];
  /** Dividers keep their id when edited, so what is stored about them survives. */
  dividers: {
    id?: string;
    name: string;
    roomIds: string[];
    onOpen?: TransitionAction;
    onClose?: TransitionAction;
  }[];
}

interface RoomRow {
  id: string;
  name: string;
  type: RoomType;
  siteId: string;
  gatewayId: string | null;
  groupId: string | null;
  kind: string;
  memberRoomIds: string[];
}

const ordinary = (rooms: RoomRow[]) => rooms.filter((r) => r.kind !== 'combined');

/**
 * What is wrong with a group, in words. Checks the layout itself and that every room is one this
 * group may use: an ordinary room of the organisation, at the group's site, in no other group, and
 * on the same gateway as the others (they are controlled together, so they must run together).
 */
export async function groupProblems(
  db: GroupDb,
  orgId: string,
  input: GroupInput,
): Promise<string[]> {
  const spec: RoomGroupSpec = {
    roomIds: input.roomIds,
    dividers: input.dividers.map((d, i) => ({
      id: d.id ?? `new${i}`,
      name: d.name,
      roomIds: d.roomIds,
    })),
  };
  const problems = validateGroupSpec(spec);
  const rooms = (await db.room.findMany({
    where: { orgId, id: { in: input.roomIds } },
  })) as unknown as RoomRow[];
  if (rooms.length !== new Set(input.roomIds).size) {
    problems.push('One of those rooms was not found.');
    return problems;
  }
  for (const r of rooms) {
    if (r.kind === 'combined')
      problems.push(`“${r.name}” is a combined room. Choose the ordinary rooms it is made of.`);
    if (r.siteId !== input.siteId) problems.push(`“${r.name}” is at a different site.`);
    if (r.groupId && r.groupId !== input.groupId)
      problems.push(`“${r.name}” is already in another room group.`);
  }
  if (new Set(rooms.map((r) => r.gatewayId ?? '')).size > 1)
    problems.push('Rooms in a group must all run on the same gateway.');
  return [...new Set(problems)];
}

/** Create or update a group and its dividers. Throws the first problem found. */
export async function saveGroup(db: GroupDb, orgId: string, input: GroupInput): Promise<string> {
  const problems = await groupProblems(db, orgId, input);
  if (problems.length > 0) throw new GroupError(problems[0]!, problems);

  let groupId = input.groupId;
  if (groupId) {
    const existing = await db.roomGroup.findFirst({ where: { id: groupId, orgId } });
    if (!existing) throw new GroupError('Group not found');
    await db.roomGroup.update({
      where: { id: groupId },
      data: { name: input.name, siteId: input.siteId },
    });
  } else {
    const created = await db.roomGroup.create({
      data: { orgId, siteId: input.siteId, name: input.name },
    });
    groupId = created.id;
  }

  // Rooms that left the group go back to being ordinary, standalone rooms.
  const before = (await db.room.findMany({
    where: { orgId, groupId, kind: { not: 'combined' } },
  })) as unknown as RoomRow[];
  for (const r of before)
    if (!input.roomIds.includes(r.id))
      await db.room.update({ where: { id: r.id }, data: { groupId: null } });
  for (const id of input.roomIds) await db.room.update({ where: { id }, data: { groupId } });

  const existing = await db.roomDivider.findMany({ where: { groupId } });
  const keep = new Set(input.dividers.map((d) => d.id).filter(Boolean));
  for (const d of existing)
    if (!keep.has(d.id)) await db.roomDivider.delete({ where: { id: d.id } });
  for (const d of input.dividers) {
    if (d.id && existing.some((e) => e.id === d.id))
      await db.roomDivider.update({
        where: { id: d.id },
        data: {
          name: d.name,
          roomIds: d.roomIds,
          ...(d.onOpen ? { onOpen: d.onOpen } : {}),
          ...(d.onClose ? { onClose: d.onClose } : {}),
        },
      });
    else
      await db.roomDivider.create({
        data: {
          groupId,
          name: d.name,
          roomIds: d.roomIds,
          onOpen: d.onOpen ?? DEFAULT_ON_OPEN,
          onClose: d.onClose ?? DEFAULT_ON_CLOSE,
        },
      });
  }
  return groupId;
}

export class GroupError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [message],
  ) {
    super(message);
  }
}

export interface CombinedView {
  key: string;
  roomIds: string[];
  /** e.g. "Room 1 + Room 2". */
  name: string;
  /** The combined Room's id, or null if it has not been created yet. */
  roomId: string | null;
}

export interface GroupView {
  id: string;
  name: string;
  siteId: string;
  rooms: { id: string; name: string; gatewayId: string | null }[];
  dividers: {
    id: string;
    name: string;
    roomIds: string[];
    onOpen: TransitionAction;
    onClose: TransitionAction;
    /** Last reported by the gateway. */
    open: boolean;
  }[];
  combined: CombinedView[];
  /** Combined rooms that exist but that the dividers no longer allow. */
  orphaned: { roomId: string; name: string; deployed: boolean }[];
  truncated: boolean;
  problems: string[];
}

/** A group as the portal shows it: its layout, the combined rooms it implies, and which exist. */
export async function loadGroup(
  db: GroupDb,
  orgId: string,
  groupId: string,
): Promise<GroupView | null> {
  const group = await db.roomGroup.findFirst({ where: { id: groupId, orgId } });
  if (!group) return null;
  const [dividers, all] = await Promise.all([
    db.roomDivider.findMany({ where: { groupId }, orderBy: { createdAt: 'asc' } }),
    db.room.findMany({
      where: { orgId, groupId },
      orderBy: { createdAt: 'asc' },
    }) as unknown as Promise<RoomRow[]>,
  ]);
  const members = ordinary(all);
  const combinedRooms = all.filter((r) => r.kind === 'combined');

  const spec: RoomGroupSpec = {
    roomIds: members.map((r) => r.id),
    dividers: dividers.map((d) => ({ id: d.id, name: d.name, roomIds: d.roomIds })),
  };
  // A room deleted while still in a divider leaves the layout broken; say so.
  const problems = validateGroupSpec(spec);
  const { sets, truncated } = enumerateCombinedRooms(spec);
  const existing = new Map(combinedRooms.map((r) => [combinedKey(r.memberRoomIds), r]));
  const wanted = new Set(sets.map((s) => s.key));

  const orphaned = await Promise.all(
    combinedRooms
      .filter((r) => !wanted.has(combinedKey(r.memberRoomIds)))
      .map(async (r) => ({
        roomId: r.id,
        name: r.name,
        deployed: (await db.release.count({ where: { roomId: r.id } })) > 0,
      })),
  );

  return {
    id: group.id,
    name: group.name,
    siteId: group.siteId,
    rooms: members.map((r) => ({ id: r.id, name: r.name, gatewayId: r.gatewayId })),
    dividers: dividers.map((d) => ({
      id: d.id,
      name: d.name,
      roomIds: d.roomIds,
      onOpen: transition(d.onOpen, DEFAULT_ON_OPEN),
      onClose: transition(d.onClose, DEFAULT_ON_CLOSE),
      open: d.open === true,
    })),
    combined: sets.map((s) => ({
      key: s.key,
      roomIds: s.roomIds,
      name: combinedName(s.roomIds, members),
      roomId: existing.get(s.key)?.id ?? null,
    })),
    orphaned,
    truncated,
    problems: [...new Set(problems)],
  };
}

const transition = (value: unknown, fallback: TransitionAction): TransitionAction => {
  const parsed = TransitionAction.safeParse(value);
  return parsed.success ? parsed.data : fallback;
};

const combinedName = (roomIds: string[], members: { id: string; name: string }[]) =>
  members
    .filter((m) => roomIds.includes(m.id))
    .map((m) => m.name)
    .join(' + ');

export interface SyncResult {
  created: string[];
  /** Combined rooms that could not be created, and why. */
  skipped: { name: string; reason: string }[];
  removed: string[];
  /** Combined rooms the dividers no longer allow, but that have been deployed. */
  kept: string[];
}

/**
 * Bring the group's combined rooms in line with its dividers: create the missing ones with a
 * derived draft, and remove ones that are no longer possible. A combined room that has ever been
 * deployed is never removed here: it is reported so a person retires it on purpose.
 */
export async function syncCombinedRooms(
  db: GroupDb,
  orgId: string,
  groupId: string,
): Promise<SyncResult> {
  const view = await loadGroup(db, orgId, groupId);
  if (!view) throw new GroupError('Group not found');
  if (view.problems.length > 0) throw new GroupError(view.problems[0]!, view.problems);
  if (view.truncated)
    throw new GroupError(
      'This layout makes too many combined rooms. Remove a divider that touches many rooms.',
    );

  const members = (await db.room.findMany({
    where: { orgId, groupId, kind: { not: 'combined' } },
    orderBy: { createdAt: 'asc' },
  })) as unknown as RoomRow[];
  const byId = new Map(members.map((r) => [r.id, r]));
  const result: SyncResult = { created: [], skipped: [], removed: [], kept: [] };

  for (const o of view.orphaned) {
    if (o.deployed) result.kept.push(o.name);
    else {
      await db.room.delete({ where: { id: o.roomId } });
      result.removed.push(o.name);
    }
  }

  for (const c of view.combined) {
    if (c.roomId) continue;
    const parts = c.roomIds.map((id) => byId.get(id)!);
    const taken = new Set<string>();
    const derived: { key: string; name: string; model: RoomModel }[] = [];
    let missing: string | null = null;
    for (const m of parts) {
      const draft = await db.roomDraft.findFirst({ where: { roomId: m.id } });
      const parsed = draft ? RoomModel.safeParse(draft.model) : null;
      if (!parsed?.success) {
        missing = `“${m.name}” has no design yet. Design it, then update the combined rooms.`;
        break;
      }
      const key = memberKey(m.name, taken);
      taken.add(key);
      derived.push({ key, name: m.name, model: parsed.data });
    }
    if (missing) {
      result.skipped.push({ name: c.name, reason: missing });
      continue;
    }
    const first = parts[0]!;
    const room = await db.room.create({
      data: {
        orgId,
        siteId: first.siteId,
        gatewayId: first.gatewayId,
        name: c.name,
        type: first.type,
        groupId,
        kind: 'combined',
        memberRoomIds: c.roomIds,
      },
    });
    await db.roomDraft.create({
      data: {
        orgId,
        roomId: room.id,
        model: deriveCombinedModel(derived) as unknown as Prisma.InputJsonValue,
      },
    });
    result.created.push(c.name);
  }
  return result;
}

/**
 * Delete a group. Its ordinary rooms are kept (they just leave the group). Its combined rooms are
 * deleted, unless one has been deployed: then nothing is deleted and the deployed ones are named.
 */
export async function deleteGroup(
  db: GroupDb,
  orgId: string,
  groupId: string,
): Promise<{ deleted: boolean; deployed: string[] }> {
  const group = await db.roomGroup.findFirst({ where: { id: groupId, orgId } });
  if (!group) throw new GroupError('Group not found');
  const combined = (await db.room.findMany({
    where: { orgId, groupId, kind: 'combined' },
  })) as unknown as RoomRow[];
  const deployed: string[] = [];
  for (const r of combined)
    if ((await db.release.count({ where: { roomId: r.id } })) > 0) deployed.push(r.name);
  if (deployed.length > 0) return { deleted: false, deployed };
  for (const r of combined) await db.room.delete({ where: { id: r.id } });
  await db.room.updateMany({ where: { orgId, groupId }, data: { groupId: null } });
  await db.roomGroup.delete({ where: { id: groupId } });
  return { deleted: true, deployed: [] };
}
