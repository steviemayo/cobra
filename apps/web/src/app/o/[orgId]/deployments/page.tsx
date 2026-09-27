import type { Metadata } from 'next';
import { DeploymentsView } from '@/components/pages/deployments';

export const metadata: Metadata = { title: 'Deployments' };

export default function DeploymentsPage() {
  return <DeploymentsView />;
}
