import type { Metadata } from 'next';
import { ConfigChangesView } from '@/components/pages/config-changes';

export const metadata: Metadata = { title: 'Changes' };

export default function Page() {
  return <ConfigChangesView />;
}
