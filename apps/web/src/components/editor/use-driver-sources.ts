'use client';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CustomSettingSources } from '@kestrel/model';
import { useOrg } from '@/components/shell/org-context';
import { useTRPC } from '@/trpc/client';

/** The organisation's custom drivers, for reading the settings a device's driver has. */
export function useDriverSources() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const q = useQuery({ ...trpc.driver.options.queryOptions({ orgId }), staleTime: 60_000 });
  const drivers = q.data ?? [];
  const sources = useMemo<CustomSettingSources>(
    () => Object.fromEntries((q.data ?? []).map((d) => [d.id, { spec: { settings: d.settings } }])),
    [q.data],
  );
  return { sources, drivers, ready: !q.isPending };
}
