import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { RoomEditorWorkspace } from '@/components/editor/RoomEditor';

export const metadata: Metadata = { title: 'Design' };

export default async function RoomDesignPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return (
    <RequireFeature feature="control">
      <RoomEditorWorkspace roomId={roomId} />
    </RequireFeature>
  );
}
