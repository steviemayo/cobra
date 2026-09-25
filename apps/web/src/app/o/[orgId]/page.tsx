import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { db } from '@kestrel/db';
import { createSupabaseServer } from '@/lib/supabase/server';
import { mspAccess } from '@/server/msp';
import { HomeView } from '@/components/pages/home';

export const metadata: Metadata = { title: 'Overview' };

export default async function OverviewPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  // A service provider has no estate of its own: it lands on its customers.
  const org = await db.org.findFirst({ where: { id: orgId }, select: { kind: true } });
  if (org?.kind === 'msp') redirect(`/o/${orgId}/msp`);
  // A provider limited to some sites has no whole-organisation overview: it starts at its rooms.
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  const isMember = data.user
    ? await db.member.findFirst({ where: { orgId, userId: data.user.id } })
    : null;
  const access = data.user && !isMember ? await mspAccess(db, data.user.id, orgId) : null;
  if (access?.sites) redirect(`/o/${orgId}/rooms`);
  return <HomeView />;
}
