import type { Metadata } from 'next';
import { RoomCopy } from '@/components/pages/room-copy';

export const metadata: Metadata = { title: 'Copy room' };

export default async function RoomCopyPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomCopy roomId={roomId} />;
}
