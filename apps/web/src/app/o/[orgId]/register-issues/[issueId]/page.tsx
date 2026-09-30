import type { Metadata } from 'next';
import { RegisterIssueView } from '@/components/pages/register-issue-view';

export const metadata: Metadata = { title: 'Register issue' };

export default async function Page({ params }: { params: Promise<{ issueId: string }> }) {
  const { issueId } = await params;
  return <RegisterIssueView issueId={issueId} />;
}
