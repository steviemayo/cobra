import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { ReportsView } from '@/components/pages/reports';

export const metadata: Metadata = { title: 'Reports' };

export default function ReportsPage() {
  return (
    <RequireFeature feature="monitoring">
      <ReportsView />
    </RequireFeature>
  );
}
