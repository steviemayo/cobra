import { z } from 'zod';
import { after } from 'next/server';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { mspFromRoute } from '@kestrel/model';
import { writeAudit } from '../audit';
import { realCalloutStripe } from '../callout-stripe';
import {
  CANCEL_NOTICE_MS,
  CalloutError,
  ROUTE_KESTREL,
  STATUS_LABEL,
  cancelByCustomer,
  listCallouts,
  refundable,
  requestCallout,
  sendToKestrel,
  startPayment,
} from '../callouts';
import { routeForNewTicket } from '../msp';
import { orgTimezone, siteTimezone } from '../site-zone';
import { notifyStaff } from '../ticket-notify';
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
export const calloutView = (
  c: Row,
  timezone: string,
  providerName: string | null = null,
  now = new Date(),
) => ({
  timezone,
  routedTo: c.routedTo,
  /** The service provider it is with, when it is not with Kestrel. */
  providerName,
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

/** The service provider's route that covers a room, or the one a ticket is already with. Null: none. */
const providerFinder =
  (orgId: string) =>
  async (roomId: string | null, ticketRoute: string | null): Promise<string | null> => {
    if (ticketRoute && mspFromRoute(ticketRoute)) return ticketRoute;
    const route = await routeForNewTicket(db, orgId, roomId);
    return mspFromRoute(route) ? route : null;
  };

async function tellStaff(orgId: string, ticketId: string, title: string) {
  const [org, t] = await Promise.all([
    db.org.findFirst({ where: { id: orgId } }),
    db.ticket.findFirst({ where: { id: ticketId, orgId } }),
  ]);
  if (!org || !t) return;
  await notifyStaff({
    kind: 'escalated',
    orgId,
    orgName: org.name,
    ticket: { id: t.id, title: t.title, priority: t.priority, status: t.status },
    snippet: `Callout requested: ${title}`,
  });
}

// A customer's support callouts (docs/decisions.md CO-1..): ask, see the quote, pay to book, cancel.
export const calloutRouter = router({
  list: orgProcedure.input(z.object({ orgId })).query(async ({ ctx }) => ({
    callouts: await (async () => {
      const rows = await listCallouts(db, { orgId: ctx.orgId });
      const org = await orgTimezone(db, ctx.orgId);
      const zones = new Map<string, string>();
      for (const c of rows)
        if (c.siteId && !zones.has(c.siteId)) zones.set(c.siteId, await siteTimezone(db, c.siteId));
      const providers = new Map(
        (
          await db.org.findMany({
            where: {
              id: { in: [...new Set(rows.flatMap((c) => mspFromRoute(c.routedTo) ?? []))] },
            },
            select: { id: true, name: true },
          })
        ).map((o) => [o.id, o.name]),
      );
      return rows.map((c) =>
        calloutView(
          c,
          (c.siteId && zones.get(c.siteId)) || org,
          providers.get(mspFromRoute(c.routedTo) ?? '') ?? null,
        ),
      );
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
        /** Request it from this ticket (the conversation and the record stay on the ticket). */
        ticketId: id.nullable().optional(),
        /** An owner or dev can send it to Kestrel even when a service provider covers it. */
        sendTo: z.enum(['default', 'kestrel']).default('default'),
        preferredDates: z.string().trim().max(300).nullable().optional(),
        contactName: z.string().trim().max(100).nullable().optional(),
        contactPhone: z.string().trim().max(40).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev', 'support']);
      try {
        const c = await requestCallout(
          db,
          {
            ...input,
            orgId: ctx.orgId,
            userId: ctx.user.id,
            email: ctx.user.email ?? null,
            canChooseKestrel: ['owner', 'dev'].includes(ctx.role),
          },
          new Date(),
          providerFinder(ctx.orgId),
        );
        // Kestrel are told about the ones that are theirs; a provider's are in its support queue.
        if (c.routedTo === ROUTE_KESTREL && c.ticketId)
          after(() => tellStaff(ctx.orgId, c.ticketId!, c.title));
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'callout.request',
          target: c.id,
          meta: { title: c.title },
        });
        return { id: c.id, routedTo: c.routedTo };
      } catch (e) {
        return asTrpc(e);
      }
    }),

  // Where a callout would go from here, so the request form can say so: the service provider that
  // covers the room (or the ticket), or Kestrel. Owners and devs may choose Kestrel anyway.
  destination: orgProcedure
    .input(
      z.object({ orgId, roomId: id.nullable().optional(), ticketId: id.nullable().optional() }),
    )
    .query(async ({ ctx, input }) => {
      const ticket = input.ticketId
        ? await db.ticket.findFirst({ where: { id: input.ticketId, orgId: ctx.orgId } })
        : null;
      const route = await providerFinder(ctx.orgId)(
        input.roomId ?? ticket?.roomId ?? null,
        ticket?.routedTo ?? null,
      );
      const providerId = route ? mspFromRoute(route) : null;
      const provider = providerId
        ? await db.org.findFirst({ where: { id: providerId }, select: { name: true } })
        : null;
      return {
        providerName: provider?.name ?? null,
        canChooseKestrel: ['owner', 'dev'].includes(ctx.role),
      };
    }),

  // The callouts requested from a ticket, for the ticket's page.
  forTicket: orgProcedure.input(z.object({ orgId, ticketId: id })).query(async ({ ctx, input }) => {
    const rows = await listCallouts(db, { orgId: ctx.orgId, ticketId: input.ticketId });
    const org = await orgTimezone(db, ctx.orgId);
    const ids = [...new Set(rows.flatMap((c) => mspFromRoute(c.routedTo) ?? []))];
    const names = new Map(
      (await db.org.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map(
        (o) => [o.id, o.name],
      ),
    );
    return rows.map((c) => calloutView(c, org, names.get(mspFromRoute(c.routedTo) ?? '') ?? null));
  }),

  // Moves a callout that is with the service provider to Kestrel instead, while it is a request.
  sendToKestrel: orgProcedure
    .input(z.object({ orgId, calloutId: id }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.role, ['owner', 'dev']);
      try {
        const res = await sendToKestrel(db, {
          id: input.calloutId,
          orgId: ctx.orgId,
          userId: ctx.user.id,
          email: ctx.user.email ?? null,
        });
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'callout.to_kestrel',
          target: input.calloutId,
        });
        if (res.ticketId) after(() => tellStaff(ctx.orgId, res.ticketId!, 'sent to Kestrel'));
        return { ok: true };
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
