import { describe, expect, it } from 'vitest';
import {
  CalloutError,
  cancelByCustomer,
  cancelByStaff,
  completeCallout,
  declineCallout,
  fulfilCallout,
  quoteTotals,
  refundLateCancellation,
  requestCallout,
  sendQuote,
  startPayment,
  type CalloutDb,
  type CalloutStripe,
} from './callouts';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '11111111-1111-4111-8111-111111111112';
const SITE = '22222222-2222-4222-8222-222222222221';
const ROOM = '33333333-3333-4333-8333-333333333331';
const STAFF = '55555555-5555-4555-8555-555555555551';
const NOW = new Date('2026-10-01T00:00:00Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

function world() {
  return {
    callout: table([]),
    ticket: table([]),
    ticketComment: table([]),
    room: table([{ id: ROOM, orgId: ORG, siteId: SITE, name: 'Boardroom' }]),
    site: table([{ id: SITE, orgId: ORG, name: 'HQ' }]),
  };
}
type W = ReturnType<typeof world>;
const asDb = (w: W) => w as unknown as CalloutDb;

function fakeStripe(over: Partial<CalloutStripe> = {}) {
  const calls: { fn: string; arg: unknown }[] = [];
  const s: CalloutStripe = {
    customerFor: async (orgId, email) => {
      calls.push({ fn: 'customerFor', arg: { orgId, email } });
      return 'cus_1';
    },
    checkout: async (i) => {
      calls.push({ fn: 'checkout', arg: i });
      return { id: 'cs_1', url: 'https://checkout.example/cs_1' };
    },
    prepaymentInvoice: async () => 'in_1',
    creditPrepayment: async (i) => {
      calls.push({ fn: 'creditPrepayment', arg: i });
      return { creditNoteId: 'cn_1', refundedCents: Math.round(i.amountExGstCents * 1.1) };
    },
    invoiceExtra: async (i) => {
      calls.push({ fn: 'invoiceExtra', arg: i });
      return {
        invoiceId: 'in_2',
        url: 'https://invoice.example/in_2',
        totalCents: Math.round(i.amountExGstCents * 1.1),
      };
    },
    ...over,
  };
  return { s, calls };
}

const ask = (w: W) =>
  requestCallout(
    asDb(w),
    {
      orgId: ORG,
      roomId: ROOM,
      title: 'Projector dead',
      details: 'No picture since Monday',
      preferredDates: 'Tuesday am',
      userId: STAFF,
      email: 'pat@example.com',
    },
    NOW,
  );

/** A callout already quoted: 2 hours at $150/h, in `inDays` days. */
async function quoted(w: W, inDays = 5) {
  const c = await ask(w);
  await sendQuote(
    asDb(w),
    c.id,
    {
      hours: 2,
      rateCents: 15000,
      scheduledFor: at(inDays),
      note: 'Bring a spare lamp',
      staffUserId: STAFF,
    },
    NOW,
  );
  return c.id as string;
}

/** Quoted and paid (booked). */
async function booked(w: W, inDays = 5) {
  const id = await quoted(w, inDays);
  await fulfilCallout(
    asDb(w),
    {
      id: 'cs_1',
      amount_total: 33000,
      payment_status: 'paid',
      payment_intent: 'pi_1',
      invoice: 'in_1',
      metadata: { calloutId: id },
    },
    NOW,
  );
  return id;
}
const row = (w: W, id: string) => w.callout.rows.find((r) => r.id === id)!;

describe('the money', () => {
  it('adds 10% GST to the hours at the rate', () => {
    expect(quoteTotals(2, 15000)).toEqual({
      subtotalCents: 30000,
      gstCents: 3000,
      totalCents: 33000,
    });
    expect(quoteTotals(1.5, 12345)).toEqual({
      subtotalCents: 18518,
      gstCents: 1852,
      totalCents: 20370,
    });
  });
});

describe('asking', () => {
  it('opens a callout and a ticket for Kestrel', async () => {
    const w = world();
    const c = await ask(w);
    expect(c).toMatchObject({
      status: 'requested',
      siteId: SITE,
      roomId: ROOM,
      title: 'Projector dead',
    });
    expect(w.ticket.rows[0]).toMatchObject({
      orgId: ORG,
      routedTo: 'kestrel',
      title: 'Callout request: Projector dead',
    });
    expect(String(w.ticket.rows[0]!.body)).toContain('Preferred times: Tuesday am');
    expect(c.ticketId).toBe(w.ticket.rows[0]!.id);
  });

  it('refuses a room from another organisation and an empty request', async () => {
    const w = world();
    await expect(
      requestCallout(asDb(w), {
        orgId: OTHER,
        roomId: ROOM,
        title: 'x',
        details: 'y',
        userId: null,
        email: null,
      }),
    ).rejects.toThrow('not in this organisation');
    await expect(
      requestCallout(asDb(w), { orgId: ORG, title: ' ', details: 'y', userId: null, email: null }),
    ).rejects.toThrow('few words');
  });
});

describe('quoting', () => {
  it('stores the quote with GST, tells the customer on the ticket and can be redone', async () => {
    const w = world();
    const id = await quoted(w);
    expect(row(w, id)).toMatchObject({
      status: 'quoted',
      hours: 2,
      rateCents: 15000,
      subtotalCents: 30000,
      gstCents: 3000,
      totalCents: 33000,
    });
    const said = String(w.ticketComment.rows[0]!.body);
    expect(said).toContain('$300.00');
    expect(said).toContain('GST $30.00');
    expect(said).toContain('$330.00');
    expect(w.ticketComment.rows[0]).toMatchObject({ visibility: 'public', fromStaff: true });
    row(w, id).stripeSessionId = 'cs_old';
    await sendQuote(
      asDb(w),
      id,
      { hours: 3, rateCents: 15000, scheduledFor: at(6), staffUserId: STAFF },
      NOW,
    );
    expect(row(w, id)).toMatchObject({ hours: 3, totalCents: 49500, stripeSessionId: null });
  });

  it('refuses odd hours, silly rates and times in the past', async () => {
    const w = world();
    const c = await ask(w);
    const q = { hours: 2, rateCents: 15000, scheduledFor: at(3), staffUserId: STAFF };
    await expect(sendQuote(asDb(w), c.id, { ...q, hours: 0.25 }, NOW)).rejects.toThrow(
      'half hours',
    );
    await expect(sendQuote(asDb(w), c.id, { ...q, hours: 41 }, NOW)).rejects.toThrow('between');
    await expect(sendQuote(asDb(w), c.id, { ...q, rateCents: 50 }, NOW)).rejects.toThrow('rate');
    await expect(sendQuote(asDb(w), c.id, { ...q, scheduledFor: at(0) }, NOW)).rejects.toThrow(
      'hour from now',
    );
  });

  it('can be declined, which closes the ticket', async () => {
    const w = world();
    const c = await ask(w);
    await declineCallout(asDb(w), c.id, 'Out of area', NOW);
    expect(row(w, c.id).status).toBe('declined');
    expect(w.ticket.rows[0]!.status).toBe('closed');
  });
});

describe('paying', () => {
  it('opens checkout for the amount before GST and remembers the session', async () => {
    const w = world();
    const id = await quoted(w);
    const { s, calls } = fakeStripe();
    const out = await startPayment(
      asDb(w),
      s,
      { id, orgId: ORG, email: 'pat@example.com', backUrl: 'https://k.example/o/x/callouts' },
      NOW,
    );
    expect(out.url).toBe('https://checkout.example/cs_1');
    expect(calls.find((c) => c.fn === 'checkout')!.arg).toMatchObject({
      hours: 2,
      rateCents: 15000,
      subtotalCents: 30000,
      calloutId: id,
    });
    expect(row(w, id).stripeSessionId).toBe('cs_1');
  });

  it('refuses another organisation’s callout and one with no quote', async () => {
    const w = world();
    const id = await quoted(w);
    const { s } = fakeStripe();
    await expect(
      startPayment(asDb(w), s, { id, orgId: OTHER, email: null, backUrl: 'x' }, NOW),
    ).rejects.toThrow(CalloutError);
    const c = await ask(w);
    await expect(
      startPayment(asDb(w), s, { id: c.id, orgId: ORG, email: null, backUrl: 'x' }, NOW),
    ).rejects.toThrow('no quote');
  });

  it('books only when Stripe says it was paid, once, for the amount quoted', async () => {
    const w = world();
    const id = await quoted(w);
    const session = {
      id: 'cs_1',
      amount_total: 33000,
      payment_status: 'paid',
      payment_intent: 'pi_1',
      invoice: { id: 'in_1' },
      metadata: { calloutId: id },
    };
    expect(await fulfilCallout(asDb(w), { ...session, payment_status: 'unpaid' }, NOW)).toBe(
      'unmatched',
    );
    expect(await fulfilCallout(asDb(w), { ...session, amount_total: 100 }, NOW)).toBe('mismatch');
    expect(row(w, id).status).toBe('quoted');
    expect(await fulfilCallout(asDb(w), session, NOW)).toBe('booked');
    expect(row(w, id)).toMatchObject({
      status: 'booked',
      paidCents: 33000,
      paymentIntentId: 'pi_1',
      prepaidInvoiceId: 'in_1',
    });
    expect(await fulfilCallout(asDb(w), session, NOW)).toBe('duplicate');
    expect(
      w.ticketComment.rows.filter((r) => String(r.body).startsWith('Payment received')),
    ).toHaveLength(1);
  });
});

describe('cancelling', () => {
  it('is free before it is paid', async () => {
    const w = world();
    const id = await quoted(w);
    const { s, calls } = fakeStripe();
    expect(await cancelByCustomer(asDb(w), s, { id, orgId: ORG }, NOW)).toEqual({
      refundedCents: 0,
      refundable: false,
    });
    expect(calls).toHaveLength(0);
    expect(row(w, id)).toMatchObject({ status: 'cancelled', cancelledBy: 'customer' });
    expect(w.ticket.rows[0]!.status).toBe('closed');
  });

  it('refunds a paid booking in full with 48 hours’ notice, as a credit note on the prepayment invoice', async () => {
    const w = world();
    const id = await booked(w, 5);
    const { s, calls } = fakeStripe();
    const out = await cancelByCustomer(asDb(w), s, { id, orgId: ORG, reason: 'Fixed itself' }, NOW);
    expect(out).toEqual({ refundedCents: 33000, refundable: true });
    expect(calls.find((c) => c.fn === 'creditPrepayment')!.arg).toMatchObject({
      invoiceId: 'in_1',
      amountExGstCents: 30000,
    });
    expect(row(w, id)).toMatchObject({
      status: 'cancelled',
      refundedCents: 33000,
      creditNoteId: 'cn_1',
      cancelReason: 'Fixed itself',
    });
  });

  it('keeps the prepayment when cancelled inside 48 hours, until staff choose to refund it', async () => {
    const w = world();
    const id = await booked(w, 1.5);
    const { s, calls } = fakeStripe();
    const out = await cancelByCustomer(asDb(w), s, { id, orgId: ORG }, NOW);
    expect(out).toEqual({ refundedCents: 0, refundable: false });
    expect(calls).toHaveLength(0);
    expect(row(w, id)).toMatchObject({ status: 'cancelled', refundedCents: 0 });
    // Exactly 48 hours counts as enough notice.
    const w2 = world();
    const id2 = await booked(w2, 2);
    expect((await cancelByCustomer(asDb(w2), s, { id: id2, orgId: ORG }, NOW)).refundable).toBe(
      true,
    );
    // Goodwill refund by staff afterwards.
    const res = await refundLateCancellation(asDb(w), s, id);
    expect(res.refundedCents).toBe(33000);
    expect(row(w, id)).toMatchObject({ refundedCents: 33000, creditNoteId: 'cn_1' });
    await expect(refundLateCancellation(asDb(w), s, id)).rejects.toThrow('not refunded');
  });

  it('puts a booking back if the refund fails, so it can be tried again', async () => {
    const w = world();
    const id = await booked(w, 5);
    const { s } = fakeStripe({
      creditPrepayment: async () => {
        throw new Error('Stripe is down');
      },
    });
    await expect(cancelByCustomer(asDb(w), s, { id, orgId: ORG }, NOW)).rejects.toThrow(
      'Stripe is down',
    );
    expect(row(w, id).status).toBe('booked');
  });

  it('cannot be cancelled twice, or by another organisation', async () => {
    const w = world();
    const id = await booked(w, 5);
    const { s } = fakeStripe();
    await expect(cancelByCustomer(asDb(w), s, { id, orgId: OTHER }, NOW)).rejects.toThrow(
      'not found',
    );
    await cancelByCustomer(asDb(w), s, { id, orgId: ORG }, NOW);
    await expect(cancelByCustomer(asDb(w), s, { id, orgId: ORG }, NOW)).rejects.toThrow(
      'can’t be cancelled',
    );
  });

  it('always refunds in full when Kestrel cancels', async () => {
    const w = world();
    const id = await booked(w, 0.5);
    const { s } = fakeStripe();
    expect(
      (await cancelByStaff(asDb(w), s, { id, reason: 'Technician unwell' }, NOW)).refundedCents,
    ).toBe(33000);
    expect(row(w, id)).toMatchObject({ status: 'cancelled', cancelledBy: 'staff' });
  });
});

describe('completing', () => {
  const done = (id: string, actualHours: number) => ({
    id,
    actualHours,
    note: 'Replaced the lamp',
    staffUserId: STAFF,
  });

  it('invoices the extra time, with GST, when the work ran over', async () => {
    const w = world();
    const id = await booked(w);
    const { s, calls } = fakeStripe();
    const out = await completeCallout(asDb(w), s, done(id, 3.5), NOW);
    // 1.5 extra hours at $150 = $225 before GST.
    expect(calls.find((c) => c.fn === 'invoiceExtra')!.arg).toMatchObject({
      customerId: 'cus_1',
      amountExGstCents: 22500,
    });
    expect(out).toMatchObject({ diffCents: 22500, invoicedCents: 24750 });
    expect(row(w, id)).toMatchObject({
      status: 'completed',
      actualHours: 3.5,
      stripeInvoiceId: 'in_2',
      invoicedCents: 24750,
    });
    expect(w.ticket.rows[0]!.status).toBe('resolved');
  });

  it('credits and refunds the unused time when it took less', async () => {
    const w = world();
    const id = await booked(w);
    const { s, calls } = fakeStripe();
    await completeCallout(asDb(w), s, done(id, 1), NOW);
    expect(calls.find((c) => c.fn === 'creditPrepayment')!.arg).toMatchObject({
      invoiceId: 'in_1',
      amountExGstCents: 15000,
    });
    expect(row(w, id)).toMatchObject({
      status: 'completed',
      refundedCents: 16500,
      creditNoteId: 'cn_1',
    });
  });

  it('does nothing more when it took exactly the quoted time', async () => {
    const w = world();
    const id = await booked(w);
    const { s, calls } = fakeStripe();
    await completeCallout(asDb(w), s, done(id, 2), NOW);
    expect(calls).toHaveLength(0);
    expect(row(w, id).status).toBe('completed');
  });

  it('puts the booking back if Stripe fails, so nothing is half done', async () => {
    const w = world();
    const id = await booked(w);
    const { s } = fakeStripe({
      invoiceExtra: async () => {
        throw new Error('Stripe is down');
      },
    });
    await expect(completeCallout(asDb(w), s, done(id, 4), NOW)).rejects.toThrow('Stripe is down');
    expect(row(w, id).status).toBe('booked');
    expect(row(w, id).actualHours).toBeUndefined();
    const { s: ok } = fakeStripe();
    await completeCallout(asDb(w), ok, done(id, 4), NOW);
    expect(row(w, id).status).toBe('completed');
  });

  it('only completes a paid booking, once', async () => {
    const w = world();
    const id = await quoted(w);
    const { s } = fakeStripe();
    await expect(completeCallout(asDb(w), s, done(id, 2), NOW)).rejects.toThrow('paid booking');
    const id2 = await booked(world(), 5);
    expect(id2).toBeTruthy();
  });
});
