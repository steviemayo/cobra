import type { PrismaClient } from '@kestrel/db';
import { writeAudit } from './audit';
import { ensureBilling, type EntitlementDb } from './billing';
import { recordStaffAudit, type StaffDb } from './staff';

// Pay by invoice instead of card. Yearly only, and still a Stripe subscription: the owner asks, staff
// approve, and Stripe emails the invoice (`send_invoice`, due in INVOICE_DAYS). Access starts when the
// invoice is issued; if it is still unpaid at its due date and a card is on file, the card is charged.
export const INVOICE_DAYS = 14;
export const MAX_INVOICE_DAYS = 90;

/** Staff set the days to pay per customer: a whole number from 1 to MAX_INVOICE_DAYS. */
export function validInvoiceDays(days: number): number {
  if (!Number.isInteger(days) || days < 1 || days > MAX_INVOICE_DAYS)
    throw new InvoiceError(`Days to pay must be a whole number from 1 to ${MAX_INVOICE_DAYS}.`);
  return days;
}

export class InvoiceError extends Error {}

export type InvoiceStatus = 'none' | 'requested' | 'approved' | 'declined';
export type InvoiceDb = EntitlementDb & StaffDb & Pick<PrismaClient, 'orgBilling'>;

/** What to send Stripe to create a yearly subscription that is billed by invoice. */
export function invoiceSubscriptionParams(input: {
  orgId: string;
  customer: string;
  price: string;
  quantity: number;
  days?: number;
}) {
  return {
    customer: input.customer,
    items: [{ price: input.price, quantity: Math.max(1, input.quantity) }],
    collection_method: 'send_invoice' as const,
    days_until_due: validInvoiceDays(input.days ?? INVOICE_DAYS),
    metadata: { orgId: input.orgId },
  };
}

/** Invoice billing is yearly only, and only once staff have approved it. */
export function assertInvoiceAllowed(billing: { invoiceStatus: string }, interval: string): void {
  if (billing.invoiceStatus !== 'approved')
    throw new InvoiceError('Invoice billing has not been approved for this organisation.');
  if (interval !== 'year') throw new InvoiceError('Invoice billing is yearly only.');
}

