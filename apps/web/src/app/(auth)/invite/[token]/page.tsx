import type { Metadata } from 'next';
import { InviteAccept } from '@/components/auth/invite-accept';
import { createSupabaseServer } from '@/lib/supabase/server';

export const metadata: Metadata = { title: 'Accept invitation' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  return <InviteAccept token={token} userEmail={data.user?.email?.toLowerCase() ?? null} />;
}
