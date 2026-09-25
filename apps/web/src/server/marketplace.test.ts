import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type RoomModel } from '@kestrel/model';
import {
  fulfilOrder,
  grantListing,
  publicModel,
  publishTemplate,
  review,
  type MarketDb,
} from './marketplace';
import { table } from './test-db';

const PUB = '11111111-1111-4111-8111-111111111111';
const BUYER = '11111111-1111-4111-8111-111111111112';
const TPL = '55555555-5555-4555-8555-555555555551';
const good = (): RoomModel => structuredClone(STARTER_TEMPLATES[0]!.model);

function world(model: unknown = good()) {
  const template = table([
    { id: TPL, orgId: PUB, name: 'Meeting room', description: 'x', roomType: 'meeting', model },
  ]);
  const marketplaceListing = table([]);
  const marketplacePurchase = table([]);
  const org = table([]);
  return {
    db: { template, marketplaceListing, marketplacePurchase, org } as unknown as MarketDb,
    template,
    marketplaceListing,
    marketplacePurchase,
  };
}
const publish = (w: ReturnType<typeof world>, over = {}) =>
  publishTemplate(w.db, {
    orgId: PUB,
    templateId: TPL,
    description: 'A tidy room',
    priceCents: 0,
    ...over,
  });

describe('what a listing shows', () => {
  it('removes device settings and calendar addresses, and leaves the design intact', () => {
    const m = good();
    m.devices[0]!.settings = { host: '10.0.0.5', password: 'hunter2' };
    m.triggers.push({
      id: 'cal',
      name: 'Meeting starts',
      enabled: true,
      type: 'calendar',
      provider: 'graph',
      resourceId: 'boardroom@acme.com',
      run: { type: 'activity', activityId: 'present' },
    });
    const out = publicModel(m);
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('10.0.0.5');
    expect(JSON.stringify(out)).not.toContain('acme.com');
    expect(out.devices.map((d) => d.id)).toEqual(m.devices.map((d) => d.id));
    expect(out.activities).toEqual(m.activities);
    // The original is untouched.
    expect(m.devices[0]!.settings).toEqual({ host: '10.0.0.5', password: 'hunter2' });
  });
});

describe('publishing', () => {
  it('lists a valid template for review, without its private settings', async () => {
    const m = good();
    m.devices[0]!.settings = { password: 'hunter2' };
    const w = world(m);
    const res = await publish(w, { priceCents: 4900 });
    expect(res).toMatchObject({ ok: true, updated: false });
    expect(w.marketplaceListing.rows[0]).toMatchObject({
      publisherOrgId: PUB,
      status: 'pending',
      priceCents: 4900,
      version: 1,
    });
    expect(JSON.stringify(w.marketplaceListing.rows[0]!.model)).not.toContain('hunter2');
  });

  it('refuses a broken design, a missing template, and silly prices', async () => {
    const broken = good();
    broken.connections = [];
    const w = world(broken);
    expect((await publish(w)) as { ok: false }).toMatchObject({ ok: false });
    expect(
      (
        await publishTemplate(world().db, {
          orgId: BUYER,
          templateId: TPL,
          description: '',
          priceCents: 0,
        })
      ).ok,
    ).toBe(false);
    const w2 = world();
    expect((await publish(w2, { priceCents: -1 })).ok).toBe(false);
    expect((await publish(w2, { priceCents: 50 })).ok).toBe(false);
    expect((await publish(w2, { priceCents: 5_000_000 })).ok).toBe(false);
    expect(w2.marketplaceListing.rows).toHaveLength(0);
  });

  it('sends changed content back for review, but not a price or wording change', async () => {
    const w = world();
    await publish(w);
    await review(w.db, { listingId: w.marketplaceListing.rows[0]!.id as string, approve: true });
    await publish(w, { priceCents: 2000, description: 'New words' });
    expect(w.marketplaceListing.rows[0]).toMatchObject({
      status: 'published',
      version: 1,
      priceCents: 2000,
    });
    const changed = good();
    changed.settings.defaultVolume = 33;
    w.template.rows[0]!.model = changed;
    await publish(w);
    expect(w.marketplaceListing.rows[0]).toMatchObject({ status: 'pending', version: 2 });
  });
});

