import { db } from '@kestrel/db';
import { cronAuthorised } from '@/server/cron-auth';
import { chargeOverdueInvoices } from '@/server/invoice-billing';
import { chargeInvoiceToCard, customerHasCard, stripeConfigured } from '@/server/stripe';

export const dynamic = 'force-dynamic';

// Daily: an invoice past its due date is charged to the card on file, if there is one.
export async function GET(req: Request) {
  if (!cronAuthorised(req)) return Response.json({ error: 'Unauthorised' }, { status: 401 });
  if (!stripeConfigured()) return Response.json({ skipped: 'Stripe is not set up' });
  const results = await chargeOverdueInvoices(db, {
    hasCard: customerHasCard,
    charge: chargeInvoiceToCard,
  });
  return Response.json({ results });
}
