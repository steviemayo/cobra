import { z } from 'zod';
import { after } from 'next/server';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { exportAuditLog } from '../audit-export';
import { RetentionError, auditRetentionFor, setAuditRetention } from '../audit-retention';
import { writeAudit } from '../audit';
import { supabaseAccounts } from '../staff-accounts';
import {
  TeamError,
  describeStaffAudit,
  listStaffAudit,
  listTeam,
  removeStaff,
  setStaff,
} from '../staff-team';
import { StaffRole, mspFromRoute } from '@kestrel/model';
import { realCalloutStripe } from '../callout-stripe';
import { coveringProviders, providerCovers } from '../msp';
import { orgTimezone, siteTimezone } from '../site-zone';
import { OrgDeletionError, restoreOrg, scheduleDeletion } from '../org-deletion';
import {
  CalloutError,
  cancelByStaff,
  completeCallout,
  declineCallout,
  listCallouts,
  refundLateCancellation,
  sendQuote,
  transferCallout,
} from '../callouts';
import { BillingNotConfigured, getStripe, stripeConfigured } from '../stripe';
import { orgDetail, orgDirectory, recordStaffAudit, mfaRequired } from '../staff';
import {
  AnnounceError,
  claimUnclaimed,
  deleteUnclaimed,
  dismissUnclaimed,
  listUnclaimed,
  releaseClaim,
  reopenUnclaimed,
} from '../gateway-announce';
import { fleetHealth } from '../fleet-health';
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
  InvoiceError,
  approvedInvoiceOrgs,
  decideInvoice,
  pendingInvoiceRequests,
  revokeInvoice,
  setInvoiceDays,
} from '../invoice-billing';
import { updateInvoiceDays } from '../stripe';
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
  if (
    e instanceof AnnounceError ||
    e instanceof LicenceError ||
    e instanceof InvoiceError ||
    e instanceof SessionError ||
    e instanceof TicketError ||
    e instanceof RetentionError ||
    e instanceof TeamError ||
    e instanceof CalloutError ||
    e instanceof OrgDeletionError ||
    e instanceof BillingNotConfigured
  )
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

  // What is wrong across every customer right now. Read only, and operational metadata only
  // (gateway and room names, counts), so it is not written to the audit trail on every refresh.
  health: staffProcedure.query(() => fleetHealth(db)),

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

  // Requests to pay by invoice instead of card: the queue, and staff decisions on it.
  invoiceRequests: router({
    list: staffProcedure.query(async ({ ctx }) => {
      requireStaffRole(ctx.staff, 'billing');
      return pendingInvoiceRequests(db);
    }),

    decide: staffProcedure
      .input(
        z.object({
          orgId,
          approve: z.boolean(),
          reason: z.string().max(600).optional(),
          days: z.number().int().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireStaffRole(ctx.staff, 'billing');
        try {
          await decideInvoice(db, { ...input, staffUserId: ctx.staff.userId });
          return { ok: true };
        } catch (e) {
          return asTrpc(e);
        }
      }),

    approved: staffProcedure.query(async ({ ctx }) => {
      requireStaffRole(ctx.staff, 'billing');
      return approvedInvoiceOrgs(db);
    }),

    // Days to pay for this customer. A running invoiced subscription is updated too, for invoices from now on.
    setDays: staffProcedure
      .input(z.object({ orgId, days: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        requireStaffRole(ctx.staff, 'billing');
        try {
          await setInvoiceDays(db, { ...input, staffUserId: ctx.staff.userId });
          const billing = await db.orgBilling.findFirst({ where: { orgId: input.orgId } });
          if (billing?.stripeSubscriptionId && billing.collectionMethod === 'send_invoice')
            await updateInvoiceDays(billing.stripeSubscriptionId, input.days);
          return { ok: true };
        } catch (e) {
          return asTrpc(e);
        }
      }),

    revoke: staffProcedure
      .input(z.object({ orgId, reason: z.string().max(600) }))
      .mutation(async ({ ctx, input }) => {
        requireStaffRole(ctx.staff, 'billing');
        try {
          await revokeInvoice(db, { ...input, staffUserId: ctx.staff.userId });
          return { ok: true };
        } catch (e) {
          return asTrpc(e);
        }
      }),
  }),

  // Who is Kestrel staff. Admin only: it decides who can see every customer.
  team: router({
    list: staffProcedure.query(async ({ ctx }) => {
      requireStaffRole(ctx.staff, 'admin');
      return listTeam(db);
    }),

    set: staffProcedure
      .input(
        z.object({ email: z.string().trim().email(), roles: z.array(StaffRole).min(1).max(4) }),
      )
      .mutation(async ({ ctx, input }) => {
        requireStaffRole(ctx.staff, 'admin');
        try {
          return await setStaff(db, supabaseAccounts(), { ...input, by: ctx.staff.userId });
        } catch (e) {
          return asTrpc(e);
        }
      }),

    remove: staffProcedure
      .input(z.object({ userId: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        requireStaffRole(ctx.staff, 'admin');
        try {
          await removeStaff(db, { userId: input.userId, by: ctx.staff.userId });
          return { ok: true };
        } catch (e) {
          return asTrpc(e);
        }
      }),
  }),

  // What staff have done or looked at, across organisations. Reading it is not itself recorded.
  audit: router({
    list: staffProcedure
      .input(
        z
          .object({
            staffUserId: z.string().uuid().optional(),
            orgId: z.string().uuid().optional(),
            action: z.string().trim().max(60).optional(),
            before: z.date().optional(),
          })
          .default({}),
      )
      .query(async ({ ctx, input }) => {
        requireAnyStaffRole(ctx.staff, ['admin', 'support']);
        const { rows, more } = await listStaffAudit(db, input);
        return {
          more,
          rows: rows.map((r) => ({ ...r, what: describeStaffAudit(r.action, r.meta) })),
        };
      }),

    // The people to filter by, without needing to be an admin.
    people: staffProcedure.query(async ({ ctx }) => {
      requireAnyStaffRole(ctx.staff, ['admin', 'support']);
      return (await listTeam(db)).map((t) => ({ userId: t.userId, email: t.email }));
    }),
  }),

  // How long an organisation's activity log is kept, and downloading it. Extending retention is an
  // admin decision; reading or exporting the log is support work. Both are audited on both sides.
  auditLog: router({
    retention: staffProcedure
      .input(z.object({ orgId }))
      .query(({ input }) => auditRetentionFor(db, input.orgId)),

    setRetention: staffProcedure
      .input(z.object({ orgId, days: z.number().int(), reason: z.string().trim().min(3).max(300) }))
      .mutation(async ({ ctx, input }) => {
        requireStaffRole(ctx.staff, 'admin');
        try {
          const before = await auditRetentionFor(db, input.orgId);
          const after = await setAuditRetention(db, {
            orgId: input.orgId,
            days: input.days,
            staffUserId: ctx.staff.userId,
          });
          await recordStaffAudit(db, {
            staffUserId: ctx.staff.userId,
            action: 'org.retention',
            orgId: input.orgId,
            meta: { from: before.days, to: after.days, reason: input.reason },
          });
          // The organisation's owner sees it too.
          await writeAudit({
            orgId: input.orgId,
            actorId: ctx.staff.userId,
            action: 'org.retention',
            meta: { days: after.days, reason: input.reason, staff: true },
          });
          return after;
        } catch (e) {
          return asTrpc(e);
        }
      }),

    export: staffProcedure
      .input(
        z.object({
          orgId,
          format: z.enum(['csv', 'json']),
          from: z.date().optional(),
          to: z.date().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAnyStaffRole(ctx.staff, ['support', 'admin']);
        const file = await exportAuditLog(db, input.orgId, input);
        await recordStaffAudit(db, {
          staffUserId: ctx.staff.userId,
          action: 'org.audit_export',
          orgId: input.orgId,
          meta: { format: input.format, rows: file.count },
        });
        return file;
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

  // Gateways that are running but have no definition in any organisation. Staff confirm with the
  // customer, then give one to the right organisation and site.
  gateways: router({
    unclaimed: staffProcedure.query(() => listUnclaimed(db)),

    // For the picker when assigning: organisation names, then the sites of the one chosen.
    orgs: staffProcedure.query(() =>
      db.org.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ),
    sites: staffProcedure.input(z.object({ orgId: z.string().uuid() })).query(({ input }) =>
      db.site.findMany({
        where: { orgId: input.orgId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ),

    claim: staffProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          orgId: z.string().uuid(),
          siteId: z.string().uuid(),
          name: z.string().trim().min(1).max(100),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAnyStaffRole(ctx.staff, ['admin', 'support']);
        try {
          const res = await claimUnclaimed(
            db,
            { ...input, staffUserId: ctx.staff.userId },
            process.env.KESTREL_SECRETS_KEY || undefined,
          );
          await recordStaffAudit(db, {
            staffUserId: ctx.staff.userId,
            action: 'gateway.claim',
            orgId: input.orgId,
            target: res.gatewayId,
            meta: { unclaimedId: input.id, name: input.name },
          });
          return res;
        } catch (e) {
          return asTrpc(e);
        }
      }),

    dismiss: staffProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        requireAnyStaffRole(ctx.staff, ['admin', 'support']);
        try {
          await dismissUnclaimed(db, input.id);
          await recordStaffAudit(db, {
            staffUserId: ctx.staff.userId,
            action: 'gateway.unclaimed.dismiss',
            target: input.id,
          });
          return { ok: true };
        } catch (e) {
          return asTrpc(e);
        }
      }),

    reopen: staffProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        requireAnyStaffRole(ctx.staff, ['admin', 'support']);
        await reopenUnclaimed(db, input.id);
        await recordStaffAudit(db, {
          staffUserId: ctx.staff.userId,
          action: 'gateway.unclaimed.reopen',
          target: input.id,
        });
        return { ok: true };
      }),

    release: staffProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        requireAnyStaffRole(ctx.staff, ['admin', 'support']);
        try {
          await releaseClaim(db, input.id);
          await recordStaffAudit(db, {
            staffUserId: ctx.staff.userId,
            action: 'gateway.unclaimed.release',
            target: input.id,
          });
          return { ok: true };
        } catch (e) {
          return asTrpc(e);
        }
      }),

    delete: staffProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        requireAnyStaffRole(ctx.staff, ['admin', 'support']);
        await deleteUnclaimed(db, input.id);
        await recordStaffAudit(db, {
          staffUserId: ctx.staff.userId,
          action: 'gateway.unclaimed.delete',
          target: input.id,
        });
        return { ok: true };
      }),
  }),

  // Support callouts across every organisation: reply with a quote, complete the work (extra time
  // is invoiced, unused time refunded), cancel and refund. Money moves only for support or billing
  // staff, and every step is written to the staff audit trail.
  callouts: router({
    list: staffProcedure
      .input(
        z
          .object({
            status: z.array(z.string()).optional(),
            orgId: z.string().uuid().optional(),
            ticketId: z.string().uuid().optional(),
          })
          .default({}),
      )
      .query(async ({ input }) => {
        const rows = await listCallouts(db, input);
        const orgs = await db.org.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.orgId))] } },
          select: { id: true, name: true },
        });
        const rooms = await db.room.findMany({
          where: { id: { in: rows.flatMap((r) => (r.roomId ? [r.roomId] : [])) } },
          select: { id: true, name: true },
        });
        // Callouts with a service provider are shown to Kestrel for monitoring: who has them.
        const providers = await db.org.findMany({
          where: { id: { in: [...new Set(rows.flatMap((r) => mspFromRoute(r.routedTo) ?? []))] } },
          select: { id: true, name: true },
        });
        return {
          defaultRateCents: Number(process.env.KESTREL_CALLOUT_RATE_CENTS) || null,
          callouts: await Promise.all(
            rows.map(async (r) => ({
              ...r,
              timezone: r.siteId
                ? await siteTimezone(db, r.siteId)
                : await orgTimezone(db, r.orgId),
              orgName: orgs.find((o) => o.id === r.orgId)?.name ?? 'Unknown',
              providerName:
                providers.find((o) => o.id === (mspFromRoute(r.routedTo) ?? ''))?.name ?? null,
              roomName: rooms.find((x) => x.id === r.roomId)?.name ?? null,
            })),
          ),
        };
      }),

    quote: staffProcedure
      .input(
        z.object({
          calloutId: z.string().uuid(),
          hours: z.number().min(0.5).max(40),
          rateCents: z.number().int().min(100).max(1_000_000),
          scheduledFor: z.coerce.date(),
          scheduledEnd: z.coerce.date().nullable().optional(),
          note: z.string().trim().max(1000).nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAnyStaffRole(ctx.staff, ['support', 'billing']);
        try {
          const res = await sendQuote(
            db,
            input.calloutId,
            { ...input, staffUserId: ctx.staff.userId },
            new Date(),
            stripeConfigured() ? realCalloutStripe(db) : undefined,
          );
          await recordStaffAudit(db, {
            staffUserId: ctx.staff.userId,
            action: 'callout.quote',
            orgId: res.orgId,
            target: input.calloutId,
            meta: { hours: input.hours, rateCents: input.rateCents, totalCents: res.totalCents },
          });
          if (res.ticketId)
            after(() => tellOrg(res.orgId, res.ticketId!, 'staff_reply', res.message));
          return { totalCents: res.totalCents };
        } catch (e) {
          return asTrpc(e);
        }
      }),

    decline: staffProcedure
      .input(
        z.object({ calloutId: z.string().uuid(), reason: z.string().trim().max(300).default('') }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAnyStaffRole(ctx.staff, ['support', 'billing']);
        try {
          const res = await declineCallout(db, input.calloutId, input.reason);
          await recordStaffAudit(db, {
            staffUserId: ctx.staff.userId,
            action: 'callout.decline',
            orgId: res.orgId,
            target: input.calloutId,
          });
          return { ok: true };
        } catch (e) {
          return asTrpc(e);
        }
      }),

    complete: staffProcedure
      .input(
        z.object({
          calloutId: z.string().uuid(),
          actualHours: z.number().min(0.5).max(40),
          note: z.string().trim().max(1000).nullable().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAnyStaffRole(ctx.staff, ['support', 'billing']);
        try {
          const res = await completeCallout(db, realCalloutStripe(db), {
            id: input.calloutId,
            actualHours: input.actualHours,
            note: input.note,
            staffUserId: ctx.staff.userId,
          });
          await recordStaffAudit(db, {
            staffUserId: ctx.staff.userId,
            action: 'callout.complete',
            orgId: res.orgId,
            target: input.calloutId,
            meta: { actualHours: input.actualHours, diffCents: res.diffCents },
          });
          if (res.ticketId) after(() => tellOrg(res.orgId, res.ticketId!, 'status_changed'));
          return { diffCents: res.diffCents };
        } catch (e) {
          return asTrpc(e);
        }
      }),

    cancel: staffProcedure
      .input(
        z.object({ calloutId: z.string().uuid(), reason: z.string().trim().max(300).default('') }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAnyStaffRole(ctx.staff, ['support', 'billing']);
        try {
          const res = await cancelByStaff(db, realCalloutStripe(db), {
            id: input.calloutId,
            reason: input.reason,
          });
          await recordStaffAudit(db, {
            staffUserId: ctx.staff.userId,
            action: 'callout.cancel',
            orgId: res.orgId,
            target: input.calloutId,
            meta: { refundedCents: res.refundedCents },
          });
          if (res.ticketId) after(() => tellOrg(res.orgId, res.ticketId!, 'status_changed'));
          return { refundedCents: res.refundedCents };
        } catch (e) {
          return asTrpc(e);
        }
      }),

    // The providers that cover an organisation and take tickets, for choosing where a callout goes.
    destinations: staffProcedure
      .input(z.object({ orgId: z.string().uuid() }))
      .query(({ input }) => coveringProviders(db, input.orgId)),

    // Moves a callout between Kestrel and a service provider while nothing is paid. Either way: take
    // one a provider has, or give one to a provider that covers the organisation.
    transfer: staffProcedure
      .input(
        z.object({
          calloutId: z.string().uuid(),
          to: z.string().min(1).max(80),
          note: z.string().trim().max(500).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireAnyStaffRole(ctx.staff, ['support', 'billing']);
        try {
          const c = await db.callout.findFirst({ where: { id: input.calloutId } });
          if (!c) throw new CalloutError('Callout not found');
          const names: Record<string, string> = {};
          for (const route of [c.routedTo, input.to]) {
            const oid = mspFromRoute(route);
            if (oid)
              names[route] =
                (await db.org.findFirst({ where: { id: oid }, select: { name: true } }))?.name ??
                'the service provider';
          }
          const res = await transferCallout(db, {
            id: c.id,
            to: input.to,
            by: {
              kind: 'kestrel',
              userId: ctx.staff.userId,
              email: ctx.staff.email ?? null,
              label: 'Kestrel support',
            },
            note: input.note,
            names,
            isProvider: (route) => providerCovers(db, c.orgId, route, c.siteId),
            ...(stripeConfigured() ? { stripe: realCalloutStripe(db) } : {}),
          });
          await recordStaffAudit(db, {
            staffUserId: ctx.staff.userId,
            action: 'callout.transfer',
            orgId: res.orgId,
            target: c.id,
            meta: { from: res.from, to: res.to },
          });
          return { to: res.to };
        } catch (e) {
          return asTrpc(e);
        }
      }),

    refundLate: staffProcedure
      .input(z.object({ calloutId: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        requireAnyStaffRole(ctx.staff, ['admin', 'billing']);
        try {
          const res = await refundLateCancellation(db, realCalloutStripe(db), input.calloutId);
          await recordStaffAudit(db, {
            staffUserId: ctx.staff.userId,
            action: 'callout.refund',
            orgId: res.orgId,
            target: input.calloutId,
            meta: { refundedCents: res.refundedCents },
          });
          return { refundedCents: res.refundedCents };
        } catch (e) {
          return asTrpc(e);
        }
      }),
  }),

  // Deleting an organisation (docs/decisions.md OD-1..): admin only. Scheduling switches it off at
  // once and it is deleted for good after 30 days, unless restored first. Both are audited.
  deletion: router({
    schedule: staffProcedure
      .input(
        z.object({
          orgId,
          confirmName: z.string().max(200),
          reason: z.string().trim().min(1).max(300),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireStaffRole(ctx.staff, 'admin');
        try {
          const res = await scheduleDeletion(
            db,
            {
              cancelSubscription: async (id) => void (await getStripe().subscriptions.cancel(id)),
            },
            { ...input, staffUserId: ctx.staff.userId },
          );
          await recordStaffAudit(db, {
            staffUserId: ctx.staff.userId,
            action: 'org.delete.schedule',
            orgId: input.orgId,
            target: input.orgId,
            meta: {
              reason: input.reason,
              deleteAfter: res.deleteAfter.toISOString(),
              gatewaysReleased: res.gatewaysReleased,
              subscriptionCancelled: res.subscriptionCancelled,
            },
          });
          return res;
        } catch (e) {
          return asTrpc(e);
        }
      }),

    restore: staffProcedure.input(z.object({ orgId })).mutation(async ({ ctx, input }) => {
      requireStaffRole(ctx.staff, 'admin');
      try {
        await restoreOrg(db, { orgId: input.orgId });
        await recordStaffAudit(db, {
          staffUserId: ctx.staff.userId,
          action: 'org.delete.restore',
          orgId: input.orgId,
          target: input.orgId,
        });
        return { ok: true };
      } catch (e) {
        return asTrpc(e);
      }
    }),
  }),
});
