'use client';
import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOrg } from '@/components/shell/org-context';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

export type RoomLive = RouterOutputs['monitoring']['overview']['rooms'][number];

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

/**
 * Live monitoring state per room (gateway/device/incident health), keyed by room id. Separate from
 * `room.overview`'s design-draft data — a room can be a perfectly valid design and still be down,
 * or have design warnings and be fully online. `retry: false` because an org with no monitoring
 * entitlement gets FORBIDDEN here, not a transient failure: callers should just show "unknown".
 */
export function useRoomsLive() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const overview = useQuery({
    ...trpc.monitoring.overview.queryOptions({ orgId }),
    staleTime: 15_000,
    refetchInterval: 15_000,
    retry: false,
  });
  const byId = useMemo(
    () => new Map((overview.data?.rooms ?? []).map((r) => [r.id, r])),
    [overview.data],
  );
  return { byId, isPending: overview.isPending, isAvailable: !overview.isError };
}

/** The v2 estate roll-up (areas, room health, device and gateway counts). Shared by the Overview and the sidebar tree. */
export function useEstateOverview() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  return useQuery({
    ...trpc.monitoring.estate.queryOptions({ orgId }),
    staleTime: 15_000,
    refetchInterval: 15_000,
    retry: false,
  });
}

export function useEstate() {
  const sites = useSites();
  const rooms = useRoomsOverview();
  const live = useRoomsLive();
  const roomsBySite = useMemo(() => {
    const map = new Map<string, NonNullable<typeof rooms.data>>();
    for (const r of rooms.data ?? []) map.set(r.siteId, [...(map.get(r.siteId) ?? []), r]);
    return map;
  }, [rooms.data]);
  return {
    sites: sites.data ?? [],
    rooms: rooms.data ?? [],
    roomsBySite,
    live: live.byId,
    liveAvailable: live.isAvailable,
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
