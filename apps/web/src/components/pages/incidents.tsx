'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, LifeBuoy } from 'lucide-react';
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
import { NewTicketDialog, TicketRef, TicketStatus } from './tickets';

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
  // A device that is part of a group outage is shown under its group, not on its own.
  const all = incidents.data ?? [];
  const shownIds = new Set(all.map((i) => i.id));
  const members = new Map<string, Incident[]>();
  for (const i of all)
    if (i.parentId && shownIds.has(i.parentId))
      members.set(i.parentId, [...(members.get(i.parentId) ?? []), i]);
  const top = all.filter((i) => !i.parentId || !shownIds.has(i.parentId));
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
          {top.map((i) => (
            <li key={i.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{i.title}</span>
                  <SeverityPill severity={i.severity} />
                  {i.meetingsAffected > 0 && (
                    <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                      {i.meetingsAffected === 1
                        ? 'Meeting affected'
                        : `${i.meetingsAffected} meetings affected`}
                    </span>
                  )}
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
                  {i.alsoRooms.length > 0 && (
                    <>
                      {' and '}
                      {i.alsoRooms.map((r, k) => (
                        <span key={r.id}>
                          {k > 0 && ', '}
                          <Link
                            href={orgPath(orgId, `/rooms/${r.id}/monitoring`)}
                            className="hover:text-foreground hover:underline"
                          >
                            {r.name}
                          </Link>
                        </span>
                      ))}
                    </>
                  )}
                  {' · '}
                  {i.status === 'open'
                    ? `opened ${timeAgo(i.openedAt)}`
                    : `resolved ${i.resolvedAt ? dateTime(i.resolvedAt, i.timezone) : ''}`}
                  {i.occurrences > 1 && ` · came back ${i.occurrences - 1}×`}
                </div>
                {i.detail && <p className="text-sm text-muted-foreground">{i.detail}</p>}
                {i.tickets.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    {i.tickets.map((t) => (
                      <span key={t.id} className="inline-flex items-center gap-2">
                        <LifeBuoy aria-hidden className="size-3.5 text-muted-foreground" />
                        <Link
                          href={orgPath(orgId, `/tickets/${t.id}`)}
                          className="font-medium hover:underline"
                        >
                          <TicketRef kestrelRef={t.ref} externalRefs={t.externalRefs} />
                        </Link>
                        <TicketStatus status={t.status} />
                      </span>
                    ))}
                  </div>
                )}
                {i.impact && <MeetingsAtRisk impact={i.impact} compact />}
                {(members.get(i.id) ?? []).length > 0 && (
                  <ul className="mt-1 space-y-0.5 border-l pl-3 text-sm text-muted-foreground">
                    {members.get(i.id)!.map((m) => (
                      <li key={m.id}>
                        {m.title}
                        {m.roomName && ` · ${m.roomName}`}
                        {m.status === 'resolved' && ' · back'}
                      </li>
                    ))}
                  </ul>
                )}
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
                {/* One request at a time: raise another only once the last is resolved or closed. */}
                {!i.tickets.some((t) => t.status === 'open' || t.status === 'in_progress') && (
                  <Button variant="ghost" size="sm" onClick={() => setTicketFor(i)}>
                    {i.tickets.length > 0 ? 'Raise another request' : 'Raise request'}
                  </Button>
                )}
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
