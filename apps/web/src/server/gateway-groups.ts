import type { PrismaClient } from '@kestrel/db';
import {
  DEFAULT_ON_CLOSE,
  DEFAULT_ON_OPEN,
  TransitionAction,
  type DividerReport,
  type GroupConfig,
} from '@kestrel/model';

// What a gateway needs to know about room groups: the rooms, the movable walls between them and
// the combined rooms that stand in while walls are open. The gateway owns which walls are open;
// the cloud only keeps the definition and the last reported state.
export type GatewayGroupDb = Pick<PrismaClient, 'room' | 'roomGroup' | 'roomDivider'>;

const action = (value: unknown, fallback: TransitionAction): TransitionAction => {
  const parsed = TransitionAction.safeParse(value);
  return parsed.success ? parsed.data : fallback;
};

/**
 * The groups a gateway should run: those whose ordinary rooms all run on it (a group is controlled
 * together, so it cannot be split across gateways). Combined rooms on other gateways are left out.
 */
export async function groupsForGateway(
  db: GatewayGroupDb,
  gateway: { id: string; orgId: string },
): Promise<GroupConfig[]> {
  const own = (await db.room.findMany({
    where: { orgId: gateway.orgId, gatewayId: gateway.id },
  })) as { groupId: string | null }[];
  const groupIds = [...new Set(own.flatMap((r) => (r.groupId ? [r.groupId] : [])))];
  if (groupIds.length === 0) return [];

  const [groups, rooms, dividers] = await Promise.all([
    db.roomGroup.findMany({ where: { orgId: gateway.orgId, id: { in: groupIds } } }),
    db.room.findMany({ where: { orgId: gateway.orgId, groupId: { in: groupIds } } }),
    db.roomDivider.findMany({
      where: { groupId: { in: groupIds } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const out: GroupConfig[] = [];
  for (const g of groups) {
    const all = rooms.filter((r) => r.groupId === g.id);
    const members = all.filter((r) => r.kind !== 'combined');
    if (members.length < 2 || members.some((r) => r.gatewayId !== gateway.id)) continue;
    out.push({
      id: g.id,
      name: g.name,
      roomIds: members.map((r) => r.id),
      dividers: dividers
        .filter((d) => d.groupId === g.id)
        .map((d) => ({
          id: d.id,
          name: d.name,
          roomIds: d.roomIds,
          onOpen: action(d.onOpen, DEFAULT_ON_OPEN),
          onClose: action(d.onClose, DEFAULT_ON_CLOSE),
        })),
      combined: all
        .filter((r) => r.kind === 'combined' && r.gatewayId === gateway.id)
        .map((r) => ({ roomId: r.id, memberRoomIds: r.memberRoomIds })),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Records which walls a gateway says are open. It can only speak for walls in its own groups. */
export async function recordDividers(
  db: GatewayGroupDb,
  gateway: { id: string; orgId: string },
  reports: DividerReport[],
): Promise<void> {
  if (reports.length === 0) return;
  const own = new Set(
    (await groupsForGateway(db, gateway)).flatMap((g) => g.dividers.map((d) => d.id)),
  );
  for (const r of reports)
    if (own.has(r.id))
      await db.roomDivider.updateMany({ where: { id: r.id }, data: { open: r.open } });
}
