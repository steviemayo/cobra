import type { Metadata } from 'next';
import { StaffGateways } from '@/components/pages/staff-gateways';

export const metadata: Metadata = { title: 'Staff: unclaimed gateways' };

export default function StaffGatewaysPage() {
  return <StaffGateways />;
}
