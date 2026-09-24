import type { Metadata } from 'next';
import { CombinationsView } from '@/components/pages/combinations';

export const metadata: Metadata = { title: 'Combined rooms' };

export default function CombinationsPage() {
  return <CombinationsView />;
}
