import type { Metadata } from 'next';
import { StaffDriverRequests } from '@/components/pages/staff-driver-requests';

export const metadata: Metadata = { title: 'Staff: driver requests' };

export default function StaffDriverRequestsPage() {
  return <StaffDriverRequests />;
}
