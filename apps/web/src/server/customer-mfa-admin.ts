import 'server-only';
import { createSupabaseAdmin } from '@/lib/supabase/admin';

// What Supabase knows about someone's authenticator apps, through the admin API (the signed-in
// session can only see its own). Used to check an owner before requiring it, to show who in an
// organisation has set it up, and for staff to clear it when a phone is lost.

/** Whether a person has a verified authenticator app. */
export async function hasVerifiedFactor(userId: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdmin().auth.admin.mfa.listFactors({ userId });
  if (error) throw new Error('Could not check two-step sign-in right now. Try again.');
  return data.factors.some((f) => f.status === 'verified');
}

/**
 * Removes every authenticator app a person has, so they can set a new one up. Staff do this when
 * someone has lost their phone. Returns how many were removed.
 */
export async function clearFactors(userId: string): Promise<number> {
  const admin = createSupabaseAdmin();
  const { data, error } = await admin.auth.admin.mfa.listFactors({ userId });
  if (error) throw new Error('Could not look up that person’s authenticator apps.');
  let removed = 0;
  for (const f of data.factors) {
    const res = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId });
    if (res.error) throw new Error('Could not remove an authenticator app. Try again.');
    removed++;
  }
  return removed;
}
