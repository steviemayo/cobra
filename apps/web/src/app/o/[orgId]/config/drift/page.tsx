import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { ConfigDriftView } from '@/components/pages/config-drift';

export const metadata: Metadata = { title: 'Snapshots and drift' };

export default function Page() {
  return (
    <RequireFeature feature="configuration">
      <ConfigDriftView />
    </RequireFeature>
  );
}
