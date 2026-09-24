import type { Metadata } from 'next';
import { RoomDevices } from '@/components/pages/room-devices';

export const metadata: Metadata = { title: 'Devices' };

export default async function RoomDevicesPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomDevices roomId={roomId} />;
}
