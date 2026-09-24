import type { Metadata } from 'next';
import { MarketplaceReview } from '@/components/pages/marketplace';

export const metadata: Metadata = { title: 'Marketplace review' };

export default function MarketplaceReviewPage() {
  return <MarketplaceReview />;
}
