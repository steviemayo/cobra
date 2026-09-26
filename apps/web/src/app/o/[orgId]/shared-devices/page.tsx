import type { Metadata } from 'next';
import { SharedDevicesView } from '@/components/pages/shared-devices';

export const metadata: Metadata = { title: 'Shared devices' };

export default function SharedDevicesPage() {
  return <SharedDevicesView />;
}
