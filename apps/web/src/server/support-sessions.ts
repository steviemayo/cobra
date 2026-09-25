import type { PrismaClient } from '@kestrel/db';
import { hasStaffRole } from '@kestrel/model';
import { recordStaffAudit, type StaffDb } from './staff';

// Support sessions ("view-as"): a staff member working inside a customer's organisation. Every
// session has a reason and an end time. A read session sees what support sees but cannot change
// anything; an act session can do what support can. The organisation is told when one starts and
// ends, and sees every change made in an act session in its activity log.
export type SessionDb = Pick<
  PrismaClient,
  'supportSession' | 'org' | 'ticket' | 'auditLog' | 'staffAudit'
>;

export class SessionError extends Error {}

export const SESSION_MINUTES = [15, 30, 60, 120] as const;
export type SessionMode = 'read' | 'act';

export interface ActiveSession {
  id: string;
  staffUserId: string;
  orgId: string;
  mode: SessionMode;
  reason: string;
  ticketId: string | null;
  startedAt: Date;
  endsAt: Date;
}

const toActive = (r: {
  id: string;
  staffUserId: string;
  orgId: string;
  mode: string;
  reason: string;
  ticketId: string | null;
  startedAt: Date;
  endsAt: Date;
}): ActiveSession => ({ ...r, mode: r.mode === 'act' ? 'act' : 'read' });

/** The session this staff member has open in this organisation right now, if any. */
export async function activeSession(
  db: SessionDb,
  staffUserId: string,
  orgId: string,
  now = new Date(),
): Promise<ActiveSession | null> {
  const rows = await db.supportSession.findMany({
    where: { staffUserId, orgId, endedAt: null },
    orderBy: { startedAt: 'desc' },
  });
  const live = rows.find((r) => r.endsAt.getTime() > now.getTime());
  return live ? toActive(live) : null;
}

/** Whichever session this staff member has open, in any organisation. */
export async function currentSession(
  db: SessionDb,
  staffUserId: string,
  now = new Date(),
): Promise<ActiveSession | null> {
  const rows = await db.supportSession.findMany({
    where: { staffUserId, endedAt: null },
    orderBy: { startedAt: 'desc' },
  });
  const live = rows.find((r) => r.endsAt.getTime() > now.getTime());
  return live ? toActive(live) : null;
}

/**
 * What a support session may do with a call: reading is always allowed; a change is refused in a
 * read session and allowed (and logged) in an act session.
 */
export function sessionGate(
  mode: SessionMode,
  kind: 'query' | 'mutation' | 'subscription',
): 'allow' | 'log' | 'deny' {
  if (kind !== 'mutation') return 'allow';
  return mode === 'act' ? 'log' : 'deny';
}

export interface StartInput {
  orgId: string;
  mode: SessionMode;
  reason: string;
  minutes: number;
  /** One of the organisation's open tickets. Required if the organisation blocks staff access. */
  ticketId?: string | null;
}

