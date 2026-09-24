import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '@kestrel/db';
import { LAST_ORG_COOKIE } from '@/lib/last-org';
import { createSupabaseServer } from '@/lib/supabase/server';

// Landing: send people to their last org, their first org, or onboarding.
export default async function Home() {
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect('/login');

  const memberships = await db.member.findMany({
    where: { userId: data.user.id },
    orderBy: { createdAt: 'asc' },
    select: { orgId: true },
  });
  if (memberships.length === 0) redirect('/onboarding');

  const last = (await cookies()).get(LAST_ORG_COOKIE)?.value;
  const target = memberships.find((m) => m.orgId === last) ?? memberships[0]!;
  redirect(`/o/${target.orgId}`);
}
