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
  providerComplete,
  providerSchedule,
  requestCallout,
  sendQuote,
  sendToKestrel,
  transferCallout,
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
    expireCheckout: async () => undefined,
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

describe('requesting from a ticket, and where a callout goes', () => {
  const PROVIDER = 'msp:99999999-9999-4999-8999-999999999999';
  const withProvider = async (): Promise<string | null> => PROVIDER;
  const noProvider = async (): Promise<string | null> => null;

  const incidentTicket = (w: W, over: Record<string, unknown> = {}) => {
    const row = {
      id: 'tk1',
      orgId: ORG,
      roomId: ROOM,
      incidentId: 'inc1',
      title: 'RMC4 is offline',
      status: 'open',
      routedTo: 'org',
      ...over,
    };
    w.ticket.rows.push(row);
    return row;
  };
  const from = (w: W, over: Record<string, unknown> = {}, find = noProvider) =>
    requestCallout(
      asDb(w),
      {
        orgId: ORG,
        ticketId: 'tk1',
        title: 'Replace RMC4',
        details: 'It has been offline since the morning',
        preferredDates: 'Tuesday am',
        userId: STAFF,
        email: 'pat@example.com',
        ...over,
      },
      NOW,
      find,
    );

  it('writes the request on the existing ticket and sends it to Kestrel, keeping its own record linked to it', async () => {
    const w = world();
    incidentTicket(w);
    const c = await from(w);
    expect(c).toMatchObject({
      ticketId: 'tk1',
      ownsTicket: false,
      routedTo: 'kestrel',
      roomId: ROOM,
      siteId: SITE,
      incidentId: 'inc1',
      status: 'requested',
    });
    // No second ticket: the conversation stays on the one that is there.
    expect(w.ticket.rows).toHaveLength(1);
    expect(w.ticket.rows[0]).toMatchObject({ routedTo: 'kestrel', escalatedBy: STAFF });
    const said = w.ticketComment.rows[0]!;
    expect(said).toMatchObject({ ticketId: 'tk1', visibility: 'public', fromStaff: false });
    expect(String(said.body)).toContain('Callout requested: Replace RMC4');
    expect(String(said.body)).toContain('Preferred times: Tuesday am');
  });

  it('later quotes are written on that ticket, and it is not closed when the callout ends', async () => {
    const w = world();
    incidentTicket(w);
    const c = await from(w);
    await sendQuote(
      asDb(w),
      c.id,
      { hours: 2, rateCents: 15000, scheduledFor: at(5), staffUserId: STAFF },
      NOW,
    );
    expect(w.ticketComment.rows.some((r) => String(r.body).startsWith('Quote for'))).toBe(true);
    const { s } = fakeStripe();
    await cancelByCustomer(asDb(w), s, { id: c.id, orgId: ORG }, NOW);
    expect(row(w, c.id).status).toBe('cancelled');
    // The incident ticket carries on: only a callout that opened its own ticket closes it.
    expect(w.ticket.rows[0]!.status).toBe('open');
  });

  it('an old ticket that was resolved is open again, and a closed one must be reopened first', async () => {
    const w = world();
    incidentTicket(w, { status: 'resolved' });
    await from(w);
    expect(w.ticket.rows[0]!.status).toBe('open');
    const w2 = world();
    incidentTicket(w2, { status: 'closed' });
    await expect(from(w2)).rejects.toThrow(/Reopen the ticket/);
  });

  it('refuses a second open callout for the same ticket, and a ticket from another organisation', async () => {
    const w = world();
    incidentTicket(w);
    await from(w);
    await expect(from(w)).rejects.toThrow(/already open for this ticket/);
    const w2 = world();
    incidentTicket(w2, { orgId: OTHER });
    await expect(from(w2)).rejects.toThrow(/not in this organisation/);
  });

  it('goes to the service provider that covers it, with the ticket, and is not for Kestrel to quote', async () => {
    const w = world();
    incidentTicket(w);
    const c = await from(w, {}, withProvider);
    expect(c.routedTo).toBe(PROVIDER);
    expect(w.ticket.rows[0]).toMatchObject({ routedTo: PROVIDER });
    expect(w.ticket.rows[0]!.escalatedBy).toBeUndefined();
    await expect(
      sendQuote(
        asDb(w),
        c.id,
        { hours: 2, rateCents: 15000, scheduledFor: at(5), staffUserId: STAFF },
        NOW,
      ),
    ).rejects.toThrow(/service provider/);
    const { s } = fakeStripe();
    await expect(
      completeCallout(asDb(w), s, { id: c.id, actualHours: 1, staffUserId: STAFF }, NOW),
    ).rejects.toThrow(/service provider/);
    await expect(cancelByStaff(asDb(w), s, { id: c.id, reason: 'x' }, NOW)).rejects.toThrow(
      /service provider/,
    );
  });

  it('a callout with its own new ticket follows the same rule', async () => {
    const w = world();
    const c = await requestCallout(
      asDb(w),
      { orgId: ORG, roomId: ROOM, title: 'Projector', details: 'Dead', userId: STAFF, email: null },
      NOW,
      withProvider,
    );
    expect(c).toMatchObject({ routedTo: PROVIDER, ownsTicket: true });
    expect(w.ticket.rows[0]).toMatchObject({ routedTo: PROVIDER });
    expect(w.ticket.rows[0]!.escalatedAt).toBeUndefined();
    const none = world();
    const k = await requestCallout(
      asDb(none),
      { orgId: ORG, title: 'Projector', details: 'Dead', userId: STAFF, email: null },
      NOW,
      noProvider,
    );
    expect(k.routedTo).toBe('kestrel');
    expect(none.ticket.rows[0]).toMatchObject({ routedTo: 'kestrel' });
  });

  it('an owner or dev can send it to Kestrel instead of the provider; anyone else cannot', async () => {
    const base = { orgId: ORG, title: 'P', details: 'D', userId: STAFF, email: null };
    const c = await requestCallout(
      asDb(world()),
      { ...base, roomId: ROOM, sendTo: 'kestrel', canChooseKestrel: true },
      NOW,
      withProvider,
    );
    expect(c.routedTo).toBe('kestrel');
    await expect(
      requestCallout(
        asDb(world()),
        { ...base, roomId: ROOM, sendTo: 'kestrel', canChooseKestrel: false },
        NOW,
        withProvider,
      ),
    ).rejects.toThrow(/Only an owner or dev/);
    // With no provider there is nothing to choose between: it is Kestrel's whoever asks.
    await expect(
      requestCallout(
        asDb(world()),
        { ...base, sendTo: 'kestrel', canChooseKestrel: false },
        NOW,
        noProvider,
      ),
    ).resolves.toMatchObject({ routedTo: 'kestrel' });
  });

  it('a request with a provider can be moved to Kestrel before it is quoted, taking its ticket along', async () => {
    const w = world();
    incidentTicket(w);
    const c = await from(w, {}, withProvider);
    const res = await sendToKestrel(
      asDb(w),
      { id: c.id, orgId: ORG, userId: STAFF, email: 'pat@example.com' },
      NOW,
    );
    expect(res).toMatchObject({ ticketId: 'tk1' });
    expect(row(w, c.id).routedTo).toBe('kestrel');
    expect(w.ticket.rows[0]).toMatchObject({ routedTo: 'kestrel', escalatedBy: STAFF });
    expect(String(w.ticketComment.rows.at(-1)!.body)).toContain('moved from the service provider to Kestrel by pat@example.com');
    // Kestrel can now quote it.
    await expect(
      sendQuote(
        asDb(w),
        c.id,
        { hours: 2, rateCents: 15000, scheduledFor: at(5), staffUserId: STAFF },
        NOW,
      ),
    ).resolves.toBeDefined();
    await expect(
      sendToKestrel(asDb(w), { id: c.id, orgId: ORG, userId: STAFF, email: null }, NOW),
    ).rejects.toThrow(/already with Kestrel/);
  });
});

