import { describe, expect, it, vi } from 'vitest';
import { applyStripeSubscription, handleStripeEvent, type BillingDb } from './billing';
import {
  INVOICE_DAYS,
  InvoiceError,
  applyStripeInvoice,
  approvedInvoiceOrgs,
  assertInvoiceAllowed,
  chargeOverdueInvoices,
  decideInvoice,
  invoiceSubscriptionParams,
  pendingInvoiceRequests,
  requestInvoice,
  revokeInvoice,
  setInvoiceDays,
  type InvoiceDb,
} from './invoice-billing';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-03T00:00:00Z');

function world(billing: Record<string, unknown> = {}) {
  const orgBilling = table([
    {
      id: 'b1',
      orgId: ORG,
      plan: 'trial',
      status: 'none',
      invoiceStatus: 'none',
      invoiceDays: 14,
      collectionMethod: 'charge_automatically',
      stripeCustomerId: 'cus_1',
      ...billing,
    },
  ]);
  const auditLog = table([]);
  const staffAudit = table([]);
  return {
    db: {
      orgBilling,
      auditLog,
      staffAudit,
      org: table([{ id: ORG, name: 'Acme', createdAt: NOW }]),
      orgLicenseOverride: table([]),
      stripeEvent: table([]),
      room: table([]),
      device: table([]),
      deviceStatus: table([]),
    } as unknown as InvoiceDb & BillingDb,
    orgBilling,
    auditLog,
    staffAudit,
  };
}

describe('invoice subscription params', () => {
  it('is yearly-invoiced with 14 days to pay and the organisation in the metadata', () => {
    expect(
      invoiceSubscriptionParams({ orgId: ORG, customer: 'cus_1', price: 'price_y', quantity: 0 }),
    ).toEqual({
      customer: 'cus_1',
      items: [{ price: 'price_y', quantity: 1 }],
      collection_method: 'send_invoice',
      days_until_due: INVOICE_DAYS,
      metadata: { orgId: ORG },
    });
    expect(INVOICE_DAYS).toBe(14);
  });

  it('needs approval and a yearly interval', () => {
    expect(() => assertInvoiceAllowed({ invoiceStatus: 'none' }, 'year')).toThrow(InvoiceError);
    expect(() => assertInvoiceAllowed({ invoiceStatus: 'requested' }, 'year')).toThrow(/approved/);
    expect(() => assertInvoiceAllowed({ invoiceStatus: 'approved' }, 'month')).toThrow(/yearly/);
    expect(() => assertInvoiceAllowed({ invoiceStatus: 'approved' }, 'year')).not.toThrow();
  });
});

