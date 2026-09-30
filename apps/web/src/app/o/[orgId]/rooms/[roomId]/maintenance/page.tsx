import type { Metadata } from 'next';
import { RoomMaintenance } from '@/components/pages/room-maintenance';

export const metadata: Metadata = { title: 'Room maintenance' };

export default async function Page({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomMaintenance roomId={roomId} />;
}
