import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { IntegrationsView } from '@/components/pages/integrations';

export const metadata: Metadata = { title: 'Integrations' };

export default function Page() {
  return (
    <RequireFeature feature="serviceDesk">
      <IntegrationsView />
    </RequireFeature>
  );
}