export async function startSession(
  db: SessionDb,
  args: { staff: { userId: string; roles: string[] }; input: StartInput; now?: Date },
): Promise<{ id: string; endsAt: Date }> {
  const now = args.now ?? new Date();
  const { staff, input } = args;
  const reason = input.reason?.trim() ?? '';
  if (reason.length < 5) throw new SessionError('Give a reason of at least 5 characters.');
  if (reason.length > 500) throw new SessionError('Keep the reason under 500 characters.');
  if (!(SESSION_MINUTES as readonly number[]).includes(input.minutes))
    throw new SessionError('Choose 15, 30, 60 or 120 minutes.');
  if (input.mode === 'act' && !hasStaffRole(staff.roles, 'support'))
    throw new SessionError('Acting inside an organisation needs the support role.');
  if (!hasStaffRole(staff.roles, 'readonly')) throw new SessionError('Not allowed.');

  const org = await db.org.findFirst({ where: { id: input.orgId } });
  if (!org) throw new SessionError('Organisation not found.');

  // A linked ticket is the customer's own request for help, so it is consent.
  let ticketId: string | null = null;
  if (input.ticketId) {
    const ticket = await db.ticket.findFirst({
      where: { id: input.ticketId, orgId: input.orgId },
    });
    if (!ticket) throw new SessionError('That ticket is not one of this organisation’s.');
    if (ticket.status !== 'open') throw new SessionError('That ticket is not open.');
    ticketId = ticket.id;
  }
  if (org.staffAccessBlocked && !ticketId)
    throw new SessionError(
      'This organisation has blocked staff access. Link one of its open support tickets to continue.',
    );

  // One session at a time: opening another ends the last.
  const open = await db.supportSession.findMany({
    where: { staffUserId: staff.userId, endedAt: null },
  });
  for (const o of open)
    await db.supportSession.update({ where: { id: o.id }, data: { endedAt: now } });

  const endsAt = new Date(now.getTime() + input.minutes * 60_000);
  const row = await db.supportSession.create({
    data: {
      staffUserId: staff.userId,
      orgId: input.orgId,
      mode: input.mode,
      reason,
      ticketId,
      endsAt,
    },
  });
  // What the customer sees. Unlike a licence adjustment, the reason is shown: it is support work
  // done inside their organisation, and they should know why.
  await db.auditLog.create({
    data: {
      orgId: input.orgId,
      actorId: null,
      action: 'staff.session.start',
      target: row.id,
      meta: { staff: true, mode: input.mode, minutes: input.minutes, reason, ticketId },
    },
  });
  await recordStaffAudit(db as unknown as StaffDb, {
    staffUserId: staff.userId,
    action: 'session.start',
    orgId: input.orgId,
    target: row.id,
    meta: { mode: input.mode, minutes: input.minutes, reason, ticketId },
  });
  return { id: row.id, endsAt };
}

export async function endSession(
  db: SessionDb,
  args: { sessionId: string; staffUserId: string; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  const row = await db.supportSession.findFirst({
    where: { id: args.sessionId, staffUserId: args.staffUserId },
  });
  if (!row || row.endedAt) return;
  await db.supportSession.update({ where: { id: row.id }, data: { endedAt: now } });
  await db.auditLog.create({
    data: {
      orgId: row.orgId,
      actorId: null,
      action: 'staff.session.end',
      target: row.id,
      meta: { staff: true, mode: row.mode },
    },
  });
  await recordStaffAudit(db as unknown as StaffDb, {
    staffUserId: args.staffUserId,
    action: 'session.end',
    orgId: row.orgId,
    target: row.id,
  });
}

/** Written for every change a staff member makes in an act session, and for refused attempts in a read one. */
export async function logSessionAction(
  db: SessionDb,
  session: { id: string; staffUserId: string; orgId: string },
  action: 'session.act' | 'session.blocked',
  procedure: string,
): Promise<void> {
  await recordStaffAudit(db as unknown as StaffDb, {
    staffUserId: session.staffUserId,
    action,
    orgId: session.orgId,
    target: session.id,
    meta: { procedure },
  });
}

/** Owners can require a ticket before staff may open a session in their organisation. */
export async function setStaffAccessBlocked(
  db: SessionDb,
  args: { orgId: string; blocked: boolean; actorId: string },
): Promise<void> {
  await db.org.update({ where: { id: args.orgId }, data: { staffAccessBlocked: args.blocked } });
  await db.auditLog.create({
    data: {
      orgId: args.orgId,
      actorId: args.actorId,
      action: 'org.staff_access',
      target: args.orgId,
      meta: { blocked: args.blocked },
    },
  });
}

/** Open tickets of an organisation, for linking to a session. */
export async function openTickets(
  db: SessionDb,
  orgId: string,
): Promise<{ id: string; title: string }[]> {
  const rows = await db.ticket.findMany({
    where: { orgId, status: 'open' },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });
  return rows.map((t) => ({ id: t.id, title: t.title }));
}