describe('the approval queue', () => {
  it('queues a request, lists it, and refuses a second one', async () => {
    const w = world();
    await requestInvoice(w.db, {
      orgId: ORG,
      userId: STAFF,
      note: ' AP wants an invoice ',
      now: NOW,
    });
    expect(w.orgBilling.rows[0]).toMatchObject({
      invoiceStatus: 'requested',
      invoiceRequestNote: 'AP wants an invoice',
    });
    expect(await pendingInvoiceRequests(w.db)).toEqual([
      { orgId: ORG, orgName: 'Acme', requestedAt: NOW, note: 'AP wants an invoice' },
    ]);
    await expect(requestInvoice(w.db, { orgId: ORG, userId: STAFF })).rejects.toThrow(/already/);
  });

  it('approves, recording who and when, and leaves the queue', async () => {
    const w = world({ invoiceStatus: 'requested' });
    await decideInvoice(w.db, { orgId: ORG, staffUserId: STAFF, approve: true, now: NOW });
    expect(w.orgBilling.rows[0]).toMatchObject({
      invoiceStatus: 'approved',
      invoiceDecidedBy: STAFF,
      invoiceDecidedAt: NOW,
    });
    expect(await pendingInvoiceRequests(w.db)).toEqual([]);
    expect(w.auditLog.rows[0]).toMatchObject({ action: 'billing.invoice_approved' });
    expect(w.staffAudit.rows[0]).toMatchObject({ action: 'billing.invoice_approved' });
  });

  it('declines only with a reason the owner will see, and can be asked again', async () => {
    const w = world({ invoiceStatus: 'requested' });
    await expect(
      decideInvoice(w.db, { orgId: ORG, staffUserId: STAFF, approve: false, reason: 'no' }),
    ).rejects.toThrow(/reason/);
    await decideInvoice(w.db, {
      orgId: ORG,
      staffUserId: STAFF,
      approve: false,
      reason: 'Please set up a card first',
    });
    expect(w.orgBilling.rows[0]).toMatchObject({
      invoiceStatus: 'declined',
      invoiceDeclineReason: 'Please set up a card first',
    });
    await requestInvoice(w.db, { orgId: ORG, userId: STAFF, now: NOW });
    expect(w.orgBilling.rows[0]).toMatchObject({
      invoiceStatus: 'requested',
      invoiceDeclineReason: null,
    });
  });

  it('refuses a decision when nothing was asked, and revokes only an approval', async () => {
    const w = world();
    await expect(
      decideInvoice(w.db, { orgId: ORG, staffUserId: STAFF, approve: true }),
    ).rejects.toThrow(/not asked/);
    await expect(
      revokeInvoice(w.db, { orgId: ORG, staffUserId: STAFF, reason: 'credit concern' }),
    ).rejects.toThrow(/not approved/);
    w.orgBilling.rows[0]!.invoiceStatus = 'approved';
    await revokeInvoice(w.db, { orgId: ORG, staffUserId: STAFF, reason: 'credit concern' });
    expect(w.orgBilling.rows[0]).toMatchObject({ invoiceStatus: 'declined' });
  });
});

describe('days to pay', () => {
  it('uses the customer days in the Stripe params, and refuses nonsense', () => {
    const p = (days?: number) =>
      invoiceSubscriptionParams({ orgId: ORG, customer: 'c', price: 'p', quantity: 1, days })
        .days_until_due;
    expect(p()).toBe(14);
    expect(p(30)).toBe(30);
    expect(() => p(0)).toThrow(/whole number/);
    expect(() => p(91)).toThrow(InvoiceError);
    expect(() => p(2.5)).toThrow(InvoiceError);
  });

  it('is set on approval, kept when left out, and changeable once approved', async () => {
    const w = world({ invoiceStatus: 'requested' });
    await decideInvoice(w.db, { orgId: ORG, staffUserId: STAFF, approve: true, days: 30 });
    expect(w.orgBilling.rows[0]).toMatchObject({ invoiceDays: 30 });
    await setInvoiceDays(w.db, { orgId: ORG, staffUserId: STAFF, days: 45 });
    expect(w.orgBilling.rows[0]).toMatchObject({ invoiceDays: 45 });
    expect(w.staffAudit.rows.at(-1)).toMatchObject({ action: 'billing.invoice_days' });
    expect(await approvedInvoiceOrgs(w.db)).toMatchObject([
      { orgId: ORG, days: 45, invoiced: false },
    ]);
    await expect(setInvoiceDays(w.db, { orgId: ORG, staffUserId: STAFF, days: 0 })).rejects.toThrow(
      InvoiceError,
    );
    const again = world({ invoiceStatus: 'requested', invoiceDays: 21 });
    await decideInvoice(again.db, { orgId: ORG, staffUserId: STAFF, approve: true });
    expect(again.orgBilling.rows[0]).toMatchObject({ invoiceDays: 21 });
  });

  it('only changes the days of an approved organisation', async () => {
    const w = world({ invoiceStatus: 'declined' });
    await expect(
      setInvoiceDays(w.db, { orgId: ORG, staffUserId: STAFF, days: 30 }),
    ).rejects.toThrow(/not approved/);
  });
});

