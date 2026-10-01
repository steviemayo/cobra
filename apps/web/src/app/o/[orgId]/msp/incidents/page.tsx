import type { Metadata } from 'next';
import { MspIncidentsView } from '@/components/pages/msp-incidents';

export const metadata: Metadata = { title: 'All incidents' };

export default function Page() {
  return <MspIncidentsView />;
}
