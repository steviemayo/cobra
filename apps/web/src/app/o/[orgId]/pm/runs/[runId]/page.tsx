import type { Metadata } from 'next';
import { PmRunView } from '@/components/pages/pm-run';

export const metadata: Metadata = { title: 'Maintenance visit' };

export default async function Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <PmRunView runId={runId} />;
}
