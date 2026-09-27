import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { DeploymentsView } from '@/components/pages/deployments';

export const metadata: Metadata = { title: 'Deployments' };

export default function DeploymentsPage() {
  return (
    <RequireFeature feature="control">
      <DeploymentsView />
    </RequireFeature>
  );
}
