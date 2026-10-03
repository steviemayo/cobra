import type { Metadata } from 'next';
import { StaffInvoiceRequests } from '@/components/pages/staff-invoice-requests';

export const metadata: Metadata = { title: 'Staff: invoice requests' };

export default function StaffInvoiceRequestsPage() {
  return <StaffInvoiceRequests />;
}
