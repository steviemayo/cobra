import type { Metadata } from 'next';
import { StaffTicket } from '@/components/pages/staff-ticket';

export const metadata: Metadata = { title: 'Staff: ticket' };

export default async function StaffTicketPage({
  params,
}: {
  params: Promise<{ ticketId: string }>;
}) {
  const { ticketId } = await params;
  return <StaffTicket ticketId={ticketId} />;
}
