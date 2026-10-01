import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { writeAudit } from '../audit';
import { realCalloutStripe } from '../callout-stripe';
import {
  CANCEL_NOTICE_MS,
  CalloutError,
  STATUS_LABEL,
  cancelByCustomer,
  listCallouts,
  refundable,
  requestCallout,
  startPayment,
} from '../callouts';
import { orgTimezone, siteTimezone } from '../site-zone';
import { BillingNotConfigured, baseUrl, stripeConfigured } from '../stripe';
import { orgProcedure, requireRole, router } from '../trpc';

const orgId = z.string().uuid();
const id = z.string().uuid();

/** Callout rules are said in plain words; anything else is a real fault and goes up as one. */
export function asTrpc(e: unknown): never {
  if (e instanceof CalloutError) throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
  if (e instanceof BillingNotConfigured)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message });
  throw e;
}

type Row = Awaited<ReturnType<typeof listCallouts>>[number];

/** What a customer sees of a callout: no Stripe identifiers, only the invoice link. */
export const calloutView = (c: Row, timezone: string, now = new Date()) => ({
  timezone,
  id: c.id,
  title: c.title,
  details: c.details,
  preferredDates: c.preferredDates,
  siteId: c.siteId,
  roomId: c.roomId,
  ticketId: c.ticketId,
  status: c.status,
  statusLabel: STATUS_LABEL[c.status] ?? c.status,
  createdAt: c.createdAt,
  hours: c.hours,
  rateCents: c.rateCents,
  subtotalCents: c.subtotalCents,
  gstCents: c.gstCents,
  totalCents: c.totalCents,
  currency: c.currency,
  quoteNote: c.quoteNote,
  scheduledFor: c.scheduledFor,
  scheduledEnd: c.scheduledEnd,
  paidAt: c.paidAt,
  paidCents: c.paidCents,
  actualHours: c.actualHours,
  completionNote: c.completionNote,
  completedAt: c.completedAt,
  invoiceUrl: c.invoiceUrl,
  invoicedCents: c.invoicedCents,
  refundedCents: c.refundedCents,
  cancelledAt: c.cancelledAt,
  cancelledBy: c.cancelledBy,
  cancelReason: c.cancelReason,
  /** A paid booking cancelled now would be refunded in full. */
  refundOnCancel: c.status === 'booked' && refundable(c, now),
});

// A customer's support callouts (docs/decisions.md CO-1..): ask, see the quote, pay to book, cancel.
export const calloutRouter = router({
  list: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => ({
    callouts: await (async () => {
      const rows = await listCallouts(db, { orgId: ctx.orgId });
      const org = await orgTimezone(db, ctx.orgId);
      const zones = new Map<string, string>();
      for (const c of rows)
        if (c.siteId && !zones.has(c.siteId)) zones.set(c.siteId, await siteTimezone(db, c.siteId));
      return rows.map((c) => calloutView(c, (c.siteId && zones.get(c.siteId)) || org));
    })(),
    noticeHours: CANCEL_NOTICE_MS / 3_600_000,
    paymentsAvailable: stripeConfigured(),
  })),

  request: orgProcedure
    .input(
      z.object({
        orgId,
        title: z.string().trim().min(1).max(120),
        details: z.string().trim().min(1).max(4000),
        roomId: id.nullable().optional(),
        siteId: id.nullable().optional(),
        incidentId: id.nullable().optional(),
        preferredDates: z.string().trim().max(300).nullable().optional(),
        contactName: z.string().trim().max(100).nullable().optional(),
        contactPhone: z.string().trim().max(40).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      try {
        const c = await requestCallout(db, {
          ...input,
          orgId: ctx.orgId,
          userId: ctx.user.id,
          email: ctx.user.email ?? null,
        });
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'callout.request',
          target: c.id,
          meta: { title: c.title },
        });
        return { id: c.id };
      } catch (e) {
        return asTrpc(e);
      }
    }),

  // Sends the owner to Stripe to prepay the quote. Nothing is booked until Stripe confirms.
  pay: orgProcedure.input(z.object({ orgId, calloutId: id })).mutation(async ({ ctx, input }) => {
    requireRole(ctx.role, ['owner', 'dev']);
    try {
      const out = await startPayment(db, realCalloutStripe(db), {
        id: input.calloutId,
        orgId: ctx.orgId,
        email: ctx.user.email ?? null,
        backUrl: `${await baseUrl()}/o/${ctx.orgId}/callouts`,
      });
      await writeAudit({
        orgId: ctx.orgId,
        actorId: ctx.user.id,
        action: 'callout.pay',
        target: input.calloutId,
      });
      return out;
    } catch (e) {
      return asTrpc(e);
    }
  }),

  cancel: orgProcedure
    .input(z.object({ orgId, calloutId: id, reason: z.string().trim().max(300).optional() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      try {
        const out = await cancelByCustomer(db, realCalloutStripe(db), {
          id: input.calloutId,
          orgId: ctx.orgId,
          reason: input.reason,
        });
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'callout.cancel',
          target: input.calloutId,
          meta: { refundedCents: out.refundedCents },
        });
        return out;
      } catch (e) {
        return asTrpc(e);
      }
    }),
});
