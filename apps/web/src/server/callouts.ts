import type { PrismaClient } from '@kestrel/db';
import { formatInZone } from '../lib/time';
import { orgTimezone, siteTimezone } from './site-zone';

// Support callouts (docs/decisions.md CO-1..). A customer asks for a Kestrel technician to attend;
// staff reply with availability and a quote (hours x hourly rate, plus GST); the customer prepays
// through Stripe Checkout to secure the booking; staff enter the hours actually worked, and extra
// time is invoiced while unused time is credited and refunded. A cancellation 48 hours or more
// before the booking is refunded in full. Functions take the database and a small Stripe interface
// as parameters, so the money rules can be tested without either.
export type CalloutDb = Pick<
  PrismaClient,
  'callout' | 'ticket' | 'ticketComment' | 'room' | 'site'
>;

export class CalloutError extends Error {}

export const GST_RATE = 0.1;
/** A booking can be cancelled for a full refund until this long before it starts. */
export const CANCEL_NOTICE_MS = 48 * 3_600_000;
export const MIN_HOURS = 0.5;
export const MAX_HOURS = 40;
export const CURRENCY = 'aud';

export const OPEN_STATUSES = ['requested', 'quoted', 'booked'] as const;

/** The pieces of Stripe the callout flow needs, so tests can stand in for it. */
export interface CalloutStripe {
  /** The Stripe customer for an organisation, made on first use. */
  customerFor(orgId: string, email: string | null): Promise<string>;
  /** A Checkout page for the prepayment. The paid session also issues the tax invoice for it. */
  checkout(input: {
    customerId: string;
    calloutId: string;
    orgId: string;
    title: string;
    hours: number;
    rateCents: number;
    subtotalCents: number;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ id: string; url: string }>;
  /** The invoice a paid Checkout session issued, if it is not known yet. */
  prepaymentInvoice(sessionId: string): Promise<string | null>;
  /** Credits part (or all) of the prepayment invoice and refunds it to the card. Amount is ex GST. */
  creditPrepayment(input: {
    invoiceId: string;
    amountExGstCents: number;
    reason: string;
  }): Promise<{ creditNoteId: string; refundedCents: number }>;
  /** Invoices time worked beyond the quote, with GST, and sends it. Amount is ex GST. */
  invoiceExtra(input: {
    customerId: string;
    calloutId: string;
    description: string;
    amountExGstCents: number;
  }): Promise<{ invoiceId: string; url: string | null; totalCents: number }>;
}

// ---- Money ---------------------------------------------------------------------------------------

export function quoteTotals(hours: number, rateCents: number) {
  const subtotalCents = Math.round(hours * rateCents);
  const gstCents = Math.round(subtotalCents * GST_RATE);
  return { subtotalCents, gstCents, totalCents: subtotalCents + gstCents };
}

const validHours = (h: number) =>
  Number.isFinite(h) && h >= MIN_HOURS && h <= MAX_HOURS && Math.round(h * 2) === h * 2;

export const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---- Tickets carry the conversation ----------------------------------------------------------------

async function say(db: CalloutDb, c: { orgId: string; ticketId: string | null }, body: string) {
  if (!c.ticketId) return;
  await db.ticketComment.create({
    data: {
      orgId: c.orgId,
      ticketId: c.ticketId,
      authorId: null,
      authorEmail: null,
      fromStaff: true,
      body,
      visibility: 'public',
    },
  });
}

async function closeTicket(
  db: CalloutDb,
  c: { ticketId: string | null; ownsTicket?: boolean },
  status: 'resolved' | 'closed',
  now: Date,
) {
  // A ticket that was there before the callout (an incident's) carries on after it.
  if (!c.ticketId || c.ownsTicket === false) return;
  await db.ticket.update({
    where: { id: c.ticketId },
    data: { status, closedAt: now, updatedAt: now },
  });
}

type Row = NonNullable<Awaited<ReturnType<CalloutDb['callout']['findFirst']>>>;

async function load(db: CalloutDb, id: string, orgId?: string): Promise<Row> {
  const c = await db.callout.findFirst({ where: { id, ...(orgId ? { orgId } : {}) } });
  if (!c) throw new CalloutError('Callout not found');
  return c;
}

/** Quotes, payment, invoices and refunds are Kestrel's. A callout with a service provider is tracked, not billed, here. */
async function loadKestrel(db: CalloutDb, id: string, orgId?: string): Promise<Row> {
  const c = await load(db, id, orgId);
  if (c.routedTo !== ROUTE_KESTREL)
    throw new CalloutError(
      'This callout is with the organisation’s service provider, who deals with the quote and the invoice. It can be sent to Kestrel instead',
    );
  return c;
}

// ---- The customer asks -----------------------------------------------------------------------------

export const ROUTE_KESTREL = 'kestrel';

export interface RequestInput {
  orgId: string;
  /** Request it from this existing ticket (an incident's, say) instead of opening a new one. */
  ticketId?: string | null;
  /** default: to the service provider that covers it, if there is one, else Kestrel. kestrel: to Kestrel anyway. */
  sendTo?: 'default' | 'kestrel';
  /** Whether this person may send it to Kestrel when a provider covers it (an owner or dev). */
  canChooseKestrel?: boolean;
  siteId?: string | null;
  roomId?: string | null;
  incidentId?: string | null;
  title: string;
  details: string;
  preferredDates?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  userId: string | null;
  email: string | null;
}

/** A new request, with a ticket (routed to Kestrel) so staff see it and can reply. */
export async function requestCallout(
  db: CalloutDb,
  input: RequestInput,
  now = new Date(),
  /** The service provider's route ("msp:<id>") that covers this, or null: told the room and the ticket's current route. */
  findProvider: (
    roomId: string | null,
    ticketRoute: string | null,
  ) => Promise<string | null> = async () => null,
) {
  const title = input.title.trim();
  const details = input.details.trim();
  if (!title) throw new CalloutError('Say in a few words what you need');
  if (!details) throw new CalloutError('Describe what is wrong');
  // From an existing ticket: it carries the conversation, so the request is written on it. Its room
  // and incident carry over.
  const from = input.ticketId
    ? await db.ticket.findFirst({ where: { id: input.ticketId, orgId: input.orgId } })
    : null;
  if (input.ticketId) {
    if (!from) throw new CalloutError('That ticket is not in this organisation');
    if (from.status === 'closed')
      throw new CalloutError('Reopen the ticket before requesting a callout');
    const open = await db.callout.count({
      where: { ticketId: from.id, status: { in: [...OPEN_STATUSES] } },
    });
    if (open > 0) throw new CalloutError('A callout is already open for this ticket');
  }
  const roomId = input.roomId ?? from?.roomId ?? null;
  const incidentId = input.incidentId ?? from?.incidentId ?? null;
  let siteId = input.siteId ?? null;
  if (roomId) {
    const room = await db.room.findFirst({ where: { id: roomId, orgId: input.orgId } });
    if (!room) throw new CalloutError('That room is not in this organisation');
    siteId = room.siteId;
  } else if (siteId && !(await db.site.findFirst({ where: { id: siteId, orgId: input.orgId } })))
    throw new CalloutError('That site is not in this organisation');

  // Where it goes: the service provider that covers the room, site or organisation, unless an owner
  // or dev chose Kestrel; with no provider it is Kestrel's.
  const provider = await findProvider(roomId, from?.routedTo ?? null);
  if (provider && input.sendTo === 'kestrel' && !input.canChooseKestrel)
    throw new CalloutError(
      'Only an owner or dev can send a callout to Kestrel instead of the service provider',
    );
  const routedTo = provider && input.sendTo !== 'kestrel' ? provider : ROUTE_KESTREL;
  const withKestrel = routedTo === ROUTE_KESTREL;

  if (from) {
    const lines = [
      `Callout requested: ${title}`,
      details,
      input.preferredDates?.trim() ? `Preferred times: ${input.preferredDates.trim()}` : '',
      input.contactName || input.contactPhone
        ? `Contact: ${[input.contactName, input.contactPhone].filter(Boolean).join(', ')}`
        : '',
    ].filter(Boolean);
    // The ticket goes where the callout goes, and a resolved one that needs someone again is open.
    await db.ticket.update({
      where: { id: from.id },
      data: {
        routedTo,
        updatedAt: now,
        ...(withKestrel && from.routedTo !== ROUTE_KESTREL
          ? { escalatedAt: now, escalatedBy: input.userId }
          : {}),
        ...(from.status === 'resolved' ? { status: 'open', closedAt: null } : {}),
      },
    });
    await db.ticketComment.create({
      data: {
        orgId: input.orgId,
        ticketId: from.id,
        authorId: input.userId,
        authorEmail: input.email,
        fromStaff: false,
        body: lines.join('\n\n'),
        visibility: 'public',
      },
    });
    return db.callout.create({
      data: {
        orgId: input.orgId,
        siteId,
        roomId,
        ticketId: from.id,
        ownsTicket: false,
        routedTo,
        incidentId,
        title,
        details,
        preferredDates: input.preferredDates?.trim() || null,
        contactName: input.contactName?.trim() || null,
        contactPhone: input.contactPhone?.trim() || null,
        createdBy: input.userId,
        createdByEmail: input.email,
        status: 'requested',
      },
    });
  }

  const ticket = await db.ticket.create({
    data: {
      orgId: input.orgId,
      roomId,
      incidentId,
      title: `Callout request: ${title}`.slice(0, 200),
      body: [
        details,
        input.preferredDates ? `Preferred times: ${input.preferredDates}` : '',
        input.contactName || input.contactPhone
          ? `Contact: ${[input.contactName, input.contactPhone].filter(Boolean).join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      priority: 'normal',
      createdBy: input.userId,
      createdByEmail: input.email,
      routedTo,
      ...(withKestrel ? { escalatedAt: now, escalatedBy: input.userId } : {}),
    },
  });
  const callout = await db.callout.create({
    data: {
      orgId: input.orgId,
      siteId,
      roomId,
      ticketId: ticket.id,
      ownsTicket: true,
      routedTo,
      incidentId,
      title,
      details,
      preferredDates: input.preferredDates?.trim() || null,
      contactName: input.contactName?.trim() || null,
      contactPhone: input.contactPhone?.trim() || null,
      createdBy: input.userId,
      createdByEmail: input.email,
      status: 'requested',
    },
  });
  return callout;
}

// ---- Sending it to Kestrel instead of the service provider ---------------------------------------------

/**
 * An owner or dev sends a callout that is with the organisation's service provider to Kestrel
 * instead, while it is still a request. The ticket goes with it, and Kestrel are told on it.
 */
export async function sendToKestrel(
  db: CalloutDb,
  input: { id: string; orgId: string; userId: string; email: string | null },
  now = new Date(),
) {
  const c = await load(db, input.id, input.orgId);
  if (c.routedTo === ROUTE_KESTREL) throw new CalloutError('This callout is already with Kestrel');
  if (c.status !== 'requested')
    throw new CalloutError('It can only be moved to Kestrel before a quote is under way');
  await db.callout.update({ where: { id: c.id }, data: { routedTo: ROUTE_KESTREL } });
  if (c.ticketId) {
    await db.ticket.update({
      where: { id: c.ticketId },
      data: {
        routedTo: ROUTE_KESTREL,
        escalatedAt: now,
        escalatedBy: input.userId,
        updatedAt: now,
      },
    });
    await db.ticketComment.create({
      data: {
        orgId: c.orgId,
        ticketId: c.ticketId,
        authorId: input.userId,
        authorEmail: input.email,
        fromStaff: false,
        body: `This callout was sent to Kestrel support instead of the service provider: ${c.title}`,
        visibility: 'public',
      },
    });
  }
  return { orgId: c.orgId, ticketId: c.ticketId };
}

// ---- Staff reply with a quote ------------------------------------------------------------------------

export interface QuoteInput {
  hours: number;
  rateCents: number;
  scheduledFor: Date;
  scheduledEnd?: Date | null;
  note?: string | null;
  staffUserId: string;
}

/** Offers (or re-offers, until it is paid) a time and a price. The customer is told on the ticket. */
export async function sendQuote(db: CalloutDb, id: string, q: QuoteInput, now = new Date()) {
  const c = await loadKestrel(db, id);
  if (c.status !== 'requested' && c.status !== 'quoted')
    throw new CalloutError('A quote can only be sent before the booking is paid');
  if (!validHours(q.hours))
    throw new CalloutError(`Hours must be between ${MIN_HOURS} and ${MAX_HOURS}, in half hours`);
  if (!Number.isInteger(q.rateCents) || q.rateCents < 100 || q.rateCents > 100_000_00)
    throw new CalloutError('Enter the hourly rate in dollars');
  if (q.scheduledFor.getTime() < now.getTime() + 3_600_000)
    throw new CalloutError('Offer a time at least an hour from now');
  const end = q.scheduledEnd ?? new Date(q.scheduledFor.getTime() + q.hours * 3_600_000);
  const t = quoteTotals(q.hours, q.rateCents);
  await db.callout.update({
    where: { id },
    data: {
      status: 'quoted',
      hours: q.hours,
      rateCents: q.rateCents,
      ...t,
      currency: CURRENCY,
      quoteNote: q.note?.trim() || null,
      quotedAt: now,
      quotedBy: q.staffUserId,
      scheduledFor: q.scheduledFor,
      scheduledEnd: end,
      // A new offer replaces any payment page opened for the old one.
      stripeSessionId: null,
    },
  });
  const zone = c.siteId ? await siteTimezone(db, c.siteId) : await orgTimezone(db, c.orgId);
  const message = `Quote for “${c.title}”: ${q.hours} hours at ${dollars(q.rateCents)}/hour = ${dollars(t.subtotalCents)} + GST ${dollars(t.gstCents)} = ${dollars(t.totalCents)} (AUD). Proposed time: ${formatInZone(q.scheduledFor, zone)}. Pay under Support > Callouts to secure the booking. It can be cancelled for a full refund up to 48 hours before.${q.note ? `\n\n${q.note.trim()}` : ''}`;
  await say(db, c, message);
  return { ...t, orgId: c.orgId, ticketId: c.ticketId, message };
}

export async function declineCallout(db: CalloutDb, id: string, reason: string, now = new Date()) {
  const c = await loadKestrel(db, id);
  if (c.status !== 'requested' && c.status !== 'quoted')
    throw new CalloutError('Only a request that is not yet paid can be declined');
  await db.callout.update({
    where: { id },
    data: {
      status: 'declined',
      cancelledAt: now,
      cancelledBy: 'staff',
      cancelReason: reason.trim() || null,
    },
  });
  await say(db, c, `We can’t take this callout${reason.trim() ? `: ${reason.trim()}` : '.'}`);
  await closeTicket(db, c, 'closed', now);
  return { orgId: c.orgId, ticketId: c.ticketId };
}

// ---- The customer pays ---------------------------------------------------------------------------------

/** Opens Stripe Checkout for the quote. Nothing is booked until Stripe says it was paid. */
export async function startPayment(
  db: CalloutDb,
  stripe: CalloutStripe,
  input: { id: string; orgId: string; email: string | null; backUrl: string },
  now = new Date(),
): Promise<{ url: string }> {
  const c = await loadKestrel(db, input.id, input.orgId);
  if (c.status !== 'quoted' || !c.hours || !c.rateCents || !c.subtotalCents || !c.scheduledFor)
    throw new CalloutError('There is no quote to pay');
  if (c.scheduledFor.getTime() <= now.getTime())
    throw new CalloutError('The proposed time has passed. Ask for a new quote');
  const customerId = await stripe.customerFor(c.orgId, input.email);
  const session = await stripe.checkout({
    customerId,
    calloutId: c.id,
    orgId: c.orgId,
    title: c.title,
    hours: c.hours,
    rateCents: c.rateCents,
    subtotalCents: c.subtotalCents,
    successUrl: `${input.backUrl}?callout=${c.id}&paid=1`,
    cancelUrl: `${input.backUrl}?callout=${c.id}`,
  });
  await db.callout.update({ where: { id: c.id }, data: { stripeSessionId: session.id } });
  return { url: session.url };
}

export interface CalloutSession {
  id: string;
  amount_total?: number | null;
  payment_status?: string | null;
  payment_intent?: string | { id: string } | null;
  invoice?: string | { id: string } | null;
  metadata?: Record<string, string> | null;
}

const idOf = (x: string | { id: string } | null | undefined) =>
  typeof x === 'string' ? x : (x?.id ?? null);

/** Stripe says a callout's checkout was paid: the booking is confirmed. Safe to deliver twice. */
export async function fulfilCallout(
  db: CalloutDb,
  session: CalloutSession,
  now = new Date(),
): Promise<'booked' | 'duplicate' | 'unmatched' | 'mismatch'> {
  const calloutId = session.metadata?.calloutId;
  if (!calloutId || session.payment_status !== 'paid') return 'unmatched';
  const c = await db.callout.findFirst({ where: { id: calloutId } });
  if (!c) return 'unmatched';
  if (c.status === 'booked' || c.paidAt) return 'duplicate';
  // Only a quote still waiting for payment is booked, and only for the amount quoted.
  if (c.status !== 'quoted' || session.amount_total !== c.totalCents) {
    console.error('[callouts] a payment did not match its quote', {
      calloutId,
      sessionId: session.id,
    });
    return 'mismatch';
  }
  const claimed = await db.callout.updateMany({
    where: { id: c.id, status: 'quoted' },
    data: {
      status: 'booked',
      stripeSessionId: session.id,
      paymentIntentId: idOf(session.payment_intent),
      prepaidInvoiceId: idOf(session.invoice),
      paidCents: session.amount_total ?? c.totalCents,
      paidAt: now,
    },
  });
  if (claimed.count === 0) return 'duplicate';
  const zone = c.siteId ? await siteTimezone(db, c.siteId) : await orgTimezone(db, c.orgId);
  await say(
    db,
    c,
    `Payment received. Your callout is booked${c.scheduledFor ? ` for ${formatInZone(c.scheduledFor, zone)}` : ''}. A tax invoice for the prepayment has been emailed. You can cancel for a full refund up to 48 hours before.`,
  );
  return 'booked';
}

// ---- Cancelling -------------------------------------------------------------------------------------------

/** A booking is refunded in full when cancelled with at least 48 hours' notice. */
export const refundable = (c: { scheduledFor: Date | null }, now: Date) =>
  !!c.scheduledFor && c.scheduledFor.getTime() - now.getTime() >= CANCEL_NOTICE_MS;

/** The prepayment's invoice: kept from the webhook, or fetched from the paid session. */
async function prepaidInvoiceOf(db: CalloutDb, stripe: CalloutStripe, c: Row) {
  if (c.prepaidInvoiceId) return c.prepaidInvoiceId;
  if (!c.stripeSessionId) return null;
  const found = await stripe.prepaymentInvoice(c.stripeSessionId);
  if (found) await db.callout.update({ where: { id: c.id }, data: { prepaidInvoiceId: found } });
  return found;
}

async function refundAll(db: CalloutDb, stripe: CalloutStripe, c: Row, reason: string) {
  const invoiceId = await prepaidInvoiceOf(db, stripe, c);
  if (!invoiceId || !c.subtotalCents)
    throw new CalloutError('There is no prepayment invoice to credit. Refund it in Stripe');
  const note = await stripe.creditPrepayment({
    invoiceId,
    amountExGstCents: c.subtotalCents,
    reason,
  });
  return note;
}

/**
 * The customer cancels. Before payment it costs nothing. A paid booking is refunded in full with 48
 * hours' notice or more; closer in, nothing is refunded automatically (staff can still refund it).
 */
export async function cancelByCustomer(
  db: CalloutDb,
  stripe: CalloutStripe,
  input: { id: string; orgId: string; reason?: string | null },
  now = new Date(),
): Promise<{ refundedCents: number; refundable: boolean }> {
  const c = await load(db, input.id, input.orgId);
  if (!OPEN_STATUSES.includes(c.status as never))
    throw new CalloutError('This callout can’t be cancelled');
  const reason = input.reason?.trim() || null;
  let refundedCents = 0;
  let creditNoteId: string | null = null;
  const wasBooked = c.status === 'booked';
  const owed = wasBooked && refundable(c, now);
  if (wasBooked) {
    // Claim it first, so a double click can't refund twice.
    const claimed = await db.callout.updateMany({
      where: { id: c.id, status: 'booked' },
      data: { status: 'cancelling' },
    });
    if (claimed.count === 0) throw new CalloutError('This callout is already being cancelled');
    if (owed) {
      try {
        const note = await refundAll(
          db,
          stripe,
          c,
          'Cancelled by the customer with 48 hours notice',
        );
        refundedCents = note.refundedCents;
        creditNoteId = note.creditNoteId;
      } catch (e) {
        await db.callout.updateMany({
          where: { id: c.id, status: 'cancelling' },
          data: { status: 'booked' },
        });
        throw e;
      }
    }
  }
  await db.callout.update({
    where: { id: c.id },
    data: {
      status: 'cancelled',
      cancelledAt: now,
      cancelledBy: 'customer',
      cancelReason: reason,
      refundedCents: wasBooked ? refundedCents : null,
      creditNoteId,
    },
  });
  await say(
    db,
    c,
    !wasBooked
      ? 'The customer cancelled this request.'
      : owed
        ? `Cancelled. ${dollars(refundedCents)} is being refunded to the card that paid.`
        : 'Cancelled with less than 48 hours’ notice, so the prepayment is not refunded automatically. Kestrel support will be in touch.',
  );
  await closeTicket(db, c, 'closed', now);
  return { refundedCents, refundable: owed };
}

/** Staff cancel: a paid booking is always refunded in full. */
export async function cancelByStaff(
  db: CalloutDb,
  stripe: CalloutStripe,
  input: { id: string; reason: string },
  now = new Date(),
) {
  const c = await loadKestrel(db, input.id);
  if (!OPEN_STATUSES.includes(c.status as never))
    throw new CalloutError('This callout can’t be cancelled');
  let refundedCents = 0;
  let creditNoteId: string | null = null;
  const wasBooked = c.status === 'booked';
  if (wasBooked) {
    const claimed = await db.callout.updateMany({
      where: { id: c.id, status: 'booked' },
      data: { status: 'cancelling' },
    });
    if (claimed.count === 0) throw new CalloutError('This callout is already being cancelled');
    try {
      const note = await refundAll(db, stripe, c, input.reason || 'Cancelled by Kestrel');
      refundedCents = note.refundedCents;
      creditNoteId = note.creditNoteId;
    } catch (e) {
      await db.callout.updateMany({
        where: { id: c.id, status: 'cancelling' },
        data: { status: 'booked' },
      });
      throw e;
    }
  }
  await db.callout.update({
    where: { id: c.id },
    data: {
      status: 'cancelled',
      cancelledAt: now,
      cancelledBy: 'staff',
      cancelReason: input.reason.trim() || null,
      refundedCents: wasBooked ? refundedCents : null,
      creditNoteId,
    },
  });
  await say(
    db,
    c,
    `Kestrel cancelled this callout${input.reason.trim() ? `: ${input.reason.trim()}` : ''}.${refundedCents ? ` ${dollars(refundedCents)} is being refunded.` : ''}`,
  );
  await closeTicket(db, c, 'closed', now);
  return { orgId: c.orgId, ticketId: c.ticketId, refundedCents };
}

/** Staff refund a booking the customer cancelled inside the notice period, as a goodwill gesture. */
export async function refundLateCancellation(db: CalloutDb, stripe: CalloutStripe, id: string) {
  const c = await loadKestrel(db, id);
  if (c.status !== 'cancelled' || c.cancelledBy !== 'customer' || !c.paidAt || c.refundedCents)
    throw new CalloutError('Only a late cancellation that was not refunded can be refunded here');
  const note = await refundAll(db, stripe, c, 'Late cancellation refunded by Kestrel');
  await db.callout.update({
    where: { id },
    data: { refundedCents: note.refundedCents, creditNoteId: note.creditNoteId },
  });
  await say(db, c, `${dollars(note.refundedCents)} is being refunded to the card that paid.`);
  return { orgId: c.orgId, ticketId: c.ticketId, refundedCents: note.refundedCents };
}

// ---- Completing the work ------------------------------------------------------------------------------------

/**
 * Staff say how long the work took. More than quoted: the extra is invoiced (with GST). Less: the
 * unused time is credited against the prepayment and refunded. The same: nothing more to do.
 */
export async function completeCallout(
  db: CalloutDb,
  stripe: CalloutStripe,
  input: { id: string; actualHours: number; note?: string | null; staffUserId: string },
  now = new Date(),
) {
  const c = await loadKestrel(db, input.id);
  if (c.status !== 'booked' || !c.rateCents || !c.subtotalCents || !c.hours)
    throw new CalloutError('Only a paid booking can be completed');
  if (!validHours(input.actualHours))
    throw new CalloutError(`Hours must be between ${MIN_HOURS} and ${MAX_HOURS}, in half hours`);
  const claimed = await db.callout.updateMany({
    where: { id: c.id, status: 'booked' },
    data: { status: 'completing' },
  });
  if (claimed.count === 0) throw new CalloutError('This callout is already being completed');

  const actual = Math.round(input.actualHours * c.rateCents);
  const diff = actual - c.subtotalCents;
  const result: {
    stripeInvoiceId?: string;
    invoiceUrl?: string | null;
    invoicedCents?: number;
    creditNoteId?: string;
    refundedCents?: number;
  } = {};
  try {
    if (diff > 0) {
      const customerId = await stripe.customerFor(c.orgId, c.createdByEmail);
      const inv = await stripe.invoiceExtra({
        customerId,
        calloutId: c.id,
        description: `Additional time on callout “${c.title}”: ${input.actualHours} hours worked, ${c.hours} hours prepaid, at ${dollars(c.rateCents)}/hour`,
        amountExGstCents: diff,
      });
      result.stripeInvoiceId = inv.invoiceId;
      result.invoiceUrl = inv.url;
      result.invoicedCents = inv.totalCents;
    } else if (diff < 0) {
      const invoiceId = await prepaidInvoiceOf(db, stripe, c);
      if (!invoiceId) throw new CalloutError('There is no prepayment invoice to credit');
      const note = await stripe.creditPrepayment({
        invoiceId,
        amountExGstCents: -diff,
        reason: `Unused time on callout: ${input.actualHours} hours worked of ${c.hours} prepaid`,
      });
      result.creditNoteId = note.creditNoteId;
      result.refundedCents = note.refundedCents;
    }
  } catch (e) {
    await db.callout.updateMany({
      where: { id: c.id, status: 'completing' },
      data: { status: 'booked' },
    });
    throw e;
  }
  await db.callout.update({
    where: { id: c.id },
    data: {
      status: 'completed',
      actualHours: input.actualHours,
      completionNote: input.note?.trim() || null,
      completedAt: now,
      completedBy: input.staffUserId,
      ...result,
    },
  });
  const line =
    diff > 0
      ? `The work took ${input.actualHours} hours, ${input.actualHours - c.hours} more than the ${c.hours} prepaid. An invoice for the extra time (${dollars(result.invoicedCents ?? 0)} including GST) has been emailed.`
      : diff < 0
        ? `The work took ${input.actualHours} hours, ${c.hours - input.actualHours} fewer than the ${c.hours} prepaid. ${dollars(result.refundedCents ?? 0)} (including GST) is being refunded to the card that paid.`
        : `The work took the ${c.hours} hours prepaid. Nothing more to pay.`;
  await say(
    db,
    c,
    `Callout complete. ${line}${input.note?.trim() ? `\n\n${input.note.trim()}` : ''}`,
  );
  await closeTicket(db, c, 'resolved', now);
  return { orgId: c.orgId, ticketId: c.ticketId, diffCents: diff, ...result };
}

// ---- Reading ---------------------------------------------------------------------------------------------------

export async function listCallouts(
  db: CalloutDb,
  filter: { orgId?: string; status?: string[]; ticketId?: string } = {},
) {
  return db.callout.findMany({
    where: {
      ...(filter.orgId ? { orgId: filter.orgId } : {}),
      ...(filter.ticketId ? { ticketId: filter.ticketId } : {}),
      ...(filter.status?.length ? { status: { in: filter.status } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

/** The words for a status, as the customer sees them. */
export const STATUS_LABEL: Record<string, string> = {
  requested: 'Waiting for a quote',
  quoted: 'Quote ready',
  booked: 'Booked and paid',
  completing: 'Being completed',
  cancelling: 'Being cancelled',
  completed: 'Completed',
  cancelled: 'Cancelled',
  declined: 'Declined',
};
