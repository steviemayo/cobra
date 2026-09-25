import type { Metadata } from 'next';
import { StaffOrg } from '@/components/pages/staff-org';

export const metadata: Metadata = { title: 'Staff: organisation' };

export default async function StaffOrgPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return <StaffOrg orgId={orgId} />;
}
