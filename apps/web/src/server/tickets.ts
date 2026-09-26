import type { PrismaClient } from '@kestrel/db';
import { firstResponseAt, ticketSla, type OrgRole, type TicketSla } from '@kestrel/model';
import { recordStaffAudit, type StaffDb } from './staff';

// Support tickets and who they are with. A ticket starts with the organisation's own team. Anyone
// on that team can escalate it to Kestrel, which puts it in the staff queue; Kestrel can hand it
// back. (Later, a ticket can also be routed to an MSP: "msp:<org id>".) Functions take the
// database as a parameter so they can be tested without one.
export type TicketDb = Pick<
  PrismaClient,
  'ticket' | 'ticketComment' | 'org' | 'room' | 'auditLog' | 'staffAudit' | 'staffUser'
>;

export class TicketError extends Error {}

export const ROUTED_ORG = 'org';
export const ROUTED_KESTREL = 'kestrel';
export const STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketStatus = (typeof STATUSES)[number];
export type TicketPriority = (typeof PRIORITIES)[number];
export const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export type CommentVisibility = 'public' | 'internal';

/**
 * Where a ticket stands against its response and resolution targets. With Kestrel the clock runs
 * from the escalation and only a Kestrel reply answers it; otherwise it runs from when the ticket
 * was raised (for a ticket sent to a provider that is an approximation) and any reply from someone
 * other than the person who raised it answers it.
 */
export function slaForTicket(
  t: {
    priority: string;
    createdAt: Date;
    escalatedAt: Date | null;
    closedAt: Date | null;
    createdBy: string | null;
    routedTo: string;
  },
  comments: { authorId: string | null; fromStaff: boolean; visibility: string; createdAt: Date }[],
  now = new Date(),
): TicketSla {
  const withKestrel = t.routedTo === ROUTED_KESTREL;
  const startedAt = withKestrel ? (t.escalatedAt ?? t.createdAt) : t.createdAt;
  const respondedAt = firstResponseAt(
    t,
    withKestrel ? comments.filter((c) => c.fromStaff) : comments,
    withKestrel ? startedAt : null,
  );
  return ticketSla({ priority: t.priority, startedAt, respondedAt, closedAt: t.closedAt, now });
}

/** Overdue first, then due soon, then the rest: used to order queues within a priority. */
export const slaUrgency = (sla: TicketSla): number =>
  sla.next?.clock.state === 'overdue' ? 0 : sla.next?.clock.state === 'due_soon' ? 1 : 2;

/** What the organisation's people see as the author of a comment: staff are "Kestrel support", by role not name. */
export const STAFF_LABEL = 'Kestrel support';

const TEAM_ROLES: OrgRole[] = ['owner', 'dev', 'support'];

/**
 * The comments a person may see. Internal ones are for the organisation's own team and Kestrel
 * staff: the organisation's customer viewers never see them.
 */
export function visibleComments<T extends { visibility: string }>(
  comments: T[],
  role: OrgRole,
): T[] {
  return TEAM_ROLES.includes(role) ? comments : comments.filter((c) => c.visibility !== 'internal');
}

// ---- Escalating and handing back -----------------------------------------------------------------

/** The organisation's team sends a ticket to Kestrel support. */
export async function escalateTicket(
  db: TicketDb,
  args: {
    orgId: string;
    ticketId: string;
    by: { userId: string; email: string | null };
    note?: string;
    now?: Date;
  },
): Promise<void> {
  const now = args.now ?? new Date();
  const t = await db.ticket.findFirst({ where: { id: args.ticketId, orgId: args.orgId } });
  if (!t) throw new TicketError('Ticket not found.');
  if (t.routedTo === ROUTED_KESTREL) throw new TicketError('This ticket is already with Kestrel.');
  if (t.status === 'closed') throw new TicketError('Reopen the ticket before escalating it.');
  const note = args.note?.trim().slice(0, 1000);

  await db.ticket.update({
    where: { id: t.id },
    data: {
      routedTo: ROUTED_KESTREL,
      escalatedAt: now,
      escalatedBy: args.by.userId,
      updatedAt: now,
      // A resolved ticket that needs Kestrel again is open again.
      ...(t.status === 'resolved' ? { status: 'open', closedAt: null } : {}),
    },
  });
  await db.ticketComment.create({
    data: {
      orgId: args.orgId,
      ticketId: t.id,
      authorId: args.by.userId,
      authorEmail: args.by.email,
      body: note ? `Escalated to Kestrel support: ${note}` : 'Escalated to Kestrel support.',
      visibility: 'public',
    },
  });
  await db.auditLog.create({
    data: {
      orgId: args.orgId,
      actorId: args.by.userId,
      action: 'ticket.escalate',
      target: t.id,
      meta: { title: t.title },
    },
  });
}

