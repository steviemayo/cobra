import type { Metadata } from 'next';
import { SimulatorView } from '@/components/simulator/SimulatorView';

export const metadata: Metadata = { title: 'Simulate' };

export default async function RoomSimulatePage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <SimulatorView roomId={roomId} />;
}
