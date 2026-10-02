'use client';
import { useQuery } from '@tanstack/react-query';
import { useOrg } from '@/components/shell/org-context';
import { useTRPC } from '@/trpc/client';

/** How often the menu badges and toasts look for new incidents. */
export const BADGE_POLL_MS = 15_000;

/** Open incidents that need someone, for the menu badges and toasts. Shared by every user of it. */
export function useIncidentBadges(enabled = true) {
  const { orgId } = useOrg();
  const trpc = useTRPC();
  return useQuery({
    ...trpc.monitoring.incidentBadges.queryOptions({ orgId }),
    enabled,
    refetchInterval: BADGE_POLL_MS,
    // A hidden tab does not need to keep asking; it catches up when it is shown again.
    refetchIntervalInBackground: false,
  });
}

/** Per-room trouble from the badge data, keyed by room id. */
export function roomTrouble(data: ReturnType<typeof useIncidentBadges>['data']) {
  return new Map((data?.rooms ?? []).map((r) => [r.roomId, r]));
}
