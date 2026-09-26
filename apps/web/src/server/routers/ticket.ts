import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { after } from 'next/server';
import { writeAudit } from '../audit';
import { mspFromRoute, mspRoute } from '@kestrel/model';
import { routeForNewTicket } from '../msp';
import { assigneeLabel, assigneesFor, findAssignee } from '../ticket-assignees';
import { SITE_SCOPED, roomIdsInScope, ticketVisible } from '../site-scope';
import { notifyStaff } from '../ticket-notify';
import {
  STAFF_LABEL,
  TicketError,
  escalateTicket,
  slaForTicket,
  visibleComments,
} from '../tickets';
import { orgProcedure, requireRole, router } from '../trpc';

const TEAM = ['owner', 'dev', 'support'] as const;

async function tellStaff(orgId: string, ticketId: string, kind: 'escalated', snippet?: string) {
  const [org, t] = await Promise.all([
    db.org.findFirst({ where: { id: orgId } }),
    db.ticket.findFirst({ where: { id: ticketId, orgId } }),
  ]);
  if (!org || !t) return;
  await notifyStaff({
    kind,
    orgId,
    orgName: org.name,
    ticket: { id: t.id, title: t.title, priority: t.priority, status: t.status },
    snippet,
  });
}

const orgId = z.string().uuid();
const ticketId = z.string().uuid();
const STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

interface TicketCtx {
  orgId: string;
  siteScope: string[] | null;
  viaMsp: { mspOrgId: string } | null;
}

/** The rooms a site-limited caller may see, or null for no limit. */
async function scopedRooms(ctx: TicketCtx): Promise<Set<string> | null> {
  if (ctx.siteScope === null) return null;
  const rooms = await db.room.findMany({
    where: { orgId: ctx.orgId },
    select: { id: true, siteId: true },
  });
  return roomIdsInScope(rooms, ctx.siteScope);
}

/** A ticket by id, or not found. A site-limited provider only finds tickets it may see. */
async function find(ctx: TicketCtx, id: string) {
  const t = await db.ticket.findFirst({ where: { id, orgId: ctx.orgId } });
  if (!t) throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticket not found' });
  const roomIds = await scopedRooms(ctx);
  if (roomIds && !ticketVisible(t, ctx.siteScope, roomIds, ctx.viaMsp?.mspOrgId ?? null))
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticket not found' });
  return t;
}

