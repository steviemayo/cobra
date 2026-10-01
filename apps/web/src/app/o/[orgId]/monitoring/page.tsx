import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { MonitoringBoardView } from '@/components/pages/monitoring-board';

export const metadata: Metadata = { title: 'Monitoring' };

export default function MonitoringPage() {
  return (
    <RequireFeature feature="monitoring">
      <MonitoringBoardView />
    </RequireFeature>
  );
}