describe('transfers and a service provider’s own work', () => {
  const PROV = 'msp:99999999-9999-4999-8999-999999999999';
  const OTHER_PROV = 'msp:99999999-9999-4999-8999-999999999998';
  const covers = async (route: string) => route === PROV;
  const kestrelStaff = {
    kind: 'kestrel' as const,
    userId: STAFF,
    email: 'staff@kestrel.example',
    label: 'Kestrel support',
  };
  const owner = {
    kind: 'customer' as const,
    userId: STAFF,
    email: 'pat@example.com',
    label: 'pat@example.com',
  };
  const provider = {
    kind: 'provider' as const,
    userId: STAFF,
    email: 'tech@prov.example',
    label: 'Acme AV',
  };
  const names = { [PROV]: 'Acme AV' };

  /** A callout with its own ticket, held by the provider. */
  const held = async (w: W) => {
    const c = await requestCallout(
      asDb(w),
      {
        orgId: ORG,
        roomId: ROOM,
        title: 'Projector',
        details: 'Dead',
        userId: STAFF,
        email: 'pat@example.com',
      },
      NOW,
      async () => PROV,
    );
    return c.id as string;
  };

  it('moves between Kestrel and a provider either way, clearing what the other arranged, and keeps a history', async () => {
    const w = world();
    const id = await quoted(w); // with Kestrel, quoted
    const res = await transferCallout(
      asDb(w),
      { id, to: PROV, by: kestrelStaff, note: 'Acme covers this site', names, isProvider: covers },
      NOW,
    );
    expect(res).toMatchObject({ from: 'kestrel', to: PROV });
    expect(row(w, id)).toMatchObject({
      routedTo: PROV,
      status: 'requested',
      hours: null,
      totalCents: null,
      scheduledFor: null,
      stripeSessionId: null,
    });
    expect(w.ticket.rows[0]).toMatchObject({ routedTo: PROV });
    const said = String(w.ticketComment.rows.at(-1)!.body);
    expect(said).toContain('moved from Kestrel to Acme AV by Kestrel support');
    expect(said).toContain('Acme covers this site');

    // And back: the provider hands it to Kestrel, who are marked as having escalated it.
    await transferCallout(
      asDb(w),
      { id, to: 'kestrel', by: provider, names, isProvider: covers },
      NOW,
    );
    expect(row(w, id).routedTo).toBe('kestrel');
    expect(w.ticket.rows[0]).toMatchObject({ routedTo: 'kestrel', escalatedBy: STAFF });
    expect(
      (row(w, id).history as { kind: string; by: string }[]).map((h) => [h.kind, h.by]),
    ).toEqual([
      ['requested', 'pat@example.com'],
      ['transferred', 'Kestrel support'],
      ['transferred', 'Acme AV'],
    ]);
  });

  it('refuses a paid booking, a finished callout, the same holder and a provider that does not cover it', async () => {
    const w = world();
    const id = await booked(w);
    await expect(
      transferCallout(asDb(w), { id, to: PROV, by: owner, names, isProvider: covers }, NOW),
    ).rejects.toThrow(/paid for/);
    row(w, id).status = 'completed';
    await expect(
      transferCallout(asDb(w), { id, to: PROV, by: owner, names, isProvider: covers }, NOW),
    ).rejects.toThrow(/only be moved while/);
    const w2 = world();
    const id2 = await quoted(w2);
    await expect(
      transferCallout(
        asDb(w2),
        { id: id2, to: 'kestrel', by: owner, names, isProvider: covers },
        NOW,
      ),
    ).rejects.toThrow(/already with Kestrel/);
    await expect(
      transferCallout(
        asDb(w2),
        { id: id2, to: OTHER_PROV, by: owner, names, isProvider: covers },
        NOW,
      ),
    ).rejects.toThrow(/does not cover/);
    expect(row(w2, id2).routedTo).toBe('kestrel');
    await expect(
      transferCallout(
        asDb(w2),
        { id: id2, orgId: OTHER, to: PROV, by: owner, names, isProvider: covers },
        NOW,
      ),
    ).rejects.toThrow(/not found/);
  });

  it('stops an open payment page before a quoted callout changes hands, and refuses if that cannot be done', async () => {
    const w = world();
    const id = await quoted(w);
    const expired: string[] = [];
    const { s } = fakeStripe({
      expireCheckout: async (sid) => {
        expired.push(sid);
      },
    });
    row(w, id).stripeSessionId = 'cs_open';
    await transferCallout(
      asDb(w),
      { id, to: PROV, by: owner, names, isProvider: covers, stripe: s },
      NOW,
    );
    expect(expired).toEqual(['cs_open']);

    const w2 = world();
    const id2 = await quoted(w2);
    row(w2, id2).stripeSessionId = 'cs_paying';
    const failing = fakeStripe({
      expireCheckout: async () => {
        throw new Error('already complete');
      },
    }).s;
    await expect(
      transferCallout(
        asDb(w2),
        { id: id2, to: PROV, by: owner, names, isProvider: covers, stripe: failing },
        NOW,
      ),
    ).rejects.toThrow(/payment is in progress/);
    expect(row(w2, id2).routedTo).toBe('kestrel');
    await expect(
      transferCallout(asDb(w2), { id: id2, to: PROV, by: owner, names, isProvider: covers }, NOW),
    ).rejects.toThrow(/payment page is open/);
  });

  it('a new Kestrel quote closes the payment page for the old price', async () => {
    const w = world();
    const id = await quoted(w);
    row(w, id).stripeSessionId = 'cs_old';
    const expired: string[] = [];
    const { s } = fakeStripe({
      expireCheckout: async (sid) => {
        expired.push(sid);
      },
    });
    await sendQuote(
      asDb(w),
      id,
      { hours: 3, rateCents: 15000, scheduledFor: at(6), staffUserId: STAFF },
      NOW,
      s,
    );
    expect(expired).toEqual(['cs_old']);
  });

  it('the provider that holds it schedules a visit, and the customer is told, in the site’s time', async () => {
    const w = world();
    const id = await held(w);
    const base = {
      id,
      orgId: ORG,
      route: PROV,
      providerName: 'Acme AV',
      userId: STAFF,
      email: 'tech@prov.example',
      zone: 'Australia/Sydney',
    };
    await providerSchedule(
      asDb(w),
      { ...base, scheduledFor: new Date('2026-10-05T23:00:00Z'), note: 'Bring a lamp' },
      NOW,
    );
    expect(row(w, id)).toMatchObject({ status: 'scheduled' });
    expect(row(w, id).scheduledFor).toEqual(new Date('2026-10-05T23:00:00Z'));
    const said = String(w.ticketComment.rows.at(-1)!.body);
    // 23:00 UTC on 5 Oct is 10:00 am AEDT on 6 Oct in Sydney.
    expect(said).toContain('Acme AV scheduled a visit for “Projector”: 6 Oct 2026, 10:00 am AEDT.');
    expect(said).toContain('Bring a lamp');
    // It can be rescheduled, and the customer can still cancel it for nothing.
    await providerSchedule(
      asDb(w),
      { ...base, scheduledFor: new Date('2026-10-07T23:00:00Z') },
      NOW,
    );
    const { s } = fakeStripe();
    const out = await cancelByCustomer(asDb(w), s, { id, orgId: ORG }, NOW);
    expect(out).toEqual({ refundedCents: 0, refundable: false });
  });

  it('only the provider that holds it can schedule or complete, and not a past time', async () => {
    const w = world();
    const id = await held(w);
    const base = {
      id,
      orgId: ORG,
      providerName: 'X',
      userId: STAFF,
      email: null,
      zone: 'Australia/Sydney',
    };
    await expect(
      providerSchedule(asDb(w), { ...base, route: OTHER_PROV, scheduledFor: at(3) }, NOW),
    ).rejects.toThrow(/not with your service provider/);
    await expect(
      providerSchedule(asDb(w), { ...base, route: PROV, scheduledFor: at(-2) }, NOW),
    ).rejects.toThrow(/has not passed/);
    await expect(
      providerComplete(asDb(w), { ...base, route: OTHER_PROV, note: 'Done' }, NOW),
    ).rejects.toThrow(/not with your service provider/);
    // A callout that Kestrel has is not the provider's to work on.
    const w2 = world();
    const k = await quoted(w2);
    await expect(
      providerSchedule(asDb(w2), { ...base, id: k, route: PROV, scheduledFor: at(3) }, NOW),
    ).rejects.toThrow(/not with your service provider/);
  });

  it('completing records the hours and what was done, on the callout and the ticket, without any charge', async () => {
    const w = world();
    const id = await held(w);
    await expect(
      providerComplete(
        asDb(w),
        {
          id,
          orgId: ORG,
          route: PROV,
          providerName: 'Acme AV',
          note: ' ',
          userId: STAFF,
          email: null,
        },
        NOW,
      ),
    ).rejects.toThrow(/Say what was done/);
    await expect(
      providerComplete(
        asDb(w),
        {
          id,
          orgId: ORG,
          route: PROV,
          providerName: 'Acme AV',
          note: 'Done',
          actualHours: 500,
          userId: STAFF,
          email: null,
        },
        NOW,
      ),
    ).rejects.toThrow(/Hours must be/);
    await providerComplete(
      asDb(w),
      {
        id,
        orgId: ORG,
        route: PROV,
        providerName: 'Acme AV',
        actualHours: 1.5,
        note: 'Replaced the lamp',
        userId: STAFF,
        email: 'tech@prov.example',
      },
      NOW,
    );
    expect(row(w, id)).toMatchObject({
      status: 'completed',
      actualHours: 1.5,
      completionNote: 'Replaced the lamp',
      completedByName: 'Acme AV',
      completedAt: NOW,
    });
    expect(row(w, id).stripeInvoiceId).toBeUndefined();
    expect(String(w.ticketComment.rows.at(-1)!.body)).toContain(
      'Acme AV completed the callout “Projector” (1.5 hours).',
    );
    // The callout opened its own ticket, so completing it resolves the ticket.
    expect(w.ticket.rows[0]!.status).toBe('resolved');
    expect((row(w, id).history as { kind: string }[]).map((h) => h.kind)).toEqual([
      'requested',
      'completed',
    ]);
    await expect(
      providerComplete(
        asDb(w),
        {
          id,
          orgId: ORG,
          route: PROV,
          providerName: 'Acme AV',
          note: 'Again',
          userId: STAFF,
          email: null,
        },
        NOW,
      ),
    ).rejects.toThrow(/Only an open callout/);
  });

  it('completing a callout requested from an incident’s ticket leaves that ticket open', async () => {
    const w = world();
    w.ticket.rows.push({
      id: 'tk1',
      orgId: ORG,
      roomId: ROOM,
      incidentId: 'inc1',
      title: 'RMC4 is offline',
      status: 'open',
      routedTo: 'org',
    });
    const c = await requestCallout(
      asDb(w),
      {
        orgId: ORG,
        ticketId: 'tk1',
        title: 'Replace RMC4',
        details: 'Offline',
        userId: STAFF,
        email: null,
      },
      NOW,
      async () => PROV,
    );
    await providerComplete(
      asDb(w),
      {
        id: c.id,
        orgId: ORG,
        route: PROV,
        providerName: 'Acme AV',
        note: 'Replaced it',
        userId: STAFF,
        email: null,
      },
      NOW,
    );
    expect(row(w, c.id).status).toBe('completed');
    expect(w.ticket.rows[0]!.status).toBe('open');
  });
});