describe('Stripe invoice events', () => {
  it('records an open invoice and clears it once paid', async () => {
    const w = world();
    const open = {
      id: 'in_1',
      customer: 'cus_1',
      status: 'open',
      collection_method: 'send_invoice',
      hosted_invoice_url: 'https://pay.example/in_1',
      due_date: 1_791_000_000,
    };
    expect(await applyStripeInvoice(w.db, open)).toBe(true);
    expect(w.orgBilling.rows[0]).toMatchObject({
      openInvoiceId: 'in_1',
      openInvoiceUrl: 'https://pay.example/in_1',
      openInvoiceDueAt: new Date(1_791_000_000 * 1000),
    });
    // A different invoice being paid does not clear the tracked one.
    await applyStripeInvoice(w.db, { ...open, id: 'in_other', status: 'paid' });
    expect(w.orgBilling.rows[0]).toMatchObject({ openInvoiceId: 'in_1' });
    await applyStripeInvoice(w.db, { ...open, status: 'paid' });
    expect(w.orgBilling.rows[0]).toMatchObject({ openInvoiceId: null, openInvoiceDueAt: null });
  });

  it('ignores card invoices and unknown customers', async () => {
    const w = world();
    expect(
      await applyStripeInvoice(w.db, {
        id: 'in_2',
        customer: 'cus_1',
        collection_method: 'charge_automatically',
        status: 'open',
      }),
    ).toBe(false);
    expect(
      await applyStripeInvoice(w.db, {
        id: 'in_3',
        customer: 'cus_x',
        collection_method: 'send_invoice',
        status: 'open',
      }),
    ).toBe(false);
  });

  it('is handled through the webhook, once', async () => {
    const w = world();
    const event = {
      id: 'evt_1',
      type: 'invoice.finalized',
      data: {
        object: {
          id: 'in_1',
          customer: 'cus_1',
          status: 'open',
          collection_method: 'send_invoice',
        },
      },
    };
    expect(await handleStripeEvent(w.db, event, {}, NOW)).toBe('applied');
    expect(await handleStripeEvent(w.db, event, {}, NOW)).toBe('duplicate');
  });

  it('keeps the collection method from the subscription', async () => {
    const w = world();
    await applyStripeSubscription(
      w.db,
      {
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        collection_method: 'send_invoice',
        items: { data: [{ id: 'si_1', quantity: 1, price: { id: 'price_y' } }] },
      },
      { basicYearly: 'price_y' },
      NOW,
    );
    expect(w.orgBilling.rows[0]).toMatchObject({
      collectionMethod: 'send_invoice',
      billingInterval: 'year',
    });
  });
});

describe('overdue invoices', () => {
  const overdue = {
    collectionMethod: 'send_invoice',
    openInvoiceId: 'in_1',
    openInvoiceDueAt: new Date('2026-10-02T00:00:00Z'),
  };

  it('charges the card on file once the invoice is past due', async () => {
    const w = world(overdue);
    const charge = vi.fn(async () => true);
    const res = await chargeOverdueInvoices(w.db, { hasCard: async () => true, charge }, NOW);
    expect(res).toEqual([{ orgId: ORG, outcome: 'charged' }]);
    expect(charge).toHaveBeenCalledWith('in_1');
    expect(w.auditLog.rows[0]).toMatchObject({ action: 'billing.invoice_card_charged' });
  });

  it('does nothing without a card, or for an invoice not yet due', async () => {
    const charge = vi.fn(async () => true);
    const noCard = world(overdue);
    expect(
      await chargeOverdueInvoices(noCard.db, { hasCard: async () => false, charge }, NOW),
    ).toEqual([{ orgId: ORG, outcome: 'no_card' }]);
    const early = world({ ...overdue, openInvoiceDueAt: new Date('2026-10-10T00:00:00Z') });
    expect(
      await chargeOverdueInvoices(early.db, { hasCard: async () => true, charge }, NOW),
    ).toEqual([]);
    expect(charge).not.toHaveBeenCalled();
  });

  it('reports a failed charge without throwing', async () => {
    const w = world(overdue);
    const res = await chargeOverdueInvoices(
      w.db,
      {
        hasCard: async () => true,
        charge: async () => {
          throw new Error('card declined');
        },
      },
      NOW,
    );
    expect(res).toEqual([{ orgId: ORG, outcome: 'failed' }]);
    expect(w.auditLog.rows).toHaveLength(0);
  });
});
