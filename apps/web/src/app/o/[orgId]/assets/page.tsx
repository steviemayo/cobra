import type { Metadata } from 'next';
import { AssetsView } from '@/components/pages/assets';

export const metadata: Metadata = { title: 'Asset register' };

export default function AssetsPage() {
  return <AssetsView />;
}
