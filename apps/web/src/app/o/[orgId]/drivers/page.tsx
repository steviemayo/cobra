import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { DriversView } from '@/components/pages/drivers';

export const metadata: Metadata = { title: 'Custom drivers' };

export default function DriversPage() {
  return (
    <RequireFeature feature="driverCreate">
      <DriversView />
    </RequireFeature>
  );
}
