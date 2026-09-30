import type { Metadata } from 'next';
import { PmRecordsView } from '@/components/pages/pm-records';

export const metadata: Metadata = { title: 'PM records' };

export default function Page() {
  return <PmRecordsView />;
}
