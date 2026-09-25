import { z } from 'zod';
import { after } from 'next/server';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { orgDetail, orgDirectory, recordStaffAudit, mfaRequired } from '../staff';
import { notifyOrg } from '../ticket-notify';
import {
  PRIORITIES,
  STATUSES,
  TicketError,
  handBack,
  staffComment,
  staffQueue,
  staffTicket,
  staffUpdate,
} from '../tickets';
import {
  SESSION_MINUTES,
  SessionError,
  currentSession,
  endSession,
  openTickets,
  startSession,
} from '../support-sessions';
import {
  LicenceError,
  addNote,
  licenceState,
  listNotes,
  revokeOverride,
  setOverride,
} from '../staff-licences';
import {
  requireAnyStaffRole,
  requireStaffRole,
  router,
  staffIdentityProcedure,
  staffProcedure,
} from '../trpc';

function asTrpc(e: unknown): never {
  if (e instanceof LicenceError || e instanceof SessionError || e instanceof TicketError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
  throw e;
}

const orgId = z.string().uuid();

/** Tell the organisation's Teams and webhook channels about something Kestrel did on its ticket. */
async function tellOrg(
  ownerOrgId: string,
  ticketId: string,
  kind: 'staff_reply' | 'status_changed' | 'handed_back',
  snippet?: string,
) {
  const [org, t] = await Promise.all([
    db.org.findFirst({ where: { id: ownerOrgId } }),
    db.ticket.findFirst({ where: { id: ticketId } }),
  ]);
  if (!org || !t) return;
  await notifyOrg(db, {
    kind,
    orgId: ownerOrgId,
    orgName: org.name,
    ticket: { id: t.id, title: t.title, priority: t.priority, status: t.status },
    snippet,
  });
}

// Everything under /staff. These procedures are not limited to one organisation: they only exist
// for Kestrel staff, and anything that reads a customer's organisation is written to the staff
// audit trail.
export const staffRouter = router({
  // Who the signed-in staff member is, and whether they still need to verify a second factor.
  me: staffIdentityProcedure.query(({ ctx }) => ({
    email: ctx.staff.email,
    roles: ctx.staff.roles,
    mfaRequired: mfaRequired(),
    mfaSatisfied: ctx.mfaSatisfied,
  })),

  // Tickets escalated to Kestrel, across every organisation.
  tickets: router({
    queue: staffProcedure
      .input(
        z
          .object({
            status: z.enum(['active', 'all', ...STATUSES]).optional(),
            priority: z.enum(PRIORITIES).optional(),
            orgId: z.string().uuid().optional(),
          })
          .default({}),
      )
      .query(({ input }) => staffQueue(db, input)),

    get: staffProcedure
      .input(z.object({ ticketId: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        const t = await staffTicket(db, input.ticketId, ctx.staff.userId);
        if (!t) throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticket not found' });
        return t;
      }),

    comment: staffProcedure
      .input(
        z.object({
          ticketId: z.string().uuid(),
          body: z.string().max(5100),
          visibility: z.enum(['public', 'internal']),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireStaffRole(ctx.staff, 'support');
        try {
          const res = await staffComment(db, { ...input, staff: ctx.staff });
          if (res.visibility === 'public')
            after(() => tellOrg(res.orgId, input.ticketId, 'staff_reply', input.body));
          return { ok: true };
        } catch (e) {
          return asTrpc(e);
        }
      }),

    update: staffProcedure
      .input(
        z.object({
          ticketId: z.string().uuid(),
          status: z.enum(STATUSES).optional(),
          priority: z.enum(PRIORITIES).optional(),
          assignToMe: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireStaffRole(ctx.staff, 'support');
        try {
          const res = await staffUpdate(db, { ...input, staff: ctx.staff });
          if (res.statusChanged) after(() => tellOrg(res.orgId, input.ticketId, 'status_changed'));
          return { ok: true };
        } catch (e) {
          return asTrpc(e);
        }
      }),

    handBack: staffProcedure
      .input(z.object({ ticketId: z.string().uuid(), note: z.string().max(1000).optional() }))
      .mutation(async ({ ctx, input }) => {
        requireStaffRole(ctx.staff, 'support');
        try {
          await handBack(db, { ...input, staff: ctx.staff });
          const t = await db.ticket.findFirst({ where: { id: input.ticketId } });
          if (t) after(() => tellOrg(t.orgId, t.id, 'handed_back', input.note));
          return { ok: true };
        } catch (e) {
          return asTrpc(e);
        }
      }),
  }),

  // Working inside a customer organisation: reason, time limit, read-only or act, and a ticket link.
  session: router({
    current: staffIdentityProcedure.query(async ({ ctx }) => {
      const s = await currentSession(db, ctx.staff.userId);
      return s ? { id: s.id, orgId: s.orgId, mode: s.mode, endsAt: s.endsAt } : null;
    }),

    tickets: staffProcedure
      .input(z.object({ orgId }))
      .query(({ input }) => openTickets(db, input.orgId)),

    start: staffProcedure
      .input(
        z.object({
          orgId,
          mode: z.enum(['read', 'act']),
          reason: z.string().max(600),
          minutes: z
            .number()
            .int()
            .refine((m) => (SESSION_MINUTES as readonly number[]).includes(m)),
          ticketId: z.string().uuid().nullish(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          const res = await startSession(db, { staff: ctx.staff, input });
          return { orgId: input.orgId, ...res };
        } catch (e) {
          return asTrpc(e);
        }
      }),

    end: staffIdentityProcedure
      .input(z.object({ sessionId: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        await endSession(db, { sessionId: input.sessionId, staffUserId: ctx.staff.userId });
        return { ok: true };
      }),
  }),

  // Licences and trials: what an organisation pays for, what it may do, and staff adjustments.
  licence: router({
    get: staffProcedure
      .input(z.object({ orgId }))
      .query(({ input }) => licenceState(db, input.orgId)),

    set: staffProcedure
      .input(
        z.object({
          orgId,
          plan: z.enum(['trial', 'basic', 'pro']).nullish(),
          trialEndsAt: z.date().nullish(),
          maxRooms: z.number().int().nullish(),
          unlimitedRooms: z.boolean().optional(),
          monitoring: z.boolean().nullish(),
          expiresAt: z.date().nullish(),
          reason: z.string().max(600),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireStaffRole(ctx.staff, 'billing');
        const { orgId: id, ...rest } = input;
        try {
          return await setOverride(db, { orgId: id, staffUserId: ctx.staff.userId, input: rest });
        } catch (e) {
          return asTrpc(e);
        }
      }),

    revoke: staffProcedure
      .input(z.object({ orgId, overrideId: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        requireStaffRole(ctx.staff, 'billing');
        try {
          await revokeOverride(db, { ...input, staffUserId: ctx.staff.userId });
          return { ok: true };
        } catch (e) {
          return asTrpc(e);
        }
      }),
  }),

  notes: router({
    list: staffProcedure
      .input(z.object({ orgId }))
      .query(({ input }) => listNotes(db, input.orgId)),

    add: staffProcedure
      .input(z.object({ orgId, body: z.string().max(2100) }))
      .mutation(async ({ ctx, input }) => {
        requireAnyStaffRole(ctx.staff, ['support', 'billing']);
        try {
          await addNote(db, { orgId: input.orgId, authorId: ctx.staff.userId, body: input.body });
          return { ok: true };
        } catch (e) {
          return asTrpc(e);
        }
      }),
  }),

  orgs: router({
    // One row per organisation. Counts only, so it is not audited.
    list: staffProcedure.query(() => orgDirectory(db)),

    get: staffProcedure
      .input(z.object({ orgId: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        const detail = await orgDetail(db, input.orgId);
        if (!detail) throw new TRPCError({ code: 'NOT_FOUND', message: 'Organisation not found' });
        await recordStaffAudit(db, {
          staffUserId: ctx.staff.userId,
          action: 'org.view',
          orgId: input.orgId,
        });
        return detail;
      }),
  }),
});
