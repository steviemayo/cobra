import type { Metadata } from 'next';
import { IntegrationsView } from '@/components/pages/integrations';

export const metadata: Metadata = { title: 'Integrations' };

export default function Page() {
  return <IntegrationsView />;
}
