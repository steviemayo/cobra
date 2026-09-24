import type { Metadata } from 'next';
import { TicketsView } from '@/components/pages/tickets';

export const metadata: Metadata = { title: 'Support' };

export default function TicketsPage() {
  return <TicketsView />;
}
