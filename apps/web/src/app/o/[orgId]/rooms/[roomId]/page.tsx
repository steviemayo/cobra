import type { Metadata } from 'next';
import { RoomOverview } from '@/components/pages/room-overview';

export const metadata: Metadata = { title: 'Room' };

export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomOverview roomId={roomId} />;
}