// Anyone in the org, customers included, can raise and follow a ticket. Only support staff work them.
export const ticketRouter = router({
  list: orgProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        status: z.enum(['active', 'all', ...STATUSES]).default('active'),
        limit: z.number().int().min(1).max(200).default(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const status =
        input.status === 'all'
          ? {}
          : input.status === 'active'
            ? { status: { in: ['open', 'in_progress'] } }
            : { status: input.status };
      const roomIds = await scopedRooms(ctx);
      const rows = await db.ticket.findMany({
        where: {
          orgId: ctx.orgId,
          ...status,
          // A site-limited provider sees tickets about rooms at its sites, and tickets sent to it.
          ...(roomIds && ctx.viaMsp
            ? {
                OR: [{ routedTo: mspRoute(ctx.viaMsp.mspOrgId) }, { roomId: { in: [...roomIds] } }],
              }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
      });
      const rooms = await db.room.findMany({
        where: {
          orgId: ctx.orgId,
          id: { in: [...new Set(rows.flatMap((r) => (r.roomId ? [r.roomId] : [])))] },
        },
        select: { id: true, name: true },
      });
      const roomName = new Map(rooms.map((r) => [r.id, r.name]));
      // Targets are for the people working the requests, not for customer viewers.
      const showSla = ctx.role !== 'customer_viewer';
      const answers =
        showSla && rows.length
          ? await db.ticketComment.findMany({
              where: {
                orgId: ctx.orgId,
                ticketId: { in: rows.map((r) => r.id) },
                visibility: 'public',
              },
              orderBy: { createdAt: 'asc' },
            })
          : [];
      const now = new Date();
      return rows.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        roomId: t.roomId,
        roomName: t.roomId ? (roomName.get(t.roomId) ?? null) : null,
        routedTo: t.routedTo,
        createdByEmail: t.createdByEmail,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        mine: t.createdBy === ctx.user.id,
        sla: showSla
          ? slaForTicket(
              t,
              answers.filter((c) => c.ticketId === t.id),
              now,
            )
          : null,
      }));
    }),

  get: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, ticketId }))
    .query(async ({ ctx, input }) => {
      const t = await find(ctx, input.ticketId);
      const comments = await db.ticketComment.findMany({
        where: { orgId: ctx.orgId, ticketId: t.id },
        orderBy: { createdAt: 'asc' },
      });
      const room = t.roomId
        ? await db.room.findFirst({
            where: { id: t.roomId, orgId: ctx.orgId },
            select: { id: true, name: true },
          })
        : null;
      const assigneeName = t.assignedTo ? await assigneeLabel(db, ctx.orgId, t.assignedTo) : null;
      const providerId = mspFromRoute(t.routedTo);
      const provider = providerId
        ? await db.org.findFirst({ where: { id: providerId }, select: { name: true } })
        : null;
      return {
        id: t.id,
        title: t.title,
        body: t.body,
        providerName: provider?.name ?? null,
        // Whether a service provider that takes tickets is connected, so the team can send it there.
        providerAvailable: (await routeForNewTicket(db, ctx.orgId, t.roomId)) !== 'org',
        status: t.status,
        priority: t.priority,
        room,
        incidentId: t.incidentId,
        routedTo: t.routedTo,
        escalatedAt: t.escalatedAt,
        createdByEmail: t.createdByEmail,
        createdAt: t.createdAt,
        closedAt: t.closedAt,
        assignedTo: t.assignedTo,
        assigneeEmail: assigneeName,
        sla:
          ctx.role === 'customer_viewer'
            ? null
            : slaForTicket(
                t,
                comments.filter((c) => c.visibility === 'public'),
              ),
        // Internal notes are for the organisation's team and Kestrel staff, not its customer viewers.
        // Kestrel staff are shown by role, never by name.
        comments: visibleComments(comments, ctx.role).map((c) => ({
          id: c.id,
          body: c.body,
          visibility: c.visibility,
          fromStaff: c.fromStaff,
          authorEmail: c.fromStaff ? STAFF_LABEL : (c.authorEmail ?? 'Former member'),
          createdAt: c.createdAt,
        })),
      };
    }),

  create: orgProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        title: z.string().trim().min(3).max(150),
        body: z.string().trim().min(1).max(5000),
        roomId: z.string().uuid().optional(),
        incidentId: z.string().uuid().optional(),
        priority: z.enum(PRIORITIES).default('normal'),
        // A problem with Kestrel itself rather than with the organisation's own rooms.
        toKestrel: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Related ids must belong to this org: a ticket can't point at someone else's room. A
      // site-limited provider can only raise tickets about rooms at its sites.
      const scopedRoomIds = await scopedRooms(ctx);
      if (scopedRoomIds && (!input.roomId || !scopedRoomIds.has(input.roomId)))
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Choose a room at one of the sites you look after.',
        });
      if (
        input.roomId &&
        !(await db.room.findFirst({ where: { id: input.roomId, orgId: ctx.orgId } }))
      )
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
      if (input.incidentId) {
        const incident = await db.incident.findFirst({
          where: { id: input.incidentId, orgId: ctx.orgId },
        });
        // A site-limited provider may only link incidents at its sites.
        if (
          !incident ||
          (scopedRoomIds && !(incident.roomId && scopedRoomIds.has(incident.roomId)))
        )
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Incident not found' });
      }
      // Customers can't set urgency above normal, so the urgent queue stays meaningful.
      const priority =
        ctx.role === 'customer_viewer' && input.priority !== 'low' ? 'normal' : input.priority;
      const t = await db.ticket.create({
        data: {
          orgId: ctx.orgId,
          title: input.title,
          body: input.body,
          roomId: input.roomId ?? null,
          incidentId: input.incidentId ?? null,
          priority,
          createdBy: ctx.user.id,
          createdByEmail: ctx.user.email?.toLowerCase() ?? null,
          ...(input.toKestrel
            ? { routedTo: 'kestrel', escalatedAt: new Date(), escalatedBy: ctx.user.id }
            : { routedTo: await routeForNewTicket(db, ctx.orgId, input.roomId) }),
        },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'ticket.create',
        target: t.id,
        meta: { title: t.title, toKestrel: input.toKestrel },
      });
      if (input.toKestrel) after(() => tellStaff(ctx.orgId, t.id, 'escalated', t.body));
      return { id: t.id };
    }),

  comment: orgProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        ticketId,
        body: z.string().trim().min(1).max(5000),
        // Only the organisation's team can write internal notes.
        internal: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const t = await find(ctx, input.ticketId);
      if (input.internal) requireRole(ctx.role, [...TEAM]);
      await db.ticketComment.create({
        data: {
          orgId: ctx.orgId,
          ticketId: t.id,
          authorId: ctx.user.id,
          authorEmail: ctx.user.email?.toLowerCase() ?? null,
          body: input.body,
          visibility: input.internal ? 'internal' : 'public',
        },
      });
      // A reply from the customer on a resolved ticket reopens it.
      const reopen =
        ctx.role === 'customer_viewer' && (t.status === 'resolved' || t.status === 'closed');
      await db.ticket.update({
        where: { id: t.id },
        data: { updatedAt: new Date(), ...(reopen ? { status: 'open', closedAt: null } : {}) },
      });
      return { ok: true };
    }),

  // Move a ticket between the organisation's own team and its service provider.
  route: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, ticketId, to: z.enum(['org', 'provider']) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      const t = await find(ctx, input.ticketId);
      if (t.routedTo === 'kestrel')
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This ticket is with Kestrel support.',
        });
      let routedTo = 'org';
      if (input.to === 'provider') {
        routedTo = await routeForNewTicket(db, ctx.orgId, t.roomId);
        if (routedTo === 'org')
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This organisation has no service provider that takes tickets.',
          });
      }
      await db.ticket.update({ where: { id: t.id }, data: { routedTo, updatedAt: new Date() } });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'ticket.route',
        target: t.id,
        meta: { title: t.title, to: input.to },
      });
      return { ok: true };
    }),

  // The organisation's team sends a ticket to Kestrel support.
  escalate: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, ticketId, note: z.string().trim().max(1000).optional() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, [...TEAM]);
      await find(ctx, input.ticketId);
      try {
        await escalateTicket(db, {
          orgId: ctx.orgId,
          ticketId: input.ticketId,
          by: { userId: ctx.user.id, email: ctx.user.email?.toLowerCase() ?? null },
          note: input.note,
        });
      } catch (e) {
        if (e instanceof TicketError)
          throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
        throw e;
      }
      after(() => tellStaff(ctx.orgId, input.ticketId, 'escalated', input.note));
      return { ok: true };
    }),

  // Who this request can be assigned to: the team, and people from a connected service provider.
  assignees: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, ticketId }))
    .query(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      const t = await find(ctx, input.ticketId);
      return assigneesFor(db, ctx.orgId, t);
    }),

  update: orgProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        ticketId,
        status: z.enum(STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        assignedTo: z.string().uuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const t = await find(ctx, input.ticketId);
      // A customer may close their own ticket; everything else is for staff.
      const ownClose =
        ctx.role === 'customer_viewer' &&
        t.createdBy === ctx.user.id &&
        input.status === 'closed' &&
        input.priority === undefined &&
        input.assignedTo === undefined;
      if (!ownClose) requireRole(ctx.role, ['owner', 'dev', 'support']);
      if (input.assignedTo) {
        // Someone on the organisation's team, or from a service provider that looks after it.
        if (!(await findAssignee(db, ctx.orgId, t, input.assignedTo)))
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Assign tickets to support staff, or to people from your service provider',
          });
      }
      const closing = input.status === 'resolved' || input.status === 'closed';
      await db.ticket.update({
        where: { id: t.id },
        data: {
          ...(input.status ? { status: input.status, closedAt: closing ? new Date() : null } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
          ...(input.assignedTo !== undefined ? { assignedTo: input.assignedTo } : {}),
        },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'ticket.update',
        target: t.id,
        meta: { status: input.status, priority: input.priority, assignedTo: input.assignedTo },
      });
      return { ok: true };
    }),
});
