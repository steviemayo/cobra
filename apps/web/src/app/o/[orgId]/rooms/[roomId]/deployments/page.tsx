import type { Metadata } from 'next';
import { RoomDeployments } from '@/components/pages/room-deployments';

export const metadata: Metadata = { title: 'Deployments' };

export default async function RoomDeploymentsPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomDeployments roomId={roomId} />;
}
