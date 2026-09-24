import { RoomShell } from '@/components/pages/room-shell';

export default async function RoomLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  return <RoomShell roomId={roomId}>{children}</RoomShell>;
}
