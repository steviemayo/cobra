import type { Metadata } from 'next';
import { IncidentsView } from '@/components/pages/incidents';

export const metadata: Metadata = { title: 'Incidents' };

export default function IncidentsPage() {
  return <IncidentsView />;
}
