import { z } from 'zod';
import { after } from 'next/server';
import { TRPCError } from '@trpc/server';
import { db } from '@kestrel/db';
import { mspFromRoute, mspRoute } from '@kestrel/model';
import { writeAudit } from '../audit';
import { realCalloutStripe } from '../callout-stripe';
import {
  CANCEL_NOTICE_MS,
  CalloutError,
  ROUTE_KESTREL,
  STATUS_LABEL,
  TRANSFERABLE,
  cancelByCustomer,
  listCallouts,
  refundable,
  providerComplete,
  providerSchedule,
  requestCallout,
  startPayment,
  transferCallout,
  type Actor,
} from '../callouts';
import { providerCovers, routeForNewTicket } from '../msp';
import { orgTimezone, siteTimezone } from '../site-zone';
import { notifyStaff } from '../ticket-notify';
import { BillingNotConfigured, baseUrl, stripeConfigured } from '../stripe';
import { SITE_SCOPED, inScope } from '../site-scope';
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
/** What the person looking can do with a callout, decided here so the screen only has to show it. */
export interface CalloutViewer {
  /** The service provider this person acts for, when they are viewing through one. */
  mspOrgId: string | null;
  isOwnerOrDev: boolean;
  /** The provider that covers this callout's room, if any (for sending it back to them). */
  coveringProviderName: string | null;
}

export const calloutView = (
  c: Row,
  timezone: string,
  providerName: string | null = null,
  viewer: CalloutViewer = { mspOrgId: null, isOwnerOrDev: false, coveringProviderName: null },
  now = new Date(),
) => {
  const movable = (TRANSFERABLE as readonly string[]).includes(c.status);
  const mine = !!viewer.mspOrgId && c.routedTo === mspRoute(viewer.mspOrgId);
  return calloutBody(c, timezone, providerName, now, {
    /** The provider's own work: schedule a visit, complete it. */
    providerWork: mine && ['requested', 'scheduled'].includes(c.status),
    /** Hand it to Kestrel: the organisation's owner or dev, or the provider that has it. */
    toKestrel:
      movable && c.routedTo !== 'kestrel' && (mine || (!viewer.mspOrgId && viewer.isOwnerOrDev)),
    /** Hand it to the provider that covers it: the owner or dev, while Kestrel has it. */
    toProvider:
      movable &&
      c.routedTo === 'kestrel' &&
      !viewer.mspOrgId &&
      viewer.isOwnerOrDev &&
      viewer.coveringProviderName !== null,
    coveringProviderName: viewer.coveringProviderName,
  });
};

