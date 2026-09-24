import type { Metadata } from 'next';
import { TeamView } from '@/components/pages/team';

export const metadata: Metadata = { title: 'Team' };

export default function TeamPage() {
  return <TeamView />;
}
