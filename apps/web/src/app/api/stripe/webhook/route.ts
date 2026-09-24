import { db } from '@kestrel/db';
import { priceMapFromEnv, handleStripeEvent } from '@/server/billing';
import { fulfilOrder, type MarketplaceSession } from '@/server/marketplace';
import { getStripe } from '@/server/stripe';

export const dynamic = 'force-dynamic';

// Stripe calls this when a subscription changes. The signature is checked against the raw body
// before anything is read, so only Stripe can change an organisation's plan.
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = req.headers.get('stripe-signature');
  if (!secret || !signature) return Response.json({ error: 'Not configured' }, { status: 400 });

  const body = await req.text();
  let event;
  try {
    event = await getStripe().webhooks.constructEventAsync(body, signature, secret);
  } catch {
    return Response.json({ error: 'Bad signature' }, { status: 400 });
  }
  // Marketplace purchases are one-off payments, told apart by the metadata Kestrel put on them.
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as unknown as MarketplaceSession;
    if (session.metadata?.kind === 'marketplace')
      return Response.json({ received: true, result: await fulfilOrder(db, session) });
  }
  const result = await handleStripeEvent(db, event, priceMapFromEnv());
  return Response.json({ received: true, result });
}
