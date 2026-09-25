import type { Metadata } from 'next';
import { MspDashboard } from '@/components/pages/msp-dashboard';

export const metadata: Metadata = { title: 'Customers' };

export default function MspPage() {
  return <MspDashboard />;
}
