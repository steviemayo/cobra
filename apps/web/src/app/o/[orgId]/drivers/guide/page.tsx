import type { Metadata } from 'next';
import { DriverGuideView } from '@/components/pages/driver-guide';

export const metadata: Metadata = { title: 'Custom driver guide' };

export default function DriverGuidePage() {
  return <DriverGuideView />;
}
