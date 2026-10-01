import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { RegisterIssuesView } from '@/components/pages/register-issues';

export const metadata: Metadata = { title: 'Register issues' };

export default function Page() {
  return (
    <RequireFeature feature="registerIssues">
      <RegisterIssuesView />
    </RequireFeature>
  );
}
