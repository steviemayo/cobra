import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { UsageView } from '@/components/pages/usage';

export const metadata: Metadata = { title: 'Usage' };

export default function UsagePage() {
  return (
    <RequireFeature feature="monitoring">
      <UsageView />
    </RequireFeature>
  );
}
