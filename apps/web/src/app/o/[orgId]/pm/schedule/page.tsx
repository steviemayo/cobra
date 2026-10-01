import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { PmScheduleView } from '@/components/pages/pm-schedule';

export const metadata: Metadata = { title: 'Maintenance schedule' };

export default function Page() {
  return (
    <RequireFeature feature="maintenance">
      <PmScheduleView />
    </RequireFeature>
  );
}
