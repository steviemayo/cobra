import { RoomEditorLoader } from '@/components/editor/RoomEditor';

export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomEditorLoader roomId={roomId} />;
}