/** Kestrel staff give a ticket back to the organisation's team. */
export async function handBack(
  db: TicketDb,
  args: {
    ticketId: string;
    staff: { userId: string; email: string | null };
    note?: string;
    now?: Date;
  },
): Promise<void> {
  const now = args.now ?? new Date();
  const t = await ticketWithKestrel(db, args.ticketId);
  const note = args.note?.trim().slice(0, 1000);
  await db.ticket.update({
    where: { id: t.id },
    data: { routedTo: ROUTED_ORG, staffAssignee: null, updatedAt: now },
  });
  await db.ticketComment.create({
    data: {
      orgId: t.orgId,
      ticketId: t.id,
      authorId: args.staff.userId,
      authorEmail: args.staff.email,
      fromStaff: true,
      body: note
        ? `Kestrel support handed this back to your team: ${note}`
        : 'Kestrel support handed this back to your team.',
      visibility: 'public',
    },
  });
  await db.auditLog.create({
    data: {
      orgId: t.orgId,
      actorId: null,
      action: 'ticket.handback',
      target: t.id,
      meta: { staff: true, title: t.title },
    },
  });
  await recordStaffAudit(db as unknown as StaffDb, {
    staffUserId: args.staff.userId,
    action: 'ticket.handback',
    orgId: t.orgId,
    target: t.id,
  });
}

async function ticketWithKestrel(db: TicketDb, ticketId: string) {
  const t = await db.ticket.findFirst({ where: { id: ticketId } });
  if (!t) throw new TicketError('Ticket not found.');
  if (t.routedTo !== ROUTED_KESTREL)
    throw new TicketError('This ticket is with the organisation’s team, not with Kestrel.');
  return t;
}

// ---- The staff queue -----------------------------------------------------------------------------

export interface QueueRow {
  id: string;
  title: string;
  orgId: string;
  orgName: string;
  status: string;
  priority: string;
  createdAt: Date;
  escalatedAt: Date | null;
  updatedAt: Date;
  assignee: string | null;
  /** Who has to answer next: Kestrel (the customer spoke last) or the organisation. */
  awaiting: 'kestrel' | 'org';
  /** Against Kestrel's response and resolution targets, from the escalation. */
  sla: TicketSla;
}

export interface QueueFilter {
  /** active: open and in progress. all: everything. Otherwise one status. */
  status?: 'active' | 'all' | TicketStatus;
  priority?: TicketPriority;
  orgId?: string;
}

