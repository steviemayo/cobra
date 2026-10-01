import 'server-only';
import type Stripe from 'stripe';
import type { PrismaClient } from '@kestrel/db';
import { ensureBilling, type BillingDb } from './billing';
import { CURRENCY, GST_RATE, type CalloutStripe } from './callouts';
import { getStripe } from './stripe';

// The real Stripe behind a callout (see callouts.ts for the rules). GST is a 10% exclusive tax rate
// on every line, so the tax invoice for the prepayment, the invoice for extra time and any credit
// note all carry GST the same way.

let gstRate: string | null = null;

/** The 10% GST tax rate: from STRIPE_GST_TAX_RATE_ID, else an existing one, else it is created. */
export async function gstTaxRateId(stripe: Stripe): Promise<string> {
  const configured = process.env.STRIPE_GST_TAX_RATE_ID;
  if (configured) return configured;
  if (gstRate) return gstRate;
  const found = (await stripe.taxRates.list({ active: true, limit: 100 })).data.find(
    (r) =>
      r.percentage === GST_RATE * 100 &&
      !r.inclusive &&
      (r.country === 'AU' || /gst/i.test(r.display_name)),
  );
  gstRate = (
    found ??
    (await stripe.taxRates.create({
      display_name: 'GST',
      description: 'Goods and services tax',
      percentage: GST_RATE * 100,
      inclusive: false,
      country: 'AU',
      jurisdiction: 'AU',
    }))
  ).id;
  return gstRate;
}

const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

export function realCalloutStripe(db: Pick<PrismaClient, 'orgBilling' | 'org'>): CalloutStripe {
  const stripe = getStripe();
  return {
    async customerFor(orgId, email) {
      const billing = await ensureBilling(db as unknown as BillingDb, orgId);
      if (billing.stripeCustomerId) return billing.stripeCustomerId;
      const org = await db.org.findFirst({ where: { id: orgId } });
      const customer = await stripe.customers.create({
        ...(email ? { email } : {}),
        name: org?.name,
        metadata: { orgId },
      });
      await db.orgBilling.update({
        where: { id: billing.id },
        data: { stripeCustomerId: customer.id },
      });
      return customer.id;
    },

    async checkout(i) {
      const rate = await gstTaxRateId(stripe);
      const product = process.env.STRIPE_CALLOUT_PRODUCT_ID;
      const summary = `${i.hours} hours at ${dollars(i.rateCents)}/hour`;
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: i.customerId,
        client_reference_id: i.orgId,
        line_items: [
          {
            quantity: 1,
            tax_rates: [rate],
            price_data: {
              currency: CURRENCY,
              unit_amount: i.subtotalCents,
              tax_behavior: 'exclusive',
              ...(product
                ? { product }
                : {
                    product_data: {
                      name: 'Kestrel service callout',
                      description: `${i.title.slice(0, 120)}: ${summary}`,
                    },
                  }),
            },
          },
        ],
        // The paid session also issues the tax invoice for the prepayment, which a later credit
        // note adjusts if time was not used or the booking is cancelled.
        invoice_creation: {
          enabled: true,
          invoice_data: {
            description: `Prepayment for service callout: ${i.title.slice(0, 120)} (${summary})`,
            metadata: { calloutId: i.calloutId, orgId: i.orgId },
          },
        },
        payment_intent_data: { metadata: { calloutId: i.calloutId, orgId: i.orgId } },
        metadata: { kind: 'callout', calloutId: i.calloutId, orgId: i.orgId },
        custom_text: {
          submit: {
            message: `Secures your callout booking. Cancel up to 48 hours before for a full refund. ${summary}, plus GST.`,
          },
        },
        success_url: i.successUrl,
        cancel_url: i.cancelUrl,
      });
      if (!session.url) throw new Error('Stripe did not return a checkout address');
      return { id: session.id, url: session.url };
    },

    async expireCheckout(sessionId) {
      await stripe.checkout.sessions.expire(sessionId);
    },

    async prepaymentInvoice(sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      return typeof session.invoice === 'string' ? session.invoice : (session.invoice?.id ?? null);
    },

    async creditPrepayment(i) {
      const rate = await gstTaxRateId(stripe);
      const params = {
        invoice: i.invoiceId,
        reason: 'order_change' as const,
        memo: i.reason,
        lines: [
          {
            type: 'custom_line_item' as const,
            description: i.reason,
            quantity: 1,
            unit_amount: i.amountExGstCents,
            tax_rates: [rate],
          },
        ],
      };
      // Stripe works out the credit's total with GST; the whole of it goes back to the card.
      const preview = await stripe.creditNotes.preview(params);
      const note = await stripe.creditNotes.create({ ...params, refund_amount: preview.total });
      return { creditNoteId: note.id, refundedCents: note.total };
    },

    async invoiceExtra(i) {
      const rate = await gstTaxRateId(stripe);
      const invoice = await stripe.invoices.create({
        customer: i.customerId,
        collection_method: 'send_invoice',
        days_until_due: 14,
        currency: CURRENCY,
        pending_invoice_items_behavior: 'exclude',
        description: i.description,
        metadata: { calloutId: i.calloutId, kind: 'callout-extra' },
      });
      await stripe.invoiceItems.create({
        customer: i.customerId,
        invoice: invoice.id,
        currency: CURRENCY,
        amount: i.amountExGstCents,
        description: i.description,
        tax_rates: [rate],
      });
      const finalised = await stripe.invoices.finalizeInvoice(invoice.id);
      await stripe.invoices.sendInvoice(finalised.id);
      return {
        invoiceId: finalised.id,
        url: finalised.hosted_invoice_url ?? null,
        totalCents: finalised.total,
      };
    },
  };
}
