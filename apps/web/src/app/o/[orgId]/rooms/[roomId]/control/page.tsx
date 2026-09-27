import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { RoomControl } from '@/components/pages/room-control';

export const metadata: Metadata = { title: 'Control' };

export default async function RoomControlPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return (
    <RequireFeature feature="control">
      <RoomControl roomId={roomId} />
    </RequireFeature>
  );
}
