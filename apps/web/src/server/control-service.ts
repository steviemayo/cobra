import type { PrismaClient } from '@kestrel/db';
import {
  ACTUATOR_INTENTS,
  GatewayIntent,
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
/** A webhook is worth waiting for: the gateway may not check in for half a minute. */
export const HOOK_TTL_MS = 5 * 60_000;
export const MAX_HOOKS_PER_MINUTE = 30;
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
  // A phone session (input.by === null) comes from scanning a QR code, a weaker credential than
  // being at the panel in the room, so it may not move a wall, screen or lifter.
  if (input.by === null && ACTUATOR_INTENTS.has(intent.data.type))
    return { ok: false, error: 'Use the room’s own panel to do that' };
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
  // Moving a wall changes what several rooms do, so it is always recorded.
  if (intent.data.type === 'divider.set')
    await db.auditLog.create({
      data: {
        orgId: input.orgId,
        actorId: input.by,
        action: 'wall.set',
        target: intent.data.dividerId,
        meta: { room: room.name, open: intent.data.open },
      },
    });
  return { ok: true };
}

/** Queues a webhook trigger for a room. The gateway picks it up in its next heartbeat. */
export async function queueHook(
  db: ControlDb,
  input: { orgId: string; roomId: string; hookName: string },
  now = new Date(),
): Promise<IntentResult> {
  const room = await db.room.findFirst({ where: { id: input.roomId, orgId: input.orgId } });
  if (!room) return { ok: false, error: 'Room not found' };
  if (!room.gatewayId) return { ok: false, error: 'This room isn’t running on a gateway yet' };
  const parsed = GatewayIntent.safeParse({ type: 'hook', hookName: input.hookName });
  if (!parsed.success) return { ok: false, error: 'Bad webhook name' };
  const recent = await db.controlIntent.count({
    where: { roomId: room.id, createdAt: { gte: new Date(now.getTime() - 60_000) } },
  });
  if (recent >= MAX_HOOKS_PER_MINUTE)
    return { ok: false, error: 'Too many calls, try again in a minute' };
  await db.controlIntent.create({
    data: {
      orgId: input.orgId,
      roomId: room.id,
      gatewayId: room.gatewayId,
      intent: parsed.data as object,
      createdBy: null,
      createdAt: now,
    },
  });
  await db.auditLog.create({
    data: {
      orgId: input.orgId,
      actorId: null,
      action: 'hook.fire',
      target: room.id,
      meta: { room: room.name, hook: input.hookName },
    },
  });
  return { ok: true };
}

/** Asks a room's gateway to run one of its triggers (used for calendar meetings). */
export async function queueTrigger(
  db: ControlDb,
  input: { orgId: string; roomId: string; triggerId: string },
  now = new Date(),
): Promise<IntentResult> {
  const room = await db.room.findFirst({ where: { id: input.roomId, orgId: input.orgId } });
  if (!room?.gatewayId) return { ok: false, error: 'This room isn’t running on a gateway yet' };
  await db.controlIntent.create({
    data: {
      orgId: input.orgId,
      roomId: room.id,
      gatewayId: room.gatewayId,
      intent: { type: 'trigger', triggerId: input.triggerId },
      createdBy: null,
      createdAt: now,
    },
  });
  await db.auditLog.create({
    data: {
      orgId: input.orgId,
      actorId: null,
      action: 'trigger.fire',
      target: room.id,
      meta: { room: room.name, trigger: input.triggerId },
    },
  });
  return { ok: true };
}

/** Whether a webhook is waiting for this gateway, so its next heartbeat can ask it to poll. */
export async function hasWaitingIntents(
  db: ControlDb,
  gatewayId: string,
  now = new Date(),
): Promise<boolean> {
  const n = await db.controlIntent.count({
    where: {
      gatewayId,
      deliveredAt: null,
      createdAt: { gte: new Date(now.getTime() - HOOK_TTL_MS) },
    },
  });
  return n > 0;
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
    const intent = GatewayIntent.safeParse(i.intent);
    const patient =
      intent.success && (intent.data.type === 'hook' || intent.data.type === 'trigger');
    const ttl = patient ? HOOK_TTL_MS : INTENT_TTL_MS;
    if (now.getTime() - (i.createdAt as Date).getTime() > ttl) continue;
    if (intent.success && ownRooms.has(i.roomId))
      fresh.push({ id: i.id, roomId: i.roomId, intent: intent.data });
  }
  return ok({ watch: await watchedRooms(db, gw.id, now), intents: fresh });
}
