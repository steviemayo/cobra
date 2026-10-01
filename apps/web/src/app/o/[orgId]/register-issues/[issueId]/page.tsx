import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { RegisterIssueView } from '@/components/pages/register-issue-view';

export const metadata: Metadata = { title: 'Register issue' };

export default async function Page({ params }: { params: Promise<{ issueId: string }> }) {
  const { issueId } = await params;
  return (
    <RequireFeature feature="registerIssues">
      <RegisterIssueView issueId={issueId} />
    </RequireFeature>
  );
}
