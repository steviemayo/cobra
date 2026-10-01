import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { entitlementsFor } from '@kestrel/model';
import {
  canMonitorRoom,
  monitoredRoomIds,
  applyStripeSubscription,
  canAddRoom,
  ensureBilling,
  getEntitlements,
  handleStripeEvent,
  planRequired,
  roomLimitMessage,
  type BillingDb,
  type StripeSubscriptionLike,
} from './billing';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '11111111-1111-4111-8111-111111111112';
const NOW = new Date('2026-09-24T00:00:00Z');
const prices = { basic: 'price_basic', pro: 'price_pro' };

function world() {
  const orgBilling = table([]);
  const stripeEvent = table([]);
  const room = table([]);
  const org = table([
    { id: ORG, createdAt: new Date('2026-09-20T00:00:00Z') },
    { id: OTHER, createdAt: new Date('2026-01-01T00:00:00Z') },
  ]);
  return {
    db: { orgBilling, stripeEvent, room, org } as unknown as BillingDb,
    orgBilling,
    stripeEvent,
  };
}

const sub = (over: Partial<StripeSubscriptionLike> = {}): StripeSubscriptionLike => ({
  id: 'sub_1',
  customer: 'cus_1',
  status: 'active',
  cancel_at_period_end: false,
  metadata: { orgId: ORG },
  items: {
    data: [
      { id: 'si_1', quantity: 4, current_period_end: 1_790_000_000, price: { id: 'price_pro' } },
    ],
  },
  ...over,
});

describe('billing rows', () => {
  it('starts a new organisation on a 30-day trial counted from when it was created', async () => {
    const w = world();
    const b = await ensureBilling(w.db, ORG, NOW);
    expect(b).toMatchObject({ plan: 'trial', status: 'none' });
    expect(b.trialEndsAt).toEqual(new Date('2026-10-20T00:00:00Z'));
    expect((await ensureBilling(w.db, ORG, NOW)).id).toBe(b.id);
    expect(w.orgBilling.rows).toHaveLength(1);
  });

  it('reports what the organisation may do', async () => {
    const w = world();
    expect((await getEntitlements(w.db, ORG, NOW)).monitoring).toBe(true);
    expect((await getEntitlements(w.db, OTHER, NOW)).plan).toBe('trial_expired');
  });

  it('limits rooms only where the plan has a limit', () => {
    const trial = entitlementsFor(
      { plan: 'trial', status: 'none', trialEndsAt: new Date(NOW.getTime() + 86_400_000) },
      NOW,
    );
    expect(canAddRoom(trial, 4)).toBe(true);
    expect(canAddRoom(trial, 5)).toBe(false);
    const pro = entitlementsFor({ plan: 'pro', status: 'active', trialEndsAt: null }, NOW);
    expect(canAddRoom(pro, 499)).toBe(true);
    expect(canAddRoom(pro, 500)).toBe(false);
    // An ended trial keeps its rooms watched but adds none.
    const ended = entitlementsFor(
      { plan: 'trial', status: 'none', trialEndsAt: new Date(NOW.getTime() - 1) },
      NOW,
    );
    expect(canAddRoom(ended, 0)).toBe(false);
    expect(roomLimitMessage(ended)).toMatch(/no new rooms/);
    expect(roomLimitMessage(pro)).toMatch(/500 rooms/);
    expect(planRequired('monitoring')).toBe('PLAN_REQUIRED:monitoring');
  });
});

