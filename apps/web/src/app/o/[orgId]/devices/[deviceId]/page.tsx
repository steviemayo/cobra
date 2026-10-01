import type { Metadata } from 'next';
import { DeviceDetailView } from '@/components/pages/device-detail';

export const metadata: Metadata = { title: 'Device' };

export default async function DevicePage({ params }: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await params;
  return <DeviceDetailView deviceId={deviceId} />;
}
