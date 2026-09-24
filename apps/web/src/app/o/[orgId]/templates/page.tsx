import type { Metadata } from 'next';
import { TemplatesView } from '@/components/pages/templates';

export const metadata: Metadata = { title: 'Templates' };

export default function TemplatesPage() {
  return <TemplatesView />;
}
