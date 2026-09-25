import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { db } from '@kestrel/db';
import { HomeView } from '@/components/pages/home';

export const metadata: Metadata = { title: 'Overview' };

export default async function OverviewPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  // A service provider has no estate of its own: it lands on its customers.
  const org = await db.org.findFirst({ where: { id: orgId }, select: { kind: true } });
  if (org?.kind === 'msp') redirect(`/o/${orgId}/msp`);
  return <HomeView />;
}
