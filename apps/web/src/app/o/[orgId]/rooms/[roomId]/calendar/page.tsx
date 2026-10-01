import type { Metadata } from 'next';
import { RoomCalendar } from '@/components/pages/room-calendar';

export const metadata: Metadata = { title: 'Room calendar' };

export default async function Page({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomCalendar roomId={roomId} />;
}
