'use client';
import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOrg } from '@/components/shell/org-context';
import { useTRPC } from '@/trpc/client';

// Shared, cached estate queries: the sidebar tree, breadcrumbs, palette and pages all read these.
export function useSites() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  return useQuery({ ...trpc.site.list.queryOptions({ orgId }), staleTime: 30_000 });
}

export function useRoomsOverview() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  return useQuery({ ...trpc.room.overview.queryOptions({ orgId }), staleTime: 30_000 });
}

export function useEstate() {
  const sites = useSites();
  const rooms = useRoomsOverview();
  const roomsBySite = useMemo(() => {
    const map = new Map<string, NonNullable<typeof rooms.data>>();
    for (const r of rooms.data ?? []) map.set(r.siteId, [...(map.get(r.siteId) ?? []), r]);
    return map;
  }, [rooms.data]);
  return {
    sites: sites.data ?? [],
    rooms: rooms.data ?? [],
    roomsBySite,
    isPending: sites.isPending || rooms.isPending,
  };
}

export function useInvalidateEstate() {
  const qc = useQueryClient();
  const trpc = useTRPC();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.site.list.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.room.overview.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.room.get.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.audit.list.queryKey() }),
    ]);
}