/** The owner asks to pay by invoice. Staff see it in the pending list. */
export async function requestInvoice(
  db: InvoiceDb,
  args: { orgId: string; userId: string; note?: string; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  const billing = await ensureBilling(db, args.orgId, now);
  if (billing.invoiceStatus === 'approved')
    throw new InvoiceError('Invoice billing is already approved.');
  if (billing.invoiceStatus === 'requested')
    throw new InvoiceError('Your request is already with Kestrel staff.');
  const note = args.note?.trim() ?? '';
  if (note.length > 500) throw new InvoiceError('Keep the note under 500 characters.');
  await db.orgBilling.update({
    where: { id: billing.id },
    data: {
      invoiceStatus: 'requested',
      invoiceRequestedAt: now,
      invoiceRequestNote: note || null,
      invoiceDecidedAt: null,
      invoiceDecidedBy: null,
      invoiceDeclineReason: null,
    },
  });
  await writeAudit(
    { orgId: args.orgId, actorId: args.userId, action: 'billing.invoice_request', meta: { note } },
    db,
  );
}

/** Staff approve or decline. Declining needs a reason the owner will see. */
export async function decideInvoice(
  db: InvoiceDb,
  args: {
    orgId: string;
    staffUserId: string;
    approve: boolean;
    reason?: string;
    /** Days to pay; kept as it was (14 for a new customer) when left out. */
    days?: number;
    now?: Date;
  },
): Promise<void> {
  const now = args.now ?? new Date();
  const billing = await ensureBilling(db, args.orgId, now);
  const reason = args.reason?.trim() ?? '';
  if (!args.approve && reason.length < 5)
    throw new InvoiceError('Give a reason of at least 5 characters.');
  if (reason.length > 500) throw new InvoiceError('Keep the reason under 500 characters.');
  if (billing.invoiceStatus === 'none')
    throw new InvoiceError('This organisation has not asked for invoice billing.');
  const days = args.days === undefined ? undefined : validInvoiceDays(args.days);
  await db.orgBilling.update({
    where: { id: billing.id },
    data: {
      invoiceStatus: args.approve ? 'approved' : 'declined',
      invoiceDecidedAt: now,
      invoiceDecidedBy: args.staffUserId,
      invoiceDeclineReason: args.approve ? null : reason,
      ...(args.approve && days !== undefined ? { invoiceDays: days } : {}),
    },
  });
  const action = args.approve ? 'billing.invoice_approved' : 'billing.invoice_declined';
  await writeAudit({ orgId: args.orgId, actorId: null, action, meta: { staff: true } }, db);
  await recordStaffAudit(db, {
    staffUserId: args.staffUserId,
    action,
    orgId: args.orgId,
    meta: {
      ...(reason ? { reason } : {}),
      ...(args.approve ? { days: days ?? billing.invoiceDays } : {}),
    },
  });
}

/** Changes the days to pay for a customer. Applies to invoices issued from now on. */
export async function setInvoiceDays(
  db: InvoiceDb,
  args: { orgId: string; staffUserId: string; days: number },
): Promise<void> {
  const days = validInvoiceDays(args.days);
  const billing = await ensureBilling(db, args.orgId);
  if (billing.invoiceStatus !== 'approved')
    throw new InvoiceError('Invoice billing is not approved for this organisation.');
  await db.orgBilling.update({ where: { id: billing.id }, data: { invoiceDays: days } });
  await recordStaffAudit(db, {
    staffUserId: args.staffUserId,
    action: 'billing.invoice_days',
    orgId: args.orgId,
    meta: { from: billing.invoiceDays, to: days },
  });
}

/**
 * Staff turn invoice billing off. The current term is left alone: Stripe keeps invoicing until the
 * subscription renews or is cancelled, so this only stops the owner choosing it again.
 */
export async function revokeInvoice(
  db: InvoiceDb,
  args: { orgId: string; staffUserId: string; reason: string; now?: Date },
): Promise<void> {
  const reason = args.reason.trim();
  if (reason.length < 5) throw new InvoiceError('Give a reason of at least 5 characters.');
  const billing = await ensureBilling(db, args.orgId, args.now);
  if (billing.invoiceStatus !== 'approved')
    throw new InvoiceError('Invoice billing is not approved for this organisation.');
  await db.orgBilling.update({
    where: { id: billing.id },
    data: {
      invoiceStatus: 'declined',
      invoiceDecidedAt: args.now ?? new Date(),
      invoiceDecidedBy: args.staffUserId,
      invoiceDeclineReason: reason,
    },
  });
  await writeAudit(
    { orgId: args.orgId, actorId: null, action: 'billing.invoice_revoked', meta: { staff: true } },
    db,
  );
  await recordStaffAudit(db, {
    staffUserId: args.staffUserId,
    action: 'billing.invoice_revoked',
    orgId: args.orgId,
    meta: { reason },
  });
}

export interface InvoiceRequestView {
  orgId: string;
  orgName: string;
  requestedAt: Date | null;
  note: string | null;
}

export interface ApprovedInvoiceView {
  orgId: string;
  orgName: string;
  days: number;
  decidedAt: Date | null;
  /** Whether the subscription is billed by invoice yet. */
  invoiced: boolean;
}

/** Organisations approved for invoice billing, newest first. */
export async function approvedInvoiceOrgs(db: InvoiceDb): Promise<ApprovedInvoiceView[]> {
  const rows = await db.orgBilling.findMany({
    where: { invoiceStatus: 'approved' },
    orderBy: { invoiceDecidedAt: 'desc' },
  });
  if (!rows.length) return [];
  const orgs = await db.org.findMany({});
  const name = new Map(orgs.map((o) => [o.id, o.name]));
  return rows.map((r) => ({
    orgId: r.orgId,
    orgName: name.get(r.orgId) ?? 'Unknown organisation',
    days: r.invoiceDays,
    decidedAt: r.invoiceDecidedAt,
    invoiced: r.collectionMethod === 'send_invoice',
  }));
}

/** Requests waiting for staff, oldest first. */
export async function pendingInvoiceRequests(db: InvoiceDb): Promise<InvoiceRequestView[]> {
  const rows = await db.orgBilling.findMany({
    where: { invoiceStatus: 'requested' },
    orderBy: { invoiceRequestedAt: 'asc' },
  });
  if (!rows.length) return [];
  const orgs = await db.org.findMany({});
  const name = new Map(orgs.map((o) => [o.id, o.name]));
  return rows.map((r) => ({
    orgId: r.orgId,
    orgName: name.get(r.orgId) ?? 'Unknown organisation',
    requestedAt: r.invoiceRequestedAt,
    note: r.invoiceRequestNote,
  }));
}

// ---- Stripe invoice events -------------------------------------------------------------------------

export interface StripeInvoiceLike {
  id: string;
  customer: string | { id: string } | null;
  status?: string | null;
  hosted_invoice_url?: string | null;
  due_date?: number | null;
  collection_method?: string;
  /** The subscription it bills, in either shape Stripe has used. */
  subscription?: string | { id: string } | null;
  parent?: {
    subscription_details?: { subscription?: string | { id: string } | null } | null;
  } | null;
}

/** Keeps the latest open invoice on the billing row; clears it once paid, voided or written off. */
export async function applyStripeInvoice(
  db: Pick<PrismaClient, 'orgBilling'>,
  invoice: StripeInvoiceLike,
): Promise<boolean> {
  if (invoice.collection_method && invoice.collection_method !== 'send_invoice') return false;
  const customer = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  if (!customer) return false;
  const billing = await db.orgBilling.findFirst({ where: { stripeCustomerId: customer } });
  if (!billing) return false;
  // An invoice for a subscription this customer pays on another organisation's behalf (a provider
  // paying for its customer, BD-6) belongs to that subscription, not to the payer's own plan.
  const sub = invoice.subscription ?? invoice.parent?.subscription_details?.subscription;
  const subId = typeof sub === 'string' ? sub : sub?.id;
  if (subId) {
    const owner = await db.orgBilling.findFirst({ where: { stripeSubscriptionId: subId } });
    if (owner && owner.orgId !== billing.orgId) return false;
  }
  if (invoice.status === 'open') {
    await db.orgBilling.update({
      where: { id: billing.id },
      data: {
        openInvoiceId: invoice.id,
        openInvoiceUrl: invoice.hosted_invoice_url ?? null,
        openInvoiceDueAt: invoice.due_date ? new Date(invoice.due_date * 1000) : null,
      },
    });
    return true;
  }
  // Paid, void or uncollectible: only clear it if it is the invoice we are tracking.
  if (billing.openInvoiceId === invoice.id)
    await db.orgBilling.update({
      where: { id: billing.id },
      data: { openInvoiceId: null, openInvoiceUrl: null, openInvoiceDueAt: null },
    });
  return true;
}

export interface OverdueResult {
  orgId: string;
  outcome: 'charged' | 'no_card' | 'failed';
}

/**
 * Daily sweep: an invoice past its due date with a card on file is charged to that card. `charge`
 * is Stripe's `invoices.pay` against the customer's default payment method (injected for tests).
 * With no card, or a failed charge, nothing changes here; Stripe's overdue-invoice setting decides
 * what happens to the subscription.
 */
export async function chargeOverdueInvoices(
  db: Pick<PrismaClient, 'orgBilling' | 'auditLog'>,
  deps: {
    hasCard: (customerId: string) => Promise<boolean>;
    charge: (invoiceId: string) => Promise<boolean>;
  },
  now = new Date(),
): Promise<OverdueResult[]> {
  const due = await db.orgBilling.findMany({
    where: { collectionMethod: 'send_invoice', openInvoiceDueAt: { lt: now } },
  });
  const out: OverdueResult[] = [];
  for (const b of due) {
    if (!b.openInvoiceId || !b.stripeCustomerId) continue;
    if (!(await deps.hasCard(b.stripeCustomerId))) {
      out.push({ orgId: b.orgId, outcome: 'no_card' });
      continue;
    }
    const ok = await deps.charge(b.openInvoiceId).catch(() => false);
    if (ok)
      await writeAudit(
        {
          orgId: b.orgId,
          actorId: null,
          action: 'billing.invoice_card_charged',
          target: b.openInvoiceId,
          meta: { automatic: true },
        },
        db,
      );
    out.push({ orgId: b.orgId, outcome: ok ? 'charged' : 'failed' });
  }
  return out;
}
