import type { Metadata } from 'next';
import { MonitoringView } from '@/components/pages/monitoring';

export const metadata: Metadata = { title: 'Monitoring' };

export default function MonitoringPage() {
  return <MonitoringView />;
}
