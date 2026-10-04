import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { MfaChallenge } from '@/components/auth/mfa-challenge';
import { safeNext } from '@/lib/auth-redirect';
import { createSupabaseServer } from '@/lib/supabase/server';

export const metadata: Metadata = { title: 'Two-step sign-in' };

// Where someone gives their authenticator code, or sets the app up. Reached from the portal when it
// needs one (see mfaGate), and from Settings > Security.
export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; enrol?: string }>;
}) {
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect('/login');
  const q = await searchParams;
  return <MfaChallenge next={safeNext(q.next)} forced={q.enrol === '1'} />;
}
