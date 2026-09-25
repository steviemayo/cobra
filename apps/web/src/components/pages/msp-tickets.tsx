'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { LifeBuoy } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Skeleton } from '@/components/ui/skeleton';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import { PRIORITY_LABEL, TICKET_STATUS_LABEL } from './tickets';

/** Support requests that customers have routed to this provider, across all of them. */
export function MspTickets() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [status, setStatus] = useState<'active' | 'all'>('active');
  const queue = useQuery({
    ...trpc.msp.tickets.queryOptions({ orgId, status }),
    refetchInterval: 30_000,
  });
  const chip = (on: boolean) =>
    cn(
      'rounded-full border px-3 py-1 text-xs',
      on ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground',
    );

  return (
    <PageContainer wide>
      <PageHeader
        title="Support queue"
        description="Requests your customers have sent to you. Open one to reply in that customer’s organisation."
      />
      <div className="flex gap-2">
        <button
          type="button"
          className={chip(status === 'active')}
          onClick={() => setStatus('active')}
        >
          Open
        </button>
        <button type="button" className={chip(status === 'all')} onClick={() => setStatus('all')}>
          All
        </button>
      </div>
      {queue.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : queue.error ? (
        <p className="text-sm text-destructive">{queue.error.message}</p>
      ) : queue.data.length === 0 ? (
        <EmptyState icon={LifeBuoy} title="Nothing waiting for you" />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Request</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Priority</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {queue.data.map((t) => (
                <tr key={t.id} className="hover:bg-muted/40">
                  <td className="px-3 py-2">
                    <Link
                      href={orgPath(t.orgId, `/tickets/${t.id}`)}
                      className="font-medium hover:underline"
                    >
                      {t.title}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{t.orgName}</td>
                  <td
                    className={cn(
                      'px-3 py-2',
                      t.priority === 'urgent' && 'font-medium text-destructive',
                      t.priority === 'high' && 'font-medium text-warning',
                    )}
                  >
                    {PRIORITY_LABEL[t.priority]}
                  </td>
                  <td className="px-3 py-2">{TICKET_STATUS_LABEL[t.status]}</td>
                  <td className="px-3 py-2 text-muted-foreground">{timeAgo(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageContainer>
  );
}
