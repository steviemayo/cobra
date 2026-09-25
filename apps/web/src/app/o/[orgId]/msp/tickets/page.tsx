import type { Metadata } from 'next';
import { MspTickets } from '@/components/pages/msp-tickets';

export const metadata: Metadata = { title: 'Support queue' };

export default function MspTicketsPage() {
  return <MspTickets />;
}
