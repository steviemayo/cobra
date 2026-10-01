'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/common/empty-state';
import { INCIDENT_KIND_LABEL, SeverityPill, dateTime } from '@/components/common/health';
import { MeetingsAtRisk } from '@/components/common/meetings-at-risk';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { timeAgo } from '@/lib/format';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';
import { NewTicketDialog } from './tickets';

type Incident = RouterOutputs['monitoring']['incidents'][number];

export function IncidentsView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const [ticketFor, setTicketFor] = useState<Incident | null>(null);
  const incidents = useQuery({
    ...trpc.monitoring.incidents.queryOptions({ orgId, status }),
    refetchInterval: 5_000,
  });
  const ack = useMutation(
    trpc.monitoring.acknowledge.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.monitoring.incidents.queryKey() }),
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <PageContainer>
      <PageHeader
        title="Incidents"
        description="Problems Kestrel has spotted. They close themselves when the problem goes away."
        actions={
          <SimpleSelect
            size="sm"
            className="w-36"
            value={status}
            onValueChange={setStatus}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'resolved', label: 'Resolved' },
              { value: 'all', label: 'All' },
            ]}
          />
        }
      />
      {incidents.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : incidents.data?.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title={status === 'open' ? 'All clear' : 'No incidents'}
          description={
            status === 'open'
              ? 'Nothing is wrong right now. New problems show up here and in your alert channels.'
              : undefined
          }
        />
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {incidents.data?.map((i) => (
            <li key={i.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{i.title}</span>
                  <SeverityPill severity={i.severity} />
                </div>
                <div className="text-sm text-muted-foreground">
                  {INCIDENT_KIND_LABEL[i.kind] ?? i.kind}
                  {i.roomId && i.roomName && (
                    <>
                      {' · '}
                      <Link
                        href={orgPath(orgId, `/rooms/${i.roomId}/monitoring`)}
                        className="hover:text-foreground hover:underline"
                      >
                        {i.roomName}
                      </Link>
                    </>
                  )}
                  {' · '}
                  {i.status === 'open'
                    ? `opened ${timeAgo(i.openedAt)}`
                    : `resolved ${i.resolvedAt ? dateTime(i.resolvedAt, i.timezone) : ''}`}
                  {i.occurrences > 1 && ` · came back ${i.occurrences - 1}×`}
                </div>
                {i.detail && <p className="text-sm text-muted-foreground">{i.detail}</p>}
                {i.impact && <MeetingsAtRisk impact={i.impact} compact />}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {i.status === 'open' && canSupport && !i.acknowledged && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={ack.isPending}
                    onClick={() => ack.mutate({ orgId, incidentId: i.id })}
                  >
                    Acknowledge
                  </Button>
                )}
                {i.acknowledged && i.status === 'open' && (
                  <span className="text-xs text-muted-foreground">Acknowledged</span>
                )}
                <Button variant="ghost" size="sm" onClick={() => setTicketFor(i)}>
                  Raise request
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {ticketFor && (
        <NewTicketDialog
          open
          onOpenChange={(o) => !o && setTicketFor(null)}
          defaults={{
            title: ticketFor.title,
            incidentId: ticketFor.id,
            ...(ticketFor.roomId ? { roomId: ticketFor.roomId } : {}),
          }}
        />
      )}
    </PageContainer>
  );
}
