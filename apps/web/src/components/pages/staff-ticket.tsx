'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { hasStaffRole } from '@kestrel/model';
import { SlaBadge } from '@/components/common/sla-badge';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { dateTime } from '@/components/common/health';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import { PRIORITY_LABEL, TICKET_STATUS_LABEL } from './tickets';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

/** One escalated ticket: the whole thread including internal notes, and what staff can do about it. */
export function StaffTicket({ ticketId }: { ticketId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const me = useQuery(trpc.staff.me.queryOptions());
  const callouts = useQuery(trpc.staff.callouts.list.queryOptions({ ticketId }));
  const ticket = useQuery({
    ...trpc.staff.tickets.get.queryOptions({ ticketId }),
    refetchInterval: 15_000,
  });
  const canWork = hasStaffRole(me.data?.roles ?? [], 'support');
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [note, setNote] = useState('');

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.staff.tickets.get.queryKey({ ticketId }) }),
      qc.invalidateQueries({ queryKey: trpc.staff.tickets.queue.queryKey() }),
    ]);
  const fail = (e: { message: string }) => toast.error(e.message);
  const comment = useMutation(
    trpc.staff.tickets.comment.mutationOptions({
      onSuccess: async () => {
        setReply('');
        await refresh();
      },
      onError: fail,
    }),
  );
  const update = useMutation(
    trpc.staff.tickets.update.mutationOptions({ onSuccess: refresh, onError: fail }),
  );
  const handBack = useMutation(
    trpc.staff.tickets.handBack.mutationOptions({
      onSuccess: async () => {
        toast.success('Handed back to the organisation');
        await refresh();
      },
      onError: fail,
    }),
  );

  const back = (
    <Link
      href="/staff/tickets"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" /> All tickets
    </Link>
  );
  if (ticket.isPending)
    return (
      <PageContainer>
        <Skeleton className="h-64 w-full" />
      </PageContainer>
    );
  if (ticket.error || !ticket.data)
    return (
      <PageContainer>
        {back}
        <p className="text-sm text-destructive">{ticket.error?.message ?? 'Not found'}</p>
      </PageContainer>
    );
  const t = ticket.data;
  const withKestrel = t.routedTo === 'kestrel';

  return (
    <PageContainer>
      <PageHeader
        title={t.title}
        description={`${t.orgName} · ${TICKET_STATUS_LABEL[t.status]} · ${PRIORITY_LABEL[t.priority]} priority${t.roomName ? ` · ${t.roomName}` : ''}`}
        actions={back}
      />
      {withKestrel && (
        <p className="text-sm">
          <span className="text-muted-foreground">Target: </span>
          <SlaBadge sla={t.sla} className="text-sm" />
        </p>
      )}
      {!withKestrel && (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          This ticket is with the organisation’s own team, so it can be read here but not worked.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_16rem]">
        <div className="space-y-3">
          <div className="rounded-lg border p-4">
            <div className="mb-2 text-xs text-muted-foreground">
              {t.createdByEmail ?? 'Former member'} · {dateTime(t.createdAt)}
            </div>
            <p className="whitespace-pre-wrap text-sm">{t.body}</p>
          </div>
          {t.comments.map((c) => (
            <div
              key={c.id}
              className={cn(
                'rounded-lg border p-4',
                c.visibility === 'internal' && 'border-warning/50 bg-warning/5',
                c.fromStaff && c.visibility === 'public' && 'border-primary/30',
              )}
            >
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                {c.visibility === 'internal' && (
                  <span className="inline-flex items-center gap-1 font-medium text-warning">
                    <Lock className="size-3" /> Internal note
                  </span>
                )}
                {c.author} · {dateTime(c.createdAt)}
              </div>
              <p className="whitespace-pre-wrap text-sm">{c.body}</p>
            </div>
          ))}

          {withKestrel && canWork && (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                comment.mutate({
                  ticketId,
                  body: reply,
                  visibility: internal ? 'internal' : 'public',
                });
              }}
            >
              <div className="flex gap-2 text-xs">
                <button
                  type="button"
                  aria-pressed={!internal}
                  onClick={() => setInternal(false)}
                  className={cn(
                    'rounded-full border px-3 py-1',
                    !internal && 'border-primary bg-primary/10 font-medium',
                  )}
                >
                  Reply to the organisation
                </button>
                <button
                  type="button"
                  aria-pressed={internal}
                  onClick={() => setInternal(true)}
                  className={cn(
                    'rounded-full border px-3 py-1',
                    internal && 'border-warning bg-warning/10 font-medium',
                  )}
                >
                  Internal note
                </button>
              </div>
              <Textarea
                aria-label={internal ? 'Internal note' : 'Reply'}
                rows={3}
                maxLength={5000}
                placeholder={
                  internal
                    ? 'Only Kestrel staff and the organisation’s team can see this'
                    : 'The organisation will see this as Kestrel support'
                }
                value={reply}
                onChange={(e) => setReply(e.target.value)}
              />
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={comment.isPending || !reply.trim()}>
                  {comment.isPending && <Spinner />} {internal ? 'Add note' : 'Send reply'}
                </Button>
              </div>
            </form>
          )}
        </div>

        <aside className="space-y-4">
          {(callouts.data?.callouts.length ?? 0) > 0 && (
            <Field label="Callouts">
              <div className="space-y-2">
                {callouts.data!.callouts.map((c) => (
                  <Link
                    key={c.id}
                    href="/staff/callouts"
                    className="block rounded-md border px-2.5 py-1.5 text-sm hover:bg-muted/50"
                  >
                    <div className="truncate font-medium">{c.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.routedTo !== 'kestrel'
                        ? `With ${c.providerName ?? 'a service provider'} (monitoring)`
                        : c.status}
                    </div>
                  </Link>
                ))}
              </div>
            </Field>
          )}
          <Field label="Organisation">
            <div className="space-y-1 text-sm">
              <Link href={`/staff/orgs/${t.orgId}`} className="hover:underline">
                {t.orgName}
              </Link>
              <div>
                <Link
                  href={`/staff/orgs/${t.orgId}?ticket=${t.id}`}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  Open as support (links this ticket)
                </Link>
              </div>
            </div>
          </Field>
          {withKestrel && canWork && (
            <>
              <Field label="Status">
                <SimpleSelect
                  className="w-full"
                  value={t.status as 'open'}
                  onValueChange={(status) => update.mutate({ ticketId, status })}
                  options={Object.entries(TICKET_STATUS_LABEL).map(([value, label]) => ({
                    value: value as 'open',
                    label,
                  }))}
                />
              </Field>
              <Field label="Priority">
                <SimpleSelect
                  className="w-full"
                  value={t.priority as 'normal'}
                  onValueChange={(priority) => update.mutate({ ticketId, priority })}
                  options={Object.entries(PRIORITY_LABEL).map(([value, label]) => ({
                    value: value as 'normal',
                    label,
                  }))}
                />
              </Field>
              <Field label="Assigned to">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span>{t.assignee ?? 'Nobody'}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={update.isPending}
                    onClick={() => update.mutate({ ticketId, assignToMe: !t.assignedToMe })}
                  >
                    {t.assignedToMe ? 'Let go' : 'Take it'}
                  </Button>
                </div>
              </Field>
              <Field label="Hand back to the organisation">
                <div className="space-y-2">
                  <Textarea
                    aria-label="Note for the organisation"
                    rows={2}
                    maxLength={1000}
                    placeholder="Optional note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={handBack.isPending}
                    onClick={() => handBack.mutate({ ticketId, note: note || undefined })}
                  >
                    Hand back
                  </Button>
                </div>
              </Field>
            </>
          )}
        </aside>
      </div>
    </PageContainer>
  );
}
