import type { Metadata } from 'next';
import { StaffTickets } from '@/components/pages/staff-tickets';

export const metadata: Metadata = { title: 'Staff: tickets' };

export default function StaffTicketsPage() {
  return <StaffTickets />;
}
