import type { Metadata } from 'next';
import { StaffAudit } from '@/components/pages/staff-audit';

export const metadata: Metadata = { title: 'Staff: audit trail' };

export default function StaffAuditPage() {
  return <StaffAudit />;
}
