import type { Metadata } from 'next';
import { GroupSimulator } from '@/components/simulator/GroupSimulator';

export const metadata: Metadata = { title: 'Simulate group' };

export default async function GroupSimulatePage({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  const { groupId } = await params;
  return <GroupSimulator groupId={groupId} />;
}
