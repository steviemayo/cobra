import type { Metadata } from 'next';
import { SiteDetailView } from '@/components/pages/site-detail';

export const metadata: Metadata = { title: 'Site' };

export default async function SitePage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  return <SiteDetailView siteId={siteId} />;
}
