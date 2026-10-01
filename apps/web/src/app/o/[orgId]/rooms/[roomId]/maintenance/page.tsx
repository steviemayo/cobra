import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { RoomMaintenance } from '@/components/pages/room-maintenance';

export const metadata: Metadata = { title: 'Room maintenance' };

export default async function Page({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return (
    <RequireFeature feature="maintenance">
      <RoomMaintenance roomId={roomId} />
    </RequireFeature>
  );
}
