import type { Metadata } from 'next';
import { RoomUsageView } from '@/components/pages/room-usage';

export const metadata: Metadata = { title: 'Room usage' };

export default async function RoomUsagePage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomUsageView roomId={roomId} />;
}
