import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { MarketplaceView } from '@/components/pages/marketplace';

export const metadata: Metadata = { title: 'Marketplace' };

export default function MarketplacePage() {
  return (
    <RequireFeature feature="marketplaceBuy">
      <MarketplaceView />
    </RequireFeature>
  );
}
