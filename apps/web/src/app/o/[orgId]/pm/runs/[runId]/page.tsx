import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { PmRunView } from '@/components/pages/pm-run';

export const metadata: Metadata = { title: 'Maintenance visit' };

export default async function Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return (
    <RequireFeature feature="maintenance">
      <PmRunView runId={runId} />
    </RequireFeature>
  );
}
