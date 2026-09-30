import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { EstateUsageView } from '@/components/pages/estate-usage';

export const metadata: Metadata = { title: 'Usage' };

export default function UsagePage() {
  return (
    <RequireFeature feature="analytics">
      <EstateUsageView />
    </RequireFeature>
  );
}
