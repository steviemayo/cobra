import type { Metadata } from 'next';
import { StaffMfa } from '@/components/pages/staff-mfa';

export const metadata: Metadata = { title: 'Staff: second factor' };

export default function StaffMfaPage() {
  return <StaffMfa />;
}
