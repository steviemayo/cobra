import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { MonitoringView } from '@/components/pages/monitoring';

export const metadata: Metadata = { title: 'Monitoring' };

export default function MonitoringPage() {
  return (
    <RequireFeature feature="monitoring">
      <MonitoringView />
    </RequireFeature>
  );
}