describe('Stripe subscriptions', () => {
  it('moves the organisation to the plan its price maps to', async () => {
    const w = world();
    expect(await applyStripeSubscription(w.db, sub(), prices, NOW)).toBe(true);
    expect(w.orgBilling.rows[0]).toMatchObject({
      orgId: ORG,
      plan: 'pro',
      status: 'active',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      stripeItemId: 'si_1',
      quantity: 4,
      cancelAtPeriodEnd: false,
    });
    expect(w.orgBilling.rows[0]!.currentPeriodEnd).toEqual(new Date(1_790_000_000 * 1000));
  });

  it('follows a plan change and a cancellation request', async () => {
    const w = world();
    await applyStripeSubscription(w.db, sub(), prices, NOW);
    await applyStripeSubscription(
      w.db,
      sub({
        cancel_at_period_end: true,
        items: { data: [{ id: 'si_1', quantity: 6, price: { id: 'price_basic' } }] },
      }),
      prices,
      NOW,
    );
    expect(w.orgBilling.rows[0]).toMatchObject({
      plan: 'basic',
      quantity: 6,
      cancelAtPeriodEnd: true,
    });
  });

  it('does not guess when it does not know the price', async () => {
    const w = world();
    await applyStripeSubscription(w.db, sub(), prices, NOW);
    await applyStripeSubscription(
      w.db,
      sub({ items: { data: [{ id: 'si_2', price: { id: 'price_unknown' } }] } }),
      prices,
      NOW,
    );
    expect(w.orgBilling.rows[0]!.plan).toBe('pro');
  });

  it('finds the organisation by customer when metadata is missing', async () => {
    const w = world();
    await applyStripeSubscription(w.db, sub(), prices, NOW);
    expect(
      await applyStripeSubscription(w.db, sub({ metadata: null, status: 'past_due' }), prices, NOW),
    ).toBe(true);
    expect(w.orgBilling.rows[0]!.status).toBe('past_due');
  });

  it('refuses a subscription it cannot match, and never re-homes a customer to another organisation', async () => {
    const w = world();
    expect(
      await applyStripeSubscription(
        w.db,
        sub({ metadata: null, customer: 'cus_unknown' }),
        prices,
        NOW,
      ),
    ).toBe(false);
    await applyStripeSubscription(w.db, sub(), prices, NOW);
    expect(
      await applyStripeSubscription(
        w.db,
        sub({ customer: 'cus_2', metadata: { orgId: ORG } }),
        prices,
        NOW,
      ),
    ).toBe(false);
    expect(w.orgBilling.rows[0]!.stripeCustomerId).toBe('cus_1');
  });
});

describe('Stripe webhook events', () => {
  const event = (id: string, type: string, object: unknown) => ({ id, type, data: { object } });

  it('applies each event once', async () => {
    const w = world();
    const e = event('evt_1', 'customer.subscription.created', sub());
    expect(await handleStripeEvent(w.db, e, prices, NOW)).toBe('applied');
    w.orgBilling.rows[0]!.status = 'tampered';
    expect(await handleStripeEvent(w.db, e, prices, NOW)).toBe('duplicate');
    expect(w.orgBilling.rows[0]!.status).toBe('tampered');
    expect(w.stripeEvent.rows).toHaveLength(1);
  });

  it('treats a deleted subscription as cancelled, which drops the organisation to Basic', async () => {
    const w = world();
    await handleStripeEvent(
      w.db,
      event('evt_1', 'customer.subscription.created', sub()),
      prices,
      NOW,
    );
    await handleStripeEvent(
      w.db,
      event('evt_2', 'customer.subscription.deleted', sub({ status: 'active' })),
      prices,
      NOW,
    );
    const b = w.orgBilling.rows[0]!;
    expect(b.status).toBe('canceled');
    expect(
      entitlementsFor(
        { plan: b.plan as 'pro', status: b.status as string, trialEndsAt: b.trialEndsAt as Date },
        NOW,
      ),
    ).toMatchObject({ plan: 'lapsed', monitoring: true, control: false });
  });

  it('links the customer when checkout completes', async () => {
    const w = world();
    const res = await handleStripeEvent(
      w.db,
      event('evt_1', 'checkout.session.completed', { client_reference_id: ORG, customer: 'cus_9' }),
      prices,
      NOW,
    );
    expect(res).toBe('applied');
    expect(w.orgBilling.rows[0]!.stripeCustomerId).toBe('cus_9');
  });

  it('ignores event types it does not use, and still records them', async () => {
    const w = world();
    expect(await handleStripeEvent(w.db, event('evt_1', 'charge.succeeded', {}), prices, NOW)).toBe(
      'ignored',
    );
    expect(w.stripeEvent.rows).toHaveLength(1);
  });

  it('reports an event it could not match to an organisation', async () => {
    const w = world();
    const e = event(
      'evt_1',
      'customer.subscription.updated',
      sub({ metadata: null, customer: 'cus_nobody' }),
    );
    expect(await handleStripeEvent(w.db, e, prices, NOW)).toBe('unmatched');
  });
});

