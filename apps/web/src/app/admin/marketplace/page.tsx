import { redirect } from 'next/navigation';

// Marketplace review moved into the staff portal.
export default function OldMarketplaceReviewPage() {
  redirect('/staff/marketplace');
}
