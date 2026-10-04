import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { db } from '@kestrel/db';
import { AcceptTerms } from '@/components/legal/accept-terms';
import { createSupabaseServer } from '@/lib/supabase/server';
import { legalGate } from '@/server/legal';

export const metadata: Metadata = { title: 'Terms and Privacy Policy' };

// Shown when the Terms or Privacy Policy changed (or acceptance became required) and this person has
// not accepted the current version yet.
export default async function AcceptTermsPage() {
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect('/login');
  if ((await legalGate(db, data.user)) === 'ok') redirect('/');
  return <AcceptTerms />;
}
