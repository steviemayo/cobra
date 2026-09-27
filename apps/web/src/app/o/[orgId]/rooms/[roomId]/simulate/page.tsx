import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { SimulatorView } from '@/components/simulator/SimulatorView';

export const metadata: Metadata = { title: 'Simulate' };

export default async function RoomSimulatePage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return (
    <RequireFeature feature="control">
      <SimulatorView roomId={roomId} />
    </RequireFeature>
  );
}
