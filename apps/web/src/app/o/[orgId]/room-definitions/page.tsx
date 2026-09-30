import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { RoomDefinitionsView } from '@/components/pages/room-definitions';

export const metadata: Metadata = { title: 'Room definitions' };

export default function RoomDefinitionsPage() {
  return (
    <RequireFeature feature="usageDefinitions">
      <RoomDefinitionsView />
    </RequireFeature>
  );
}
