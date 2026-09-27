import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { GroupsView } from '@/components/pages/groups';

export const metadata: Metadata = { title: 'Room groups' };

export default function GroupsPage() {
  return (
    <RequireFeature feature="control">
      <GroupsView />
    </RequireFeature>
  );
}
