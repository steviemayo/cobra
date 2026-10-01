import type { Metadata } from 'next';
import { RoomTimeline } from '@/components/pages/room-timeline';

export const metadata: Metadata = { title: 'Room timeline' };

export default async function Page({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomTimeline roomId={roomId} />;
}
