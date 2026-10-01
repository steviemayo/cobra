import type { PrismaClient } from '@kestrel/db';
import { DEFAULT_ZONE, knownZone } from '../lib/time';

/** The time zone a site keeps its time in (Sydney when it has none that is valid). */
export async function siteTimezone(
  db: Partial<Pick<PrismaClient, 'site'>>,
  siteId: string | null | undefined,
): Promise<string> {
  if (!siteId || !db.site) return DEFAULT_ZONE;
  const tz = (await db.site.findFirst({ where: { id: siteId } }))?.timezone;
  return knownZone(tz) ? tz : DEFAULT_ZONE;
}

/**
 * The zone to use for something about an organisation with no one site (a callout that is not about
 * a room): its oldest site's.
 */
export async function orgTimezone(
  db: Partial<Pick<PrismaClient, 'site'>>,
  orgId: string,
): Promise<string> {
  if (!db.site) return DEFAULT_ZONE;
  const site = await db.site.findFirst({ where: { orgId }, orderBy: { createdAt: 'asc' } });
  return knownZone(site?.timezone) ? site.timezone : DEFAULT_ZONE;
}