describe('Stripe signatures', () => {
  const stripe = new Stripe('sk_test_unused');
  const secret = 'whsec_test_secret';
  const payload = JSON.stringify({
    id: 'evt_1',
    object: 'event',
    type: 'customer.subscription.updated',
    data: { object: {} },
  });

  it('accepts a body signed with the webhook secret', async () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    const event = await stripe.webhooks.constructEventAsync(payload, header, secret);
    expect(event.id).toBe('evt_1');
  });

  it('rejects a forged or altered body', async () => {
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_someone_else',
    });
    await expect(stripe.webhooks.constructEventAsync(payload, header, secret)).rejects.toThrow();
    const good = stripe.webhooks.generateTestHeaderString({ payload, secret });
    await expect(
      stripe.webhooks.constructEventAsync(payload + ' ', good, secret),
    ).rejects.toThrow();
  });
});

describe('monitored rooms (what is charged)', () => {
  const ORG2 = '11111111-1111-4111-8111-111111111111';
  const world = () => {
    const room = table([
      { id: 'r1', orgId: ORG2, kind: 'standard' },
      { id: 'r2', orgId: ORG2, kind: 'standard' },
      { id: 'r3', orgId: ORG2, kind: 'staging' },
      { id: 'r4', orgId: ORG2, kind: 'standard' },
    ]);
    const device = table([
      { id: 'd1', orgId: ORG2, roomId: 'r1', kind: 'active' },
      { id: 'd2', orgId: ORG2, roomId: 'r1', kind: 'active' },
      { id: 'd3', orgId: ORG2, roomId: 'r2', kind: 'passive' },
      { id: 'd4', orgId: ORG2, roomId: 'r3', kind: 'active' },
    ]);
    const deviceStatus = table([{ id: 's1', orgId: ORG2, roomId: 'r4' }]);
    return { room, device, deviceStatus } as never;
  };
  /** The same estate with a shared monitored device (d1) linked to r2 and r3, and a recorded asset (d3) linked to r5. */
  const sharedWorld = () => {
    const w = world() as unknown as { room: ReturnType<typeof table>; device: ReturnType<typeof table>; deviceStatus: unknown };
    w.room.rows.push({ id: 'r5', orgId: ORG2, kind: 'standard' });
    const deviceRoom = table([
      { id: 'l1', orgId: ORG2, deviceId: 'd1', roomId: 'r2' },
      { id: 'l2', orgId: ORG2, deviceId: 'd1', roomId: 'r3' },
      { id: 'l3', orgId: ORG2, deviceId: 'd3', roomId: 'r5' },
    ]);
    return { ...w, deviceRoom } as never;
  };

  it('counts a room that only shares a monitored device, once, and not for a recorded asset or a staging room', async () => {
    const ids = await monitoredRoomIds(sharedWorld(), ORG2);
    expect([...ids].sort()).toEqual(['r1', 'r2', 'r4']);
  });

  it('counts the shared rooms against the limit', async () => {
    const e = { maxRooms: 3 } as never;
    expect(await canMonitorRoom(sharedWorld(), ORG2, e, 'r5')).toBe(false);
    expect(await canMonitorRoom(sharedWorld(), ORG2, e, 'r2')).toBe(true);
  });

  it('counts a room once it has a monitored device, however many, and not recorded-only or staging rooms', async () => {
    const ids = await monitoredRoomIds(world(), ORG2);
    expect([...ids].sort()).toEqual(['r1', 'r4']);
  });

  it('lets a monitored room take more devices, and stops a new room over the limit', async () => {
    const e = { maxRooms: 2 } as never;
    expect(await canMonitorRoom(world(), ORG2, e, 'r1')).toBe(true);
    expect(await canMonitorRoom(world(), ORG2, e, 'r2')).toBe(false);
    expect(await canMonitorRoom(world(), ORG2, { maxRooms: 3 } as never, 'r2')).toBe(true);
    expect(await canMonitorRoom(world(), ORG2, { maxRooms: null } as never, 'r2')).toBe(true);
    expect(await canMonitorRoom(world(), ORG2, e, null)).toBe(true);
  });
});
