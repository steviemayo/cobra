import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { DeviceHistoryView } from '@/components/pages/device-history';

export const metadata: Metadata = { title: 'Device history' };

export default async function DeviceHistoryPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  return (
    <RequireFeature feature="analytics">
      <DeviceHistoryView roomId={roomId} />
    </RequireFeature>
  );
}
