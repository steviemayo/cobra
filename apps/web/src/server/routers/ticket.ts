import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { writeAudit } from '../audit';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const ticketId = z.string().uuid();
const STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

async function find(ctxOrgId: string, id: string) {
  const t = await db.ticket.findFirst({ where: { id, orgId: ctxOrgId } });
  if (!t) throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticket not found' });
  return t;
}

// Anyone in the org, customers included, can raise and follow a ticket. Only support staff work them.
export const ticketRouter = router({
  list: orgProcedure
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
      const rows = await db.ticket.findMany({
        where: { orgId: ctx.orgId, ...status },
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
      return rows.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        roomId: t.roomId,
        roomName: t.roomId ? (roomName.get(t.roomId) ?? null) : null,
        createdByEmail: t.createdByEmail,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        mine: t.createdBy === ctx.user.id,
      }));
    }),

  get: orgProcedure.input(z.object({ orgId, ticketId })).query(async ({ ctx, input }) => {
    const t = await find(ctx.orgId, input.ticketId);
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
    const assignee = t.assignedTo
      ? await db.member.findFirst({
          where: { orgId: ctx.orgId, userId: t.assignedTo },
          select: { email: true },
        })
      : null;
    return {
      id: t.id,
      title: t.title,
      body: t.body,
      status: t.status,
      priority: t.priority,
      room,
      incidentId: t.incidentId,
      createdByEmail: t.createdByEmail,
      createdAt: t.createdAt,
      closedAt: t.closedAt,
      assignedTo: t.assignedTo,
      assigneeEmail: assignee?.email ?? null,
      comments: comments.map((c) => ({
        id: c.id,
        body: c.body,
        authorEmail: c.authorEmail ?? 'Former member',
        createdAt: c.createdAt,
      })),
    };
  }),

  create: orgProcedure
    .input(
      z.object({
        orgId,
        title: z.string().trim().min(3).max(150),
        body: z.string().trim().min(1).max(5000),
        roomId: z.string().uuid().optional(),
        incidentId: z.string().uuid().optional(),
        priority: z.enum(PRIORITIES).default('normal'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Related ids must belong to this org: a ticket can't point at someone else's room.
      if (
        input.roomId &&
        !(await db.room.findFirst({ where: { id: input.roomId, orgId: ctx.orgId } }))
      )
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Room not found' });
      if (
        input.incidentId &&
        !(await db.incident.findFirst({ where: { id: input.incidentId, orgId: ctx.orgId } }))
      )
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Incident not found' });
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
        },
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'ticket.create',
        target: t.id,
        meta: { title: t.title },
      });
      return { id: t.id };
    }),

  comment: orgProcedure
    .input(z.object({ orgId, ticketId, body: z.string().trim().min(1).max(5000) }))
    .mutation(async ({ ctx, input }) => {
      const t = await find(ctx.orgId, input.ticketId);
      await db.ticketComment.create({
        data: {
          orgId: ctx.orgId,
          ticketId: t.id,
          authorId: ctx.user.id,
          authorEmail: ctx.user.email?.toLowerCase() ?? null,
          body: input.body,
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

  update: orgProcedure
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
      const t = await find(ctx.orgId, input.ticketId);
      // A customer may close their own ticket; everything else is for staff.
      const ownClose =
        ctx.role === 'customer_viewer' &&
        t.createdBy === ctx.user.id &&
        input.status === 'closed' &&
        input.priority === undefined &&
        input.assignedTo === undefined;
      if (!ownClose) requireRole(ctx.role, ['owner', 'dev', 'support']);
      if (input.assignedTo) {
        const m = await db.member.findFirst({
          where: { orgId: ctx.orgId, userId: input.assignedTo },
        });
        if (!m || m.role === 'customer_viewer')
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Assign tickets to support staff' });
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
