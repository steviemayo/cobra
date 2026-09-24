import type { Metadata } from 'next';
import { GatewaysView } from '@/components/pages/gateways';

export const metadata: Metadata = { title: 'Gateways' };

export default function GatewaysPage() {
  return <GatewaysView />;
}
