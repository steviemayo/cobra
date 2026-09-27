import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { FirmwareView } from '@/components/pages/firmware';

export const metadata: Metadata = { title: 'Firmware' };

export default function FirmwarePage() {
  return (
    <RequireFeature feature="monitoring">
      <FirmwareView />
    </RequireFeature>
  );
}
