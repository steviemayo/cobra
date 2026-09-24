import type { Metadata } from 'next';
import { SitesView } from '@/components/pages/sites';

export const metadata: Metadata = { title: 'Sites' };

export default function SitesPage() {
  return <SitesView />;
}
