import type { Metadata } from 'next';
import { HomeView } from '@/components/pages/home';

export const metadata: Metadata = { title: 'Overview' };

export default function OverviewPage() {
  return <HomeView />;
}
