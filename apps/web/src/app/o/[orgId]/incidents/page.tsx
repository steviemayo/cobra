import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { IncidentsView } from '@/components/pages/incidents';

export const metadata: Metadata = { title: 'Incidents' };

export default function IncidentsPage() {
  return (
    <RequireFeature feature="monitoring">
      <IncidentsView />
    </RequireFeature>
  );
}
