import type { Metadata } from 'next';
import { RequireFeature } from '@/components/common/plan-gate';
import { ConfigProfilesView } from '@/components/pages/config-profiles';

export const metadata: Metadata = { title: 'Profiles' };

export default function Page() {
  return (
    <RequireFeature feature="configuration">
      <ConfigProfilesView />
    </RequireFeature>
  );
}
