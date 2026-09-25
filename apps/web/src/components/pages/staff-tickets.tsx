'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { LifeBuoy } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import { PRIORITY_LABEL, TICKET_STATUS_LABEL } from './tickets';

const STATUS_FILTERS = [
  { id: 'active', label: 'Open' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
] as const;
const PRIORITY_FILTERS = [
  { id: '', label: 'Any priority' },
  { id: 'urgent', label: 'Urgent' },
  { id: 'high', label: 'High' },
  { id: 'normal', label: 'Normal' },
  { id: 'low', label: 'Low' },
] as const;

const PRIORITY_TONE: Record<string, string> = {
  urgent: 'text-destructive font-medium',
  high: 'text-warning font-medium',
};

/** Tickets that organisations have escalated to Kestrel, most urgent first. */
export function StaffTickets() {
  const trpc = useTRPC();
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]['id']>('active');
  const [priority, setPriority] = useState<(typeof PRIORITY_FILTERS)[number]['id']>('');
  const queue = useQuery({
    ...trpc.staff.tickets.queue.queryOptions({ status, ...(priority ? { priority } : {}) }),
    refetchInterval: 30_000,
  });

  const chip = (active: boolean) =>
    cn(
      'rounded-full border px-3 py-1 text-xs',
      active ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground',
    );

  return (
    <PageContainer wide>
      <PageHeader
        title="Tickets"
        description="Support requests that organisations have escalated to Kestrel."
      />
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={chip(status === f.id)}
            aria-pressed={status === f.id}
            onClick={() => setStatus(f.id)}
          >
            {f.label}
          </button>
        ))}
        <span aria-hidden className="mx-1 text-muted-foreground/40">
          |
        </span>
        {PRIORITY_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={chip(priority === f.id)}
            aria-pressed={priority === f.id}
            onClick={() => setPriority(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {queue.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : queue.error ? (
        <p className="text-sm text-destructive">{queue.error.message}</p>
      ) : queue.data.length === 0 ? (
        <EmptyState icon={LifeBuoy} title="Nothing waiting for Kestrel" />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Ticket</th>
                <th className="px-3 py-2 font-medium">Organisation</th>
                <th className="px-3 py-2 font-medium">Priority</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Waiting on</th>
                <th className="px-3 py-2 font-medium">Assigned</th>
                <th className="px-3 py-2 font-medium">Escalated</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {queue.data.map((t) => (
                <tr key={t.id} className="hover:bg-muted/40">
                  <td className="px-3 py-2">
                    <Link href={`/staff/tickets/${t.id}`} className="font-medium hover:underline">
                      {t.title}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/staff/orgs/${t.orgId}`} className="hover:underline">
                      {t.orgName}
                    </Link>
                  </td>
                  <td className={cn('px-3 py-2', PRIORITY_TONE[t.priority])}>
                    {PRIORITY_LABEL[t.priority]}
                  </td>
                  <td className="px-3 py-2">{TICKET_STATUS_LABEL[t.status]}</td>
                  <td className="px-3 py-2">
                    {t.awaiting === 'kestrel' ? (
                      <span className="text-warning">Kestrel</span>
                    ) : (
                      <span className="text-muted-foreground">Organisation</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{t.assignee ?? 'Nobody'}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {timeAgo(t.escalatedAt ?? t.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageContainer>
  );
}
