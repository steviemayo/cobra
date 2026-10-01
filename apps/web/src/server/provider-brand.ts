import { z } from 'zod';
import type { PrismaClient } from '@kestrel/db';
import type { PanelBranding } from '@kestrel/model';
import { writeAudit } from './audit';
import { readOrgBranding } from './panel-settings';

// White label for service providers. A provider sets how it presents itself (a name, a logo and a
// colour). A customer's owner then chooses, per connection, to show that in the customer's portal
// and, as the fallback, on its room panels. The customer still pays Kestrel directly and still owns
// its data; only the look changes. Ending the connection ends the branding.
export type BrandDb = Pick<PrismaClient, 'providerBrand' | 'mspGrant' | 'org' | 'auditLog'>;

export class BrandError extends Error {}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const BrandInput = z.object({
  name: z.string().trim().min(1, 'Give the brand a name').max(60),
  /** https only: it goes straight into an image tag, on the portal and on every panel. */
  logoUrl: z
    .string()
    .trim()
    .max(500)
    .regex(/^https:\/\/[^\s"'<>]+$/, 'The logo must be a web address starting with https://')
    .optional(),
  accent: z.string().trim().regex(HEX, 'Use a colour like #0f8a8c').optional(),
});
export type BrandInput = z.infer<typeof BrandInput>;

export interface ProviderBrandView {
  name: string;
  logoUrl: string | null;
  accent: string | null;
}

export interface PortalBrand {
  /** The provider whose brand this is. */
  mspOrgId: string;
  name: string;
  logoUrl?: string;
  accent?: string;
}

export async function getProviderBrand(
  db: BrandDb,
  mspOrgId: string,
): Promise<ProviderBrandView | null> {
  const row = await db.providerBrand.findFirst({ where: { mspOrgId } });
  return row ? { name: row.name, logoUrl: row.logoUrl ?? null, accent: row.accent ?? null } : null;
}

/** A provider sets or changes its brand. */
export async function saveProviderBrand(
  db: BrandDb,
  args: { mspOrgId: string; input: BrandInput; actorId: string },
): Promise<ProviderBrandView> {
  const org = await db.org.findFirst({ where: { id: args.mspOrgId, kind: 'msp' } });
  if (!org) throw new BrandError('Only a service provider has a brand');
  const data = {
    name: args.input.name,
    logoUrl: args.input.logoUrl ?? null,
    accent: args.input.accent ?? null,
  };
  if (await db.providerBrand.findFirst({ where: { mspOrgId: args.mspOrgId } }))
    await db.providerBrand.update({ where: { mspOrgId: args.mspOrgId }, data });
  else await db.providerBrand.create({ data: { mspOrgId: args.mspOrgId, ...data } });
  await writeAudit({ orgId: args.mspOrgId, actorId: args.actorId, action: 'msp.brand', meta: { name: data.name } }, db);
  return data;
}

/**
 * A customer's owner shows, or stops showing, a connected provider's brand. Only one provider at a
 * time: choosing one turns the others off.
 */
export async function setUseBrand(
  db: BrandDb,
  args: { customerOrgId: string; grantId: string; on: boolean; actorId: string },
): Promise<void> {
  const grant = await db.mspGrant.findFirst({
    where: { id: args.grantId, customerOrgId: args.customerOrgId, status: 'active' },
  });
  if (!grant) throw new BrandError('That connection is not active');
  const provider = await db.org.findFirst({ where: { id: grant.mspOrgId } });
  if (args.on && !(await getProviderBrand(db, grant.mspOrgId)))
    throw new BrandError('This provider has not set up its branding yet');
  if (args.on)
    await db.mspGrant.updateMany({
      where: { customerOrgId: args.customerOrgId, id: { not: grant.id } },
      data: { useBrand: false },
    });
  await db.mspGrant.update({ where: { id: grant.id }, data: { useBrand: args.on } });
  await writeAudit(
    {
      orgId: args.customerOrgId,
      actorId: args.actorId,
      action: args.on ? 'msp.brand_on' : 'msp.brand_off',
      meta: { msp: provider?.name },
    },
    db,
  );
}

/**
 * The brand an organisation's portal wears, if any: a provider always wears its own, and a customer
 * wears the brand of the active connection its owner chose. Null means plain Kestrel.
 */
export async function portalBrandFor(db: BrandDb, orgId: string): Promise<PortalBrand | null> {
  const org = await db.org.findFirst({ where: { id: orgId } });
  if (!org) return null;
  const grant =
    org.kind === 'msp'
      ? null
      : await db.mspGrant.findFirst({
          where: { customerOrgId: orgId, status: 'active', useBrand: true },
        });
  const mspOrgId = org.kind === 'msp' ? org.id : (grant?.mspOrgId ?? null);
  if (!mspOrgId) return null;
  const brand = await getProviderBrand(db, mspOrgId);
  if (!brand) return null;
  return {
    mspOrgId,
    name: brand.name,
    ...(brand.logoUrl && { logoUrl: brand.logoUrl }),
    ...(brand.accent && { accent: brand.accent }),
  };
}

/** The organisation's own logo and colour win; the provider's fill in what it left unset. */
export function withProviderBrand(own: PanelBranding, brand: PortalBrand | null): PanelBranding {
  if (!brand) return own;
  return {
    ...own,
    ...(!own.logoUrl && brand.logoUrl && { logoUrl: brand.logoUrl }),
    ...(!own.accent && brand.accent && { accent: brand.accent }),
  };
}

/** The look a room panel starts from: the organisation's own settings, then its provider's brand. */
export async function orgPanelBranding(
  db: BrandDb,
  orgId: string,
  stored: unknown,
): Promise<PanelBranding> {
  return withProviderBrand(readOrgBranding(stored), await portalBrandFor(db, orgId));
}
