import type { Metadata } from 'next';
import { ConfigDriftView } from '@/components/pages/config-drift';

export const metadata: Metadata = { title: 'Snapshots and drift' };

export default function Page() {
  return <ConfigDriftView />;
}
