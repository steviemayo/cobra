import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { ConnectionsView } from '@/components/pages/connections';

export const metadata: Metadata = { title: 'Cloud connections' };

export default function Page() {
  return (
    <RequireFeature feature="monitoring">
      <ConnectionsView />
    </RequireFeature>
  );
}
