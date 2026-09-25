import type { Metadata } from 'next';
import { StaffOrgs } from '@/components/pages/staff-orgs';

export const metadata: Metadata = { title: 'Staff: organisations' };

export default function StaffOrgsPage() {
  return <StaffOrgs />;
}
