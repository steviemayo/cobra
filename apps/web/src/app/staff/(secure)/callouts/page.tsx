import type { Metadata } from 'next';
import { StaffCallouts } from '@/components/pages/staff-callouts';

export const metadata: Metadata = { title: 'Staff: callouts' };

export default function StaffCalloutsPage() {
  return <StaffCallouts />;
}
