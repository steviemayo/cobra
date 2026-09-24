import type { PrismaClient } from '@kestrel/db';
import { validateRoomModel } from '@kestrel/engine';
import { RoomModel, type RoomModel as RoomModelType } from '@kestrel/model';

// The marketplace: organisations on Pro publish room designs; organisations on Basic and above
// get them. Every listing is reviewed by Kestrel staff before anyone else sees it. Functions take
// the database as a parameter so they can be tested without one.
export type MarketDb = Pick<
  PrismaClient,
  'marketplaceListing' | 'marketplacePurchase' | 'template' | 'org'
>;

/** Kestrel staff who review listings: KESTREL_ADMIN_EMAILS, comma separated. */
export function isPlatformAdmin(
  email: string | null | undefined,
  env = process.env.KESTREL_ADMIN_EMAILS,
): boolean {
  if (!email || !env) return false;
  return env
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

/**
 * What goes public: the design, with everything that belongs to the publisher taken out. Device
 * settings hold addresses and passwords, calendar triggers name real mailboxes, and both must never
 * leave the organisation. The buyer fills them in for their own site.
 */
export function publicModel(model: RoomModelType): RoomModelType {
  const copy = structuredClone(model);
  for (const d of copy.devices) d.settings = {};
  for (const t of copy.triggers) if (t.type === 'calendar') t.resourceId = 'set-your-room-calendar';
  return copy;
}

export type PublishResult =
  { ok: true; id: string; updated: boolean } | { ok: false; error: string };

export async function publishTemplate(
  db: MarketDb,
  input: {
    orgId: string;
    templateId: string;
    description: string;
    priceCents: number;
    name?: string;
  },
  now = new Date(),
): Promise<PublishResult> {
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0 || input.priceCents > 1_000_000)
    return { ok: false, error: 'Choose a price between $0 and $10,000' };
  if (input.priceCents > 0 && input.priceCents < 100)
    return { ok: false, error: 'A paid listing must cost at least $1' };
  const template = await db.template.findFirst({
    where: { id: input.templateId, orgId: input.orgId },
  });
  if (!template) return { ok: false, error: 'Template not found' };
  const parsed = RoomModel.safeParse(template.model);
  if (!parsed.success) return { ok: false, error: 'This template is not a valid room design' };
  const issues = validateRoomModel(parsed.data).issues.filter((i) => i.severity === 'error');
  if (issues.length > 0) return { ok: false, error: `Fix this first: ${issues[0]!.message}` };

  const model = publicModel(parsed.data);
  const existing = await db.marketplaceListing.findFirst({
    where: { publisherOrgId: input.orgId, templateId: template.id },
  });
  const data = {
    name: (input.name ?? template.name).trim().slice(0, 80) || template.name,
    description: input.description.trim().slice(0, 1000),
    roomType: template.roomType,
    model: model as object,
    priceCents: input.priceCents,
  };
  if (existing) {
    const changed = JSON.stringify(existing.model) !== JSON.stringify(model);
    await db.marketplaceListing.update({
      where: { id: existing.id },
      data: {
        ...data,
        // New content is reviewed again; a price or wording change alone is not.
        ...(changed ? { version: existing.version + 1, status: 'pending', reviewNote: null } : {}),
        // A withdrawn listing comes back only through review.
        ...(existing.status === 'withdrawn' || existing.status === 'rejected'
          ? { status: 'pending', reviewNote: null }
          : {}),
      },
    });
    return { ok: true, id: existing.id, updated: true };
  }
  const created = await db.marketplaceListing.create({
    data: {
      ...data,
      publisherOrgId: input.orgId,
      templateId: template.id,
      version: 1,
      downloads: 0,
      status: 'pending',
      createdAt: now,
    },
  });
  return { ok: true, id: created.id, updated: false };
}

