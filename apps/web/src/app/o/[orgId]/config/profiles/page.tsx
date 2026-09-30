import type { Metadata } from 'next';
import { ConfigProfilesView } from '@/components/pages/config-profiles';

export const metadata: Metadata = { title: 'Profiles' };

export default function Page() {
  return <ConfigProfilesView />;
}
