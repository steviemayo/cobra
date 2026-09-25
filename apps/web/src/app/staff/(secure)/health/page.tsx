import type { Metadata } from 'next';
import { StaffHealth } from '@/components/pages/staff-health';

export const metadata: Metadata = { title: 'Staff: fleet health' };

export default function StaffHealthPage() {
  return <StaffHealth />;
}