export async function review(
  db: MarketDb,
  input: { listingId: string; approve: boolean; note?: string },
  now = new Date(),
): Promise<{ ok: boolean; error?: string }> {
  const listing = await db.marketplaceListing.findFirst({ where: { id: input.listingId } });
  if (!listing) return { ok: false, error: 'Listing not found' };
  if (listing.status !== 'pending')
    return { ok: false, error: 'That listing is not waiting for review' };
  await db.marketplaceListing.update({
    where: { id: listing.id },
    data: input.approve
      ? { status: 'published', publishedAt: now, reviewNote: input.note?.slice(0, 500) ?? null }
      : { status: 'rejected', reviewNote: (input.note ?? 'Not approved').slice(0, 500) },
  });
  return { ok: true };
}

export type GrantResult =
  { ok: true; templateId: string; already: boolean } | { ok: false; error: string };

/**
 * Puts a listing's design in a buyer's own templates. Free listings are granted straight away;
 * paid ones only once the payment has cleared (pass `paidCents` and the checkout session).
 * Granting twice does nothing new, so a repeated webhook or a double click is harmless.
 */
export async function grantListing(
  db: MarketDb,
  input: {
    listingId: string;
    buyerOrgId: string;
    paidCents?: number;
    stripeSessionId?: string;
    createdBy?: string | null;
  },
  now = new Date(),
): Promise<GrantResult> {
  const listing = await db.marketplaceListing.findFirst({
    where: { id: input.listingId, status: 'published' },
  });
  if (!listing) return { ok: false, error: 'This listing is not available' };
  if (listing.priceCents > 0 && input.paidCents === undefined)
    return { ok: false, error: 'This template has to be paid for first' };
  if (input.paidCents !== undefined && input.paidCents < listing.priceCents)
    return { ok: false, error: 'The payment does not cover this template' };

  const prior = await db.marketplacePurchase.findFirst({
    where: { listingId: listing.id, buyerOrgId: input.buyerOrgId },
  });
  if (prior) {
    const t = await db.template.findFirst({
      where: { orgId: input.buyerOrgId, name: listing.name, description: listing.description },
    });
    return { ok: true, templateId: t?.id ?? '', already: true };
  }
  await db.marketplacePurchase.create({
    data: {
      listingId: listing.id,
      buyerOrgId: input.buyerOrgId,
      priceCents: input.paidCents ?? 0,
      stripeSessionId: input.stripeSessionId ?? null,
      createdAt: now,
    },
  });
  const template = await db.template.create({
    data: {
      orgId: input.buyerOrgId,
      name: listing.name,
      description: listing.description,
      roomType: listing.roomType,
      model: listing.model as object,
      createdBy: input.createdBy ?? null,
    },
  });
  await db.marketplaceListing.update({
    where: { id: listing.id },
    data: { downloads: listing.downloads + 1 },
  });
  return { ok: true, templateId: template.id, already: false };
}

/** A paid checkout that Stripe says is complete. */
export interface MarketplaceSession {
  id: string;
  payment_status?: string;
  amount_total?: number | null;
  metadata?: Record<string, string> | null;
}

/** Fulfils an order from a checkout.session.completed event. Safe to run twice for one session. */
export async function fulfilOrder(
  db: MarketDb,
  session: MarketplaceSession,
): Promise<'granted' | 'duplicate' | 'ignored'> {
  const m = session.metadata;
  if (m?.kind !== 'marketplace' || !m.listingId || !m.orgId) return 'ignored';
  if (session.payment_status !== 'paid') return 'ignored';
  const seen = await db.marketplacePurchase.findFirst({ where: { stripeSessionId: session.id } });
  if (seen) return 'duplicate';
  const res = await grantListing(db, {
    listingId: m.listingId,
    buyerOrgId: m.orgId,
    paidCents: session.amount_total ?? 0,
    stripeSessionId: session.id,
  });
  return res.ok ? (res.already ? 'duplicate' : 'granted') : 'ignored';
}
