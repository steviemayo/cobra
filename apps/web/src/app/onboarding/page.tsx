import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { db } from '@kestrel/db';
import { OnboardingWizard } from '@/components/onboarding/wizard';
import { createSupabaseServer } from '@/lib/supabase/server';

export const metadata: Metadata = { title: 'Set up your organisation' };

export default async function OnboardingPage() {
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect('/login');
  const orgs = await db.member.count({ where: { userId: data.user.id } });
  return <OnboardingWizard email={data.user.email ?? ''} hasOrgs={orgs > 0} />;
}
