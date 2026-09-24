import type { Metadata } from 'next';
import { BillingView } from '@/components/pages/billing';

export const metadata: Metadata = { title: 'Plan and billing' };

export default function BillingPage() {
  return <BillingView />;
}
