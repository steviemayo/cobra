import type { Metadata } from 'next';
import { OverviewView } from '@/components/pages/overview';

export const metadata: Metadata = { title: 'Overview' };

export default function OverviewPage() {
  return <OverviewView />;
}
