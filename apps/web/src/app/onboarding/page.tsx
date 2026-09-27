import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { db } from '@kestrel/db';
import { OnboardingWizard } from '@/components/onboarding/wizard';
import { createSupabaseServer } from '@/lib/supabase/server';

export const metadata: Metadata = { title: 'Set up your organisation' };

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ as?: string }>;
}) {
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect('/login');
  const { as } = await searchParams;
  const orgs = await db.member.count({ where: { userId: data.user.id } });
  return (
    <OnboardingWizard
      email={data.user.email ?? ''}
      hasOrgs={orgs > 0}
      initialKind={as === 'provider' ? 'msp' : null}
    />
  );
}
