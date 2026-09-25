import { z } from 'zod';

// Kestrel staff roles. These are about the whole platform, not one organisation (see OrgRole).
export const StaffRole = z.enum(['admin', 'support', 'billing', 'readonly']);
export type StaffRole = z.infer<typeof StaffRole>;

/**
 * Whether someone with `roles` may do what `needed` covers. Admin covers everything, and every
 * staff role can look (readonly). Support and billing cover only their own area.
 */
export function hasStaffRole(roles: readonly string[], needed: StaffRole): boolean {
  if (roles.includes('admin')) return true;
  if (needed === 'readonly') return roles.some((r) => StaffRole.safeParse(r).success);
  return roles.includes(needed);
}
