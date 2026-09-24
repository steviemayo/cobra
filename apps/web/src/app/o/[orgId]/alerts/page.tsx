import type { Metadata } from 'next';
import { AlertsView } from '@/components/pages/alerts';

export const metadata: Metadata = { title: 'Alerts' };

export default function AlertsPage() {
  return <AlertsView />;
}