describe('review', () => {
  it('publishes or rejects a pending listing, once', async () => {
    const w = world();
    await publish(w);
    const id = w.marketplaceListing.rows[0]!.id as string;
    expect(await review(w.db, { listingId: id, approve: false, note: 'Needs a Room Off' })).toEqual(
      { ok: true },
    );
    expect(w.marketplaceListing.rows[0]).toMatchObject({
      status: 'rejected',
      reviewNote: 'Needs a Room Off',
    });
    expect((await review(w.db, { listingId: id, approve: true })).ok).toBe(false);
    expect((await review(w.db, { listingId: 'nope', approve: true })).ok).toBe(false);
    await publish(w);
    expect(w.marketplaceListing.rows[0]!.status).toBe('pending');
    await review(w.db, { listingId: id, approve: true }, new Date('2026-09-24T00:00:00Z'));
    expect(w.marketplaceListing.rows[0]).toMatchObject({ status: 'published' });
    expect(w.marketplaceListing.rows[0]!.publishedAt).toEqual(new Date('2026-09-24T00:00:00Z'));
  });
});

async function published(priceCents: number) {
  const w = world();
  await publish(w, { priceCents });
  await review(w.db, { listingId: w.marketplaceListing.rows[0]!.id as string, approve: true });
  return { w, id: w.marketplaceListing.rows[0]!.id as string };
}

describe('getting a template', () => {
  it('copies a free listing into the buyer’s templates, once', async () => {
    const { w, id } = await published(0);
    const first = await grantListing(w.db, { listingId: id, buyerOrgId: BUYER });
    expect(first).toMatchObject({ ok: true, already: false });
    const mine = w.template.rows.filter((t) => t.orgId === BUYER);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: 'Meeting room', roomType: 'meeting' });
    expect(w.marketplaceListing.rows[0]!.downloads).toBe(1);
    const again = await grantListing(w.db, { listingId: id, buyerOrgId: BUYER });
    expect(again).toMatchObject({ ok: true, already: true });
    expect(w.template.rows.filter((t) => t.orgId === BUYER)).toHaveLength(1);
    expect(w.marketplaceListing.rows[0]!.downloads).toBe(1);
  });

  it('will not give away a paid listing, or one that is not published', async () => {
    const { w, id } = await published(4900);
    expect((await grantListing(w.db, { listingId: id, buyerOrgId: BUYER })).ok).toBe(false);
    expect(
      (await grantListing(w.db, { listingId: id, buyerOrgId: BUYER, paidCents: 100 })).ok,
    ).toBe(false);
    expect(w.template.rows.filter((t) => t.orgId === BUYER)).toHaveLength(0);
    w.marketplaceListing.rows[0]!.status = 'withdrawn';
    expect(
      (await grantListing(w.db, { listingId: id, buyerOrgId: BUYER, paidCents: 4900 })).ok,
    ).toBe(false);
  });
});

describe('paid orders', () => {
  const session = (over: Record<string, unknown> = {}) => ({
    id: 'cs_1',
    payment_status: 'paid',
    amount_total: 4900,
    ...over,
  });
  const meta = (id: string, orgId = BUYER) => ({
    metadata: { kind: 'marketplace', listingId: id, orgId },
  });

  it('grants the template once the payment has cleared, and only once per checkout', async () => {
    const { w, id } = await published(4900);
    expect(await fulfilOrder(w.db, session(meta(id)))).toBe('granted');
    expect(w.marketplacePurchase.rows[0]).toMatchObject({
      buyerOrgId: BUYER,
      priceCents: 4900,
      stripeSessionId: 'cs_1',
    });
    expect(await fulfilOrder(w.db, session(meta(id)))).toBe('duplicate');
    expect(w.template.rows.filter((t) => t.orgId === BUYER)).toHaveLength(1);
  });

  it('ignores unpaid sessions, other kinds of checkout, and payments that fall short', async () => {
    const { w, id } = await published(4900);
    expect(await fulfilOrder(w.db, session({ ...meta(id), payment_status: 'unpaid' }))).toBe(
      'ignored',
    );
    expect(await fulfilOrder(w.db, session({ metadata: { kind: 'subscription' } }))).toBe(
      'ignored',
    );
    expect(await fulfilOrder(w.db, session({ ...meta(id), amount_total: 100 }))).toBe('ignored');
    expect(w.marketplacePurchase.rows).toHaveLength(0);
  });
});
