import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CalloutsView } from '@/components/pages/callouts';

export const metadata: Metadata = { title: 'Callouts' };

export default function CalloutsPage() {
  return (
    <Suspense>
      <CalloutsView />
    </Suspense>
  );
}
