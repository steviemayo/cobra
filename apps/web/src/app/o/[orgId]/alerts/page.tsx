import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { AlertsView } from '@/components/pages/alerts';

export const metadata: Metadata = { title: 'Alerts' };

export default function AlertsPage() {
  return (
    <RequireFeature feature="alerts">
      <AlertsView />
    </RequireFeature>
  );
}
