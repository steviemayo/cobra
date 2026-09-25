import type { Metadata } from 'next';
import { GroupsView } from '@/components/pages/groups';

export const metadata: Metadata = { title: 'Room groups' };

export default function GroupsPage() {
  return <GroupsView />;
}
