import type { PrismaClient } from '@kestrel/db';
import {
  PanelIntent,
  PanelViewModel,
  PollRequest,
  type ControlIntentMessage,
} from '@kestrel/model';

// Controlling a room from the portal. The gateway never accepts inbound connections, so the portal
// and the gateway meet in the database: the browser leaves intents and reads the latest panel state,
// and the gateway, polling fast while someone is watching, sends the state and takes the intents.
export type ControlDb = Pick<
  PrismaClient,
  'controlSession' | 'controlIntent' | 'room' | 'auditLog'
>;

/** A room counts as being watched this long after its control page last asked for it. */
export const WATCH_TTL_MS = 30_000;
/** Snapshots older than this are shown as "reconnecting". */
export const LIVE_MS = 8_000;
/** Intents the gateway did not collect within this long are dropped: nobody wants last minute's volume press. */
export const INTENT_TTL_MS = 15_000;
export const MAX_INTENTS_PER_10S = 40;

const ok = (body: unknown) => ({ status: 200, body });
const fail = (status: number, error: string) => ({ status, body: { error } });

async function touch(db: ControlDb, orgId: string, roomId: string, now: Date) {
  const existing = await db.controlSession.findFirst({ where: { roomId } });
  if (existing) {
    await db.controlSession.update({ where: { id: existing.id }, data: { lastActiveAt: now } });
    return existing;
  }
  return db.controlSession.create({ data: { orgId, roomId, lastActiveAt: now } });
}

/** What the portal shows for a room: the latest panel state, and whether it is fresh. */
export async function portalSnapshot(
  db: ControlDb,
  input: { orgId: string; roomId: string },
  now = new Date(),
) {
  const room = await db.room.findFirst({ where: { id: input.roomId, orgId: input.orgId } });
  if (!room) return null;
  const session = await touch(db, input.orgId, room.id, now);
  const parsed = PanelViewModel.safeParse(session.snapshot);
  const at = session.snapshotAt as Date | null;
  return {
    hasGateway: !!room.gatewayId,
    vm: parsed.success ? parsed.data : null,
    live: !!at && now.getTime() - at.getTime() <= LIVE_MS && parsed.success,
  };
}

export type IntentResult = { ok: true } | { ok: false; error: string };

export async function portalIntent(
  db: ControlDb,
  input: { orgId: string; roomId: string; intent: unknown; by: string | null },
  now = new Date(),
): Promise<IntentResult> {
  const intent = PanelIntent.safeParse(input.intent);
  if (!intent.success) return { ok: false, error: 'That isn’t something a panel can do' };
  const room = await db.room.findFirst({ where: { id: input.roomId, orgId: input.orgId } });
  if (!room) return { ok: false, error: 'Room not found' };
  if (!room.gatewayId) return { ok: false, error: 'This room isn’t running on a gateway yet' };
  const recent = await db.controlIntent.count({
    where: { roomId: room.id, createdAt: { gte: new Date(now.getTime() - 10_000) } },
  });
  if (recent >= MAX_INTENTS_PER_10S) return { ok: false, error: 'Slow down a little' };

  await db.controlIntent.create({
    data: {
      orgId: input.orgId,
      roomId: room.id,
      gatewayId: room.gatewayId,
      intent: intent.data as object,
      createdBy: input.by,
      createdAt: now,
    },
  });
  await touch(db, input.orgId, room.id, now);
  // Starting and stopping things is worth a record; volume nudges are not.
  if (intent.data.type === 'activity.start' || intent.data.type === 'activity.stop')
    await db.auditLog.create({
      data: {
        orgId: input.orgId,
        actorId: input.by,
        action: 'control.intent',
        target: room.id,
        meta: { room: room.name, intent: intent.data.type, activityId: intent.data.activityId },
      },
    });
  return { ok: true };
}

/** Rooms of this gateway that someone is controlling right now. */
export async function watchedRooms(
  db: ControlDb,
  gatewayId: string,
  now = new Date(),
): Promise<string[]> {
  const rooms = await db.room.findMany({ where: { gatewayId } });
  if (rooms.length === 0) return [];
  const sessions = await db.controlSession.findMany({
    where: {
      roomId: { in: rooms.map((r) => r.id) },
      lastActiveAt: { gte: new Date(now.getTime() - WATCH_TTL_MS) },
    },
  });
  return sessions.map((s) => s.roomId);
}

/** The gateway's fast poll: takes its rooms' panel state, hands back waiting intents. */
export async function poll(
  db: ControlDb,
  gw: { id: string; orgId: string },
  raw: unknown,
  now = new Date(),
) {
  const parsed = PollRequest.safeParse(raw);
  if (!parsed.success) return fail(400, 'Bad poll');
  const ownRooms = new Set(
    (await db.room.findMany({ where: { gatewayId: gw.id } })).map((r) => r.id),
  );

  for (const p of parsed.data.panels) {
    if (!ownRooms.has(p.roomId)) continue;
    await db.controlSession.updateMany({
      where: { roomId: p.roomId },
      data: { snapshot: p.vm as object, snapshotAt: now },
    });
  }

  const waiting = await db.controlIntent.findMany({
    where: { gatewayId: gw.id, deliveredAt: null },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  const fresh: ControlIntentMessage[] = [];
  for (const i of waiting) {
    // Claim before sending, so a second poll racing this one can't get the same intent.
    const { count } = await db.controlIntent.updateMany({
      where: { id: i.id, deliveredAt: null },
      data: { deliveredAt: now },
    });
    if (count === 0) continue;
    if (now.getTime() - (i.createdAt as Date).getTime() > INTENT_TTL_MS) continue;
    const intent = PanelIntent.safeParse(i.intent);
    if (intent.success && ownRooms.has(i.roomId))
      fresh.push({ id: i.id, roomId: i.roomId, intent: intent.data });
  }
  return ok({ watch: await watchedRooms(db, gw.id, now), intents: fresh });
}
