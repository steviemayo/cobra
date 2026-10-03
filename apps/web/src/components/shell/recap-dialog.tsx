'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Recap } from '@/server/recap';
import { useTRPC } from '@/trpc/client';
import { orgPath, useOrg } from './org-context';

/** How often the portal tells the server the person is still here (which also keeps "away" honest). */
const VISIT_MS = 5 * 60_000;

export function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

function Kpi({ label, value, tone }: { label: string; value: string | number; tone?: 'bad' }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div
        className={`text-xl font-semibold tabular-nums ${tone === 'bad' ? 'text-destructive' : ''}`}
      >
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Section({
  title,
  href,
  children,
}: {
  title: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        <Link href={href} className="text-xs text-muted-foreground hover:underline">
          View
        </Link>
      </div>
      {children}
    </section>
  );
}

/**
 * Once per session (away 30 minutes or more), a summary of what happened since the person was last
 * here: incidents, tickets and changes made by others. Dismiss it, or switch it off for good.
 */
export function RecapDialog() {
  const { orgId, canSupport } = useOrg();
  const trpc = useTRPC();
  const [recap, setRecap] = useState<Recap | null>(null);
  const [open, setOpen] = useState(false);
  const shown = useRef(false);

  const visit = useMutation(trpc.recap.visit.mutationOptions());
  const silence = useMutation(trpc.recap.setSilenced.mutationOptions());

  useEffect(() => {
    if (!canSupport) return;
    const ping = () => {
      if (document.visibilityState !== 'visible') return;
      visit.mutate(
        { orgId },
        {
          onSuccess: (r) => {
            // One recap per page load; later pings only keep the last-seen time fresh.
            if (r.recap && !shown.current) {
              shown.current = true;
              setRecap(r.recap);
              setOpen(true);
            }
          },
        },
      );
    };
    ping();
    const t = setInterval(ping, VISIT_MS);
    return () => clearInterval(t);
  }, [orgId, canSupport]);

  if (!recap) return null;
  const { incidents, tickets, changes } = recap;
  const base = (p: string) => orgPath(orgId, p);
  const since = new Date(recap.since).toLocaleString();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Since you were last here</DialogTitle>
          <DialogDescription>Everything that happened after {since}.</DialogDescription>
        </DialogHeader>

        {incidents && (
          <Section title="Incidents" href={base('/incidents')}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Kpi label="Opened" value={incidents.kpis.opened} />
              <Kpi label="Resolved" value={incidents.kpis.resolved} />
              <Kpi
                label="Open now"
                value={incidents.kpis.stillOpen}
                tone={incidents.kpis.critical ? 'bad' : undefined}
              />
              <Kpi
                label="Avg time to fix"
                value={
                  incidents.kpis.meanMinutesToResolve === null
                    ? '–'
                    : formatMinutes(incidents.kpis.meanMinutesToResolve)
                }
              />
            </div>
            {(incidents.kpis.roomsAffected > 0 || incidents.kpis.meetingsAffected > 0) && (
              <p className="text-xs text-muted-foreground">
                {incidents.kpis.roomsAffected} room{incidents.kpis.roomsAffected === 1 ? '' : 's'}{' '}
                affected
                {incidents.kpis.meetingsAffected > 0 &&
                  `, ${incidents.kpis.meetingsAffected} meeting${incidents.kpis.meetingsAffected === 1 ? '' : 's'} hit`}
                {incidents.kpis.critical > 0 && `, ${incidents.kpis.critical} critical still open`}
              </p>
            )}
            <ul className="space-y-1 text-sm">
              {incidents.items.map((i) => (
                <li key={i.id} className="flex justify-between gap-2">
                  <span className="truncate">
                    {i.title}
                    {i.roomName && <span className="text-muted-foreground"> · {i.roomName}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {i.resolved ? 'resolved' : i.severity}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {tickets && (tickets.opened > 0 || tickets.closed > 0 || tickets.assignedToYou > 0) && (
          <Section title="Tickets" href={base('/tickets')}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Kpi label="New" value={tickets.opened} />
              <Kpi label="Closed" value={tickets.closed} />
              <Kpi label="Escalated" value={tickets.escalated} />
              <Kpi label="Assigned to you" value={tickets.assignedToYou} />
            </div>
            <ul className="space-y-1 text-sm">
              {tickets.items.map((t) => (
                <li key={t.id} className="flex justify-between gap-2">
                  <span className="truncate">
                    {t.title}
                    {t.roomName && <span className="text-muted-foreground"> · {t.roomName}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{t.priority}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {changes && changes.total > 0 && (
          <Section title="Changes by others" href={base('/settings/activity')}>
            <p className="text-sm">
              {changes.total} change{changes.total === 1 ? '' : 's'}
              {changes.deployments > 0 &&
                `, ${changes.deployments} deployment${changes.deployments === 1 ? '' : 's'}`}
              {changes.people.length > 0 &&
                ` — ${changes.people.map((p) => `${p.actor} (${p.count})`).join(', ')}`}
            </p>
            <ul className="space-y-1 text-sm">
              {changes.items.map((c) => (
                <li key={c.id} className="flex justify-between gap-2">
                  <span className="truncate">{c.summary}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{c.actor}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={silence.isPending}
            onClick={() =>
              silence.mutate({ orgId, silenced: true }, { onSuccess: () => setOpen(false) })
            }
          >
            Don&apos;t show this again
          </Button>
          <Button onClick={() => setOpen(false)}>Dismiss</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
