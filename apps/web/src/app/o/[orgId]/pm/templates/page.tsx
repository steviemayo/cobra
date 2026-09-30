import type { Metadata } from 'next';
import { PmTemplatesView } from '@/components/pages/pm-templates';

export const metadata: Metadata = { title: 'PM templates' };

export default function Page() {
  return <PmTemplatesView />;
}
