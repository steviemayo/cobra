import type { Metadata } from 'next';
import { PmScheduleView } from '@/components/pages/pm-schedule';

export const metadata: Metadata = { title: 'Maintenance schedule' };

export default function Page() {
  return <PmScheduleView />;
}
