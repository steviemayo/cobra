import type { Metadata } from 'next';
import { RoomSettings } from '@/components/pages/room-settings';

export const metadata: Metadata = { title: 'Room settings' };

export default async function RoomSettingsPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  return <RoomSettings roomId={roomId} />;
}