const calloutBody = (
  c: Row,
  timezone: string,
  providerName: string | null,
  now: Date,
  actions: {
    providerWork: boolean;
    toKestrel: boolean;
    toProvider: boolean;
    coveringProviderName: string | null;
  },
) => ({
  actions,
  history: (Array.isArray(c.history) ? c.history : []) as {
    at: string;
    kind: string;
    from?: string;
    to?: string;
    by: string;
    note?: string;
  }[],
  completedByName: c.completedByName,
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

/** The callout a service provider is acting on: it must be viewing through that provider, hold the callout, and be allowed at its site. */
async function providerOwns(ctx: Looking & { user: { id: string } }, calloutId: string) {
  if (!ctx.viaMsp)
    throw new CalloutError('Only the service provider that has this callout can do that');
  requireRole(ctx.role, ['owner', 'dev', 'support']);
  const c = await db.callout.findFirst({ where: { id: calloutId, orgId: ctx.orgId } });
  if (!c || c.routedTo !== mspRoute(ctx.viaMsp.mspOrgId))
    throw new CalloutError('This callout is not with your service provider');
  if (c.siteId && !inScope(ctx.siteScope, c.siteId))
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Callout not found' });
  return c;
}

interface Looking {
  orgId: string;
  role: Parameters<typeof requireRole>[0];
  viaMsp: { mspOrgId: string; mspName: string } | null;
  siteScope: string[] | null;
}

/**
 * Turns callouts into what a screen shows, for whoever is looking: times in each site's zone, who
 * has each one, what has happened, and what this person can do with it. A provider limited to some
 * sites sees only the callouts at those sites.
 */
async function viewsFor(ctx: Looking, rows: Awaited<ReturnType<typeof listCallouts>>) {
  const visible = rows.filter(
    (c) => !c.siteId || inScope(ctx.siteScope, c.siteId) || ctx.siteScope === null,
  );
  const org = await orgTimezone(db, ctx.orgId);
  const zones = new Map<string, string>();
  for (const c of visible)
    if (c.siteId && !zones.has(c.siteId)) zones.set(c.siteId, await siteTimezone(db, c.siteId));
  const names = new Map(
    (
      await db.org.findMany({
        where: { id: { in: [...new Set(visible.flatMap((c) => mspFromRoute(c.routedTo) ?? []))] } },
        select: { id: true, name: true },
      })
    ).map((o) => [o.id, o.name]),
  );
  // The provider that covers each room, for the owner's "send it to them" choice.
  const covering = new Map<string, string | null>();
  const finder = providerFinder(ctx.orgId);
  const isOwnerOrDev = ['owner', 'dev'].includes(ctx.role) && !ctx.viaMsp;
  const nameOfRoute = async (route: string | null) => {
    const id = route ? mspFromRoute(route) : null;
    if (!id) return null;
    return (
      names.get(id) ??
      (await db.org.findFirst({ where: { id }, select: { name: true } }))?.name ??
      null
    );
  };
  for (const c of visible) {
    if (!isOwnerOrDev || c.routedTo !== 'kestrel' || covering.has(c.id)) continue;
    covering.set(c.id, await nameOfRoute(await finder(c.roomId, null)));
  }
  return visible.map((c) =>
    calloutView(
      c,
      (c.siteId && zones.get(c.siteId)) || org,
      names.get(mspFromRoute(c.routedTo) ?? '') ?? null,
      {
        mspOrgId: ctx.viaMsp?.mspOrgId ?? null,
        isOwnerOrDev,
        coveringProviderName: covering.get(c.id) ?? null,
      },
    ),
  );
}

// A customer's support callouts (docs/decisions.md CO-1..): ask, see the quote, pay to book, cancel.
export const calloutRouter = router({
  list: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId }))
    .query(async ({ ctx }) => ({
      callouts: await viewsFor(ctx, await listCallouts(db, { orgId: ctx.orgId })),
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

  // The callouts requested from a ticket, for the ticket's page (and for a provider working on it).
  forTicket: orgProcedure
    .meta(SITE_SCOPED)
    .input(z.object({ orgId, ticketId: id }))
    .query(async ({ ctx, input }) =>
      viewsFor(ctx, await listCallouts(db, { orgId: ctx.orgId, ticketId: input.ticketId })),
    ),

  // Moves a callout between Kestrel and a service provider while nothing is paid. The organisation's
  // owner or dev can send it either way (to the provider that covers it, or to Kestrel); the provider
  // that has it can hand it back to Kestrel. Kestrel staff move them from the staff portal.
  transfer: orgProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        calloutId: id,
        to: z.enum(['kestrel', 'provider']),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const callout = await db.callout.findFirst({
          where: { id: input.calloutId, orgId: ctx.orgId },
        });
        if (!callout) throw new CalloutError('Callout not found');
        if (callout.siteId && !inScope(ctx.siteScope, callout.siteId))
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Callout not found' });
        const viaProvider = ctx.viaMsp;
        let by: Actor;
        let to: string;
        if (viaProvider) {
          // The provider that has it can hand it back to Kestrel, and nothing else.
          requireRole(ctx.role, ['owner', 'dev', 'support']);
          if (callout.routedTo !== mspRoute(viaProvider.mspOrgId))
            throw new CalloutError('This callout is not with your service provider');
          if (input.to !== 'kestrel')
            throw new CalloutError('A service provider can only hand a callout back to Kestrel');
          to = ROUTE_KESTREL;
          by = {
            kind: 'provider',
            userId: ctx.user.id,
            email: ctx.user.email ?? null,
            label: viaProvider.mspName,
          };
        } else {
          requireRole(ctx.role, ['owner', 'dev']);
          if (input.to === 'kestrel') to = ROUTE_KESTREL;
          else {
            const route = await providerFinder(ctx.orgId)(callout.roomId, null);
            if (!route) throw new CalloutError('No service provider covers this');
            to = route;
          }
          by = {
            kind: 'customer',
            userId: ctx.user.id,
            email: ctx.user.email ?? null,
            label: ctx.user.email ?? 'the organisation',
          };
        }
        const names: Record<string, string> = {};
        for (const route of [callout.routedTo, to]) {
          const oid = mspFromRoute(route);
          if (oid)
            names[route] =
              (await db.org.findFirst({ where: { id: oid }, select: { name: true } }))?.name ??
              'the service provider';
        }
        const res = await transferCallout(db, {
          id: callout.id,
          orgId: ctx.orgId,
          to,
          by,
          note: input.note,
          names,
          isProvider: (route) => providerCovers(db, ctx.orgId, route, callout.siteId),
          ...(stripeConfigured() ? { stripe: realCalloutStripe(db) } : {}),
        });
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'callout.transfer',
          target: callout.id,
          meta: { from: res.from, to: res.to },
        });
        if (res.to === ROUTE_KESTREL && res.ticketId)
          after(() => tellStaff(ctx.orgId, res.ticketId!, `${res.title} (moved to Kestrel)`));
        return { ok: true, to: res.to };
      } catch (e) {
        return asTrpc(e);
      }
    }),

  // The service provider that has a callout fixes the visit time. Nothing is paid through Kestrel.
  providerSchedule: orgProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        calloutId: id,
        scheduledFor: z.coerce.date(),
        scheduledEnd: z.coerce.date().nullable().optional(),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const callout = await providerOwns(ctx, input.calloutId);
        const res = await providerSchedule(db, {
          id: callout.id,
          orgId: ctx.orgId,
          route: mspRoute(ctx.viaMsp!.mspOrgId),
          providerName: ctx.viaMsp!.mspName,
          scheduledFor: input.scheduledFor,
          scheduledEnd: input.scheduledEnd,
          note: input.note,
          userId: ctx.user.id,
          email: ctx.user.email ?? null,
          zone: callout.siteId
            ? await siteTimezone(db, callout.siteId)
            : await orgTimezone(db, ctx.orgId),
        });
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'callout.provider_schedule',
          target: callout.id,
        });
        return res;
      } catch (e) {
        return asTrpc(e);
      }
    }),

  // The service provider says the work is done: hours worked and what was done.
  providerComplete: orgProcedure
    .meta(SITE_SCOPED)
    .input(
      z.object({
        orgId,
        calloutId: id,
        actualHours: z.number().positive().max(200).nullable().optional(),
        note: z.string().trim().min(1).max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const callout = await providerOwns(ctx, input.calloutId);
        const res = await providerComplete(db, {
          id: callout.id,
          orgId: ctx.orgId,
          route: mspRoute(ctx.viaMsp!.mspOrgId),
          providerName: ctx.viaMsp!.mspName,
          actualHours: input.actualHours,
          note: input.note,
          userId: ctx.user.id,
          email: ctx.user.email ?? null,
        });
        await writeAudit({
          orgId: ctx.orgId,
          actorId: ctx.user.id,
          action: 'callout.provider_complete',
          target: callout.id,
        });
        return res;
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
