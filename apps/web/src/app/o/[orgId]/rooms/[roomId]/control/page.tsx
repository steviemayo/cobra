import type { Metadata } from 'next';
import { RoomControl } from '@/components/pages/room-control';

export const metadata: Metadata = { title: 'Control' };

export default async function RoomControlPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomControl roomId={roomId} />;
}
