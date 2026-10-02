'use client';
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { addToGroup, describeGroup, type ToastGroup } from '@/lib/incident-toast';
import { useIncidentBadges } from '@/lib/use-incident-badges';
import { orgPath, useOrg } from './org-context';

const TOAST_ID = 'incidents';

/**
 * Announces incidents that open while the app is in use. Incidents already open when the page
 * loads are not announced (the menu badge says so); new ones are, and ones that arrive together or
 * close together are one toast that updates, not a pile.
 */
export function IncidentToaster() {
  const { orgId, canSupport } = useOrg();
  const router = useRouter();
  const { data } = useIncidentBadges(canSupport);
  const seen = useRef<Set<string> | null>(null);
  const group = useRef<ToastGroup | null>(null);

  useEffect(() => {
    if (!data) return;
    const current = data.recent;
    if (seen.current === null) {
      seen.current = new Set(current.map((i) => i.id));
      return;
    }
    const known = seen.current;
    const fresh = current.filter((i) => !known.has(i.id));
    current.forEach((i) => known.add(i.id));
    if (fresh.length === 0) return;

    group.current = addToGroup(
      group.current,
      fresh.map((i) => ({ id: i.id, severity: i.severity, title: i.title, roomName: i.roomName })),
      Date.now(),
    );
    const { title, description, severity } = describeGroup(group.current.items);
    const show = severity === 'critical' ? toast.error : toast.warning;
    // The same id updates the toast in place while it is still up.
    show(title, {
      id: TOAST_ID,
      description: description || undefined,
      duration: severity === 'critical' ? 20_000 : 10_000,
      action: { label: 'View', onClick: () => router.push(orgPath(orgId, '/incidents')) },
    });
  }, [data, orgId, router]);

  return null;
}
