import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { ConfigChangesView } from '@/components/pages/config-changes';

export const metadata: Metadata = { title: 'Changes' };

export default function Page() {
  return (
    <RequireFeature feature="configuration">
      <ConfigChangesView />
    </RequireFeature>
  );
}
