import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@kestrel/db';
import { OrgShell } from '@/components/shell/org-shell';
import { createSupabaseServer } from '@/lib/supabase/server';
import { findStaff, mfaRequired } from '@/server/staff';
import { activeSession } from '@/server/support-sessions';

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
  const orgs = memberships.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role }));
  let viewAs: { sessionId: string; mode: 'read' | 'act'; endsAt: string } | null = null;

  if (!memberships.some((m) => m.orgId === orgId)) {
    // Not a member. Kestrel staff with an open support session (and a second factor) may look
    // in, at support level. Anyone else: back to wherever they do belong.
    const staff = await findStaff(db, user.id);
    const session = staff ? await activeSession(db, user.id, orgId) : null;
    const org = session
      ? await db.org.findFirst({ where: { id: orgId }, select: { id: true, name: true } })
      : null;
    if (!staff || !session || !org) redirect('/');
    if (mfaRequired()) {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.currentLevel !== 'aal2') redirect('/staff/mfa');
    }
    orgs.push({ id: org.id, name: org.name, role: 'support' });
    viewAs = { sessionId: session.id, mode: session.mode, endsAt: session.endsAt.toISOString() };
  }

  const store = await cookies();
  return (
    <OrgShell
      orgId={orgId}
      orgs={orgs}
      user={{ id: user.id, email: user.email ?? '' }}
      defaultOpen={store.get('sidebar_state')?.value !== 'false'}
      viewAs={viewAs}
    >
      {children}
    </OrgShell>
  );
}
