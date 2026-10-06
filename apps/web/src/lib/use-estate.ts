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

/** The time zone a site keeps time in, or null until sites have loaded (then times show in the viewer's zone). */
export function useSiteZone(siteId: string | null | undefined): string | null {
  const sites = useSites();
  return sites.data?.find((s) => s.id === siteId)?.timezone ?? null;
}

/**
 * Mute and maintenance state for rooms, sites and the organisation, from the estate query. A room is
 * muted when its own mute, its site's or the organisation's is on. Empty until that query answers.
 */
export function useAlertState() {
  const estate = useEstateOverview();
  const data = estate.data;
  return useMemo(() => {
    const none = { mutedBy: null, mutedUntil: null, inMaintenance: false } as const;
    const rooms = new Map((data?.rooms ?? []).map((r) => [r.id, r]));
    const sites = new Map((data?.sites ?? []).map((s) => [s.id, s]));
    const org = data?.orgMuted;
    return {
      forRoom: (id: string) => {
        const r = rooms.get(id);
        return r
          ? { mutedBy: r.mutedBy, mutedUntil: r.mutedUntil, inMaintenance: r.inMaintenance }
          : none;
      },
      forSite: (id: string) => {
        const s = sites.get(id);
        if (!s) return none;
        const by = s.muted ? ('site' as const) : org?.muted ? ('org' as const) : null;
        return {
          mutedBy: by,
          mutedUntil: by === 'site' ? s.mutedUntil : by === 'org' ? (org?.until ?? null) : null,
          inMaintenance: s.inMaintenance,
        };
      },
      forOrg: () => ({
        mutedBy: org?.muted ? ('org' as const) : null,
        mutedUntil: org?.until ?? null,
        inMaintenance: org?.inMaintenance ?? false,
      }),
    };
  }, [data]);
}
