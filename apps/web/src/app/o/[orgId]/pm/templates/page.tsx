import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { PmTemplatesView } from '@/components/pages/pm-templates';

export const metadata: Metadata = { title: 'PM templates' };

export default function Page() {
  return (
    <RequireFeature feature="maintenance">
      <PmTemplatesView />
    </RequireFeature>
  );
}
