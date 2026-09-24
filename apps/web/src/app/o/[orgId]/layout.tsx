import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@kestrel/db';
import { OrgShell } from '@/components/shell/org-shell';
import { createSupabaseServer } from '@/lib/supabase/server';

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  if (!z.string().uuid().safeParse(orgId).success) notFound();

  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) redirect('/login');

  const memberships = await db.member.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
    include: { org: { select: { id: true, name: true } } },
  });
  // Not a member of this org (or it doesn't exist): fall back to wherever they do belong.
  if (!memberships.some((m) => m.orgId === orgId)) redirect('/');

  const store = await cookies();
  return (
    <OrgShell
      orgId={orgId}
      orgs={memberships.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role }))}
      user={{ id: user.id, email: user.email ?? '' }}
      defaultOpen={store.get('sidebar_state')?.value !== 'false'}
    >
      {children}
    </OrgShell>
  );
}
