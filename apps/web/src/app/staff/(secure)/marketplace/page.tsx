import type { Metadata } from 'next';
import { MarketplaceReview } from '@/components/pages/marketplace';

export const metadata: Metadata = { title: 'Staff: marketplace review' };

export default function StaffMarketplacePage() {
  return <MarketplaceReview />;
}
