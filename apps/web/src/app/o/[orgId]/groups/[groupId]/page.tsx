import type { Metadata } from 'next';
import { GroupEditor } from '@/components/pages/group-editor';

export const metadata: Metadata = { title: 'Room group' };

// `new` creates a group; anything else is a group id.
export default async function GroupPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  return <GroupEditor groupId={groupId === 'new' ? null : groupId} />;
}
