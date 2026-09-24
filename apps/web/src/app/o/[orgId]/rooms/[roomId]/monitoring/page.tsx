import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { RoomMonitoring } from '@/components/pages/room-monitoring';

export const metadata: Metadata = { title: 'Monitoring' };

export default async function RoomMonitoringPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  return (
    <RequireFeature feature="monitoring">
      <RoomMonitoring roomId={roomId} />
    </RequireFeature>
  );
}