/** Tickets with Kestrel across every organisation: most urgent first, then longest waiting. */
export async function staffQueue(
  db: TicketDb,
  filter: QueueFilter = {},
  now = new Date(),
): Promise<QueueRow[]> {
  const status = filter.status ?? 'active';
  const rows = await db.ticket.findMany({
    where: {
      routedTo: ROUTED_KESTREL,
      ...(filter.orgId ? { orgId: filter.orgId } : {}),
      ...(filter.priority ? { priority: filter.priority } : {}),
      ...(status === 'all'
        ? {}
        : status === 'active'
          ? { status: { in: ['open', 'in_progress'] } }
          : { status }),
    },
  });
  if (rows.length === 0) return [];
  const [orgs, staff, comments] = await Promise.all([
    db.org.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.orgId))] } } }),
    db.staffUser.findMany({}),
    db.ticketComment.findMany({
      where: { ticketId: { in: rows.map((r) => r.id) }, visibility: 'public' },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const email = new Map(staff.map((s) => [s.userId, s.email]));
  const lastPublic = new Map<string, { fromStaff: boolean }>();
  for (const c of comments) lastPublic.set(c.ticketId, { fromStaff: c.fromStaff });

  return rows
    .map((t): QueueRow => ({
      id: t.id,
      title: t.title,
      orgId: t.orgId,
      orgName: orgName.get(t.orgId) ?? 'Unknown organisation',
      status: t.status,
      priority: t.priority,
      createdAt: t.createdAt,
      escalatedAt: t.escalatedAt,
      updatedAt: t.updatedAt,
      assignee: t.staffAssignee ? (email.get(t.staffAssignee) ?? 'Staff') : null,
      awaiting: lastPublic.get(t.id)?.fromStaff ? 'org' : 'kestrel',
      sla: slaForTicket(
        t,
        comments.filter((c) => c.ticketId === t.id),
        now,
      ),
    }))
    .sort(
      (a, b) =>
        (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
        slaUrgency(a.sla) - slaUrgency(b.sla) ||
        (a.escalatedAt ?? a.createdAt).getTime() - (b.escalatedAt ?? b.createdAt).getTime(),
    );
}

export interface StaffTicketView {
  id: string;
  title: string;
  body: string;
  orgId: string;
  orgName: string;
  roomName: string | null;
  status: string;
  priority: string;
  routedTo: string;
  createdByEmail: string | null;
  createdAt: Date;
  escalatedAt: Date | null;
  assignee: string | null;
  assignedToMe: boolean;
  sla: TicketSla;
  comments: {
    id: string;
    body: string;
    visibility: string;
    fromStaff: boolean;
    author: string;
    createdAt: Date;
  }[];
}

/** One ticket as staff see it, with internal comments. Any ticket, so staff can follow an escalation's history. */
export async function staffTicket(
  db: TicketDb,
  ticketId: string,
  viewerId: string,
): Promise<StaffTicketView | null> {
  const t = await db.ticket.findFirst({ where: { id: ticketId } });
  if (!t) return null;
  const [org, room, comments, staff] = await Promise.all([
    db.org.findFirst({ where: { id: t.orgId } }),
    t.roomId ? db.room.findFirst({ where: { id: t.roomId, orgId: t.orgId } }) : null,
    db.ticketComment.findMany({ where: { ticketId: t.id }, orderBy: { createdAt: 'asc' } }),
    db.staffUser.findMany({}),
  ]);
  const email = new Map(staff.map((s) => [s.userId, s.email]));
  return {
    id: t.id,
    title: t.title,
    body: t.body,
    orgId: t.orgId,
    orgName: org?.name ?? 'Unknown organisation',
    roomName: room?.name ?? null,
    status: t.status,
    priority: t.priority,
    routedTo: t.routedTo,
    createdByEmail: t.createdByEmail,
    createdAt: t.createdAt,
    escalatedAt: t.escalatedAt,
    assignee: t.staffAssignee ? (email.get(t.staffAssignee) ?? 'Staff') : null,
    assignedToMe: t.staffAssignee === viewerId,
    sla: slaForTicket(t, comments),
    comments: comments.map((c) => ({
      id: c.id,
      body: c.body,
      visibility: c.visibility,
      fromStaff: c.fromStaff,
      author: c.fromStaff
        ? (email.get(c.authorId ?? '') ?? STAFF_LABEL)
        : (c.authorEmail ?? 'Former member'),
      createdAt: c.createdAt,
    })),
  };
}

// ---- Staff working a ticket ----------------------------------------------------------------------

/** A reply or an internal note. The first reply takes the ticket for that staff member. */
export async function staffComment(
  db: TicketDb,
  args: {
    ticketId: string;
    staff: { userId: string; email: string | null };
    body: string;
    visibility: CommentVisibility;
    now?: Date;
  },
): Promise<{ visibility: CommentVisibility; orgId: string }> {
  const now = args.now ?? new Date();
  const body = args.body.trim();
  if (!body) throw new TicketError('Write something first.');
  if (body.length > 5000) throw new TicketError('Keep a comment under 5000 characters.');
  const t = await ticketWithKestrel(db, args.ticketId);
  await db.ticketComment.create({
    data: {
      orgId: t.orgId,
      ticketId: t.id,
      authorId: args.staff.userId,
      authorEmail: args.staff.email,
      fromStaff: true,
      body,
      visibility: args.visibility,
    },
  });
  await db.ticket.update({
    where: { id: t.id },
    data: { updatedAt: now, ...(t.staffAssignee ? {} : { staffAssignee: args.staff.userId }) },
  });
  await recordStaffAudit(db as unknown as StaffDb, {
    staffUserId: args.staff.userId,
    action: 'ticket.comment',
    orgId: t.orgId,
    target: t.id,
    meta: { visibility: args.visibility },
  });
  return { visibility: args.visibility, orgId: t.orgId };
}

export async function staffUpdate(
  db: TicketDb,
  args: {
    ticketId: string;
    staff: { userId: string; email: string | null };
    status?: TicketStatus;
    priority?: TicketPriority;
    /** true: take it; false: let it go. */
    assignToMe?: boolean;
    now?: Date;
  },
): Promise<{ orgId: string; statusChanged: boolean }> {
  const now = args.now ?? new Date();
  const t = await ticketWithKestrel(db, args.ticketId);
  const statusBefore = t.status;
  if (args.status && !STATUSES.includes(args.status)) throw new TicketError('Unknown status.');
  if (args.priority && !PRIORITIES.includes(args.priority))
    throw new TicketError('Unknown priority.');
  const closing = args.status === 'resolved' || args.status === 'closed';
  await db.ticket.update({
    where: { id: t.id },
    data: {
      updatedAt: now,
      ...(args.status ? { status: args.status, closedAt: closing ? now : null } : {}),
      ...(args.priority ? { priority: args.priority } : {}),
      ...(args.assignToMe === undefined
        ? {}
        : { staffAssignee: args.assignToMe ? args.staff.userId : null }),
    },
  });
  // The organisation sees status and priority changes in its activity log; who has the ticket
  // inside Kestrel is internal.
  if (args.status || args.priority)
    await db.auditLog.create({
      data: {
        orgId: t.orgId,
        actorId: null,
        action: 'ticket.update',
        target: t.id,
        meta: { staff: true, status: args.status, priority: args.priority },
      },
    });
  await recordStaffAudit(db as unknown as StaffDb, {
    staffUserId: args.staff.userId,
    action: 'ticket.update',
    orgId: t.orgId,
    target: t.id,
    meta: { status: args.status, priority: args.priority, assignToMe: args.assignToMe },
  });
  return { orgId: t.orgId, statusChanged: !!args.status && args.status !== statusBefore };
}
