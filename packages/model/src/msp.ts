import { z } from 'zod';
import type { OrgRole } from './enums';

// Managed service providers (MSPs): an organisation of kind "msp" that looks after customer
// organisations through a two-sided grant. What a provider's people can do inside a customer is
// the LOWER of their role in the provider and what the grant allows.
export const OrgKind = z.enum(['customer', 'msp']);
export type OrgKind = z.infer<typeof OrgKind>;

export const GrantRole = z.enum(['manage', 'support', 'view']);
export type GrantRole = z.infer<typeof GrantRole>;

export const GRANT_STATUSES = ['pending', 'active', 'declined', 'ended'] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];

export const GRANT_ROLE_LABEL: Record<GrantRole, string> = {
  manage: 'Manage: design, deploy and support (not billing, team or settings)',
  support: 'Support: monitor, run tickets and use remote tools',
  view: 'View only',
};

const RANK: Record<OrgRole, number> = { customer_viewer: 0, support: 1, dev: 2, owner: 3 };
/** The most a grant lets a provider do. Never owner: the customer keeps billing, team and settings. */
const CAP: Record<GrantRole, OrgRole> = {
  manage: 'dev',
  support: 'support',
  view: 'customer_viewer',
};

/** What someone with `memberRole` in the provider may do in a customer under a `grant`. */
export function effectiveMspRole(memberRole: OrgRole, grant: GrantRole): OrgRole {
  const cap = CAP[grant];
  return RANK[memberRole] <= RANK[cap] ? memberRole : cap;
}

/** The best role across several grants (a provider could hold more than one), or null if none. */
export function bestMspRole(
  candidates: { memberRole: OrgRole; grant: GrantRole }[],
): OrgRole | null {
  let best: OrgRole | null = null;
  for (const c of candidates) {
    const role = effectiveMspRole(c.memberRole, c.grant);
    if (best === null || RANK[role] > RANK[best]) best = role;
  }
  return best;
}

/**
 * The lowest role across several grants. Used when a provider holds only site-limited grants: their
 * sites are combined, so the role is the most cautious one rather than the most generous.
 */
export function lowestMspRole(
  candidates: { memberRole: OrgRole; grant: GrantRole }[],
): OrgRole | null {
  let lowest: OrgRole | null = null;
  for (const c of candidates) {
    const role = effectiveMspRole(c.memberRole, c.grant);
    if (lowest === null || RANK[role] < RANK[lowest]) lowest = role;
  }
  return lowest;
}

/** Whether a grant lets the provider take tickets for the customer (view-only providers do not). */
export const grantTakesTickets = (grant: GrantRole): boolean => grant !== 'view';

/** Where a new ticket for `customer` goes: to the provider, if there is an active one that takes tickets. */
export const MSP_ROUTE_PREFIX = 'msp:';
export const mspRoute = (mspOrgId: string) => `${MSP_ROUTE_PREFIX}${mspOrgId}`;
export const mspFromRoute = (routedTo: string): string | null =>
  routedTo.startsWith(MSP_ROUTE_PREFIX) ? routedTo.slice(MSP_ROUTE_PREFIX.length) : null;
