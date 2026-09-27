import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { TemplatesView } from '@/components/pages/templates';

export const metadata: Metadata = { title: 'Templates' };

export default function TemplatesPage() {
  return (
    <RequireFeature feature="control">
      <TemplatesView />
    </RequireFeature>
  );
}
