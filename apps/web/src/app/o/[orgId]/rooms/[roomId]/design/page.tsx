import type { Metadata } from 'next';
import { RoomEditorWorkspace } from '@/components/editor/RoomEditor';

export const metadata: Metadata = { title: 'Design' };

export default async function RoomDesignPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomEditorWorkspace roomId={roomId} />;
}
