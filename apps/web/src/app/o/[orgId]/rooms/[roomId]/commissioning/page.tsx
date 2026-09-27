import type { Metadata } from 'next';
import { RoomCommissioning } from '@/components/pages/room-commissioning';

export const metadata: Metadata = { title: 'Commissioning' };

export default async function RoomCommissioningPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomCommissioning roomId={roomId} />;
}
