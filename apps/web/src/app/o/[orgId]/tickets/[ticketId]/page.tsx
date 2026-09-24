import type { Metadata } from 'next';
import { TicketDetail } from '@/components/pages/ticket-detail';

export const metadata: Metadata = { title: 'Support request' };

export default async function TicketPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  return <TicketDetail ticketId={ticketId} />;
}
