import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { PmRecordsView } from '@/components/pages/pm-records';

export const metadata: Metadata = { title: 'PM records' };

export default function Page() {
  return (
    <RequireFeature feature="maintenance">
      <PmRecordsView />
    </RequireFeature>
  );
}
