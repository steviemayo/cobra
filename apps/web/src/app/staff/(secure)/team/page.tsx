import type { Metadata } from 'next';
import { StaffTeam } from '@/components/pages/staff-team';

export const metadata: Metadata = { title: 'Staff: team' };

export default function StaffTeamPage() {
  return <StaffTeam />;
}
