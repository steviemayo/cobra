'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, LifeBuoy, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { SlaBadge } from '@/components/common/sla-badge';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { dateTime } from '@/components/common/health';
import { useTRPC } from '@/trpc/client';
import { PRIORITY_LABEL, TICKET_STATUS_LABEL, TicketStatus } from './tickets';

export function TicketDetail({ ticketId }: { ticketId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, role, canSupport, user } = useOrg();
  const ticket = useQuery({
    ...trpc.ticket.get.queryOptions({ orgId, ticketId }),
    refetchInterval: 10_000,
  });
  // The team, and people from a connected service provider.
  const assignees = useQuery({
    ...trpc.ticket.assignees.queryOptions({ orgId, ticketId }),
    enabled: canSupport,
  });
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [confirmEscalate, setConfirmEscalate] = useState(false);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: trpc.ticket.get.queryKey({ orgId, ticketId }) });
    await qc.invalidateQueries({ queryKey: trpc.ticket.list.queryKey() });
  };
  const comment = useMutation(
    trpc.ticket.comment.mutationOptions({
      onSuccess: async () => {
        setReply('');
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const route = useMutation(
    trpc.ticket.route.mutationOptions({
      onSuccess: refresh,
      onError: (e) => toast.error(e.message),
    }),
  );
  const escalate = useMutation(
    trpc.ticket.escalate.mutationOptions({
      onSuccess: async () => {
        toast.success('Sent to Kestrel support');
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const update = useMutation(
    trpc.ticket.update.mutationOptions({
      onSuccess: refresh,
      onError: (e) => toast.error(e.message),
    }),
  );

  const back = (
    <Link
      href={orgPath(orgId, '/tickets')}
      className={buttonVariants({ variant: 'ghost', size: 'sm' })}
    >
      <ArrowLeft data-icon="inline-start" /> All requests
    </Link>
  );

  if (ticket.isPending)
    return (
      <PageContainer>
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-40 w-full" />
      </PageContainer>
    );
  if (!ticket.data)
    return (
      <PageContainer>
        <EmptyState icon={LifeBuoy} title="Request not found" action={back} />
      </PageContainer>
    );
  const t = ticket.data;
  const staff = assignees.data ?? [];
  const closed = t.status === 'closed';

  return (
    <PageContainer>
      {back}
      <PageHeader
        title={t.title}
        meta={
          <>
            <TicketStatus status={t.status} />
            <span aria-hidden className="text-muted-foreground/50">
              ·
            </span>
            <span className="text-sm text-muted-foreground">
              {PRIORITY_LABEL[t.priority]} priority
            </span>
            {t.providerName && (
              <>
                <span aria-hidden className="text-muted-foreground/50">
                  ·
                </span>
                <span className="text-sm font-medium">With {t.providerName}</span>
              </>
            )}
            {t.routedTo === 'kestrel' && (
              <>
                <span aria-hidden className="text-muted-foreground/50">
                  ·
                </span>
                <span className="text-sm font-medium">With Kestrel support</span>
              </>
            )}
            {t.room && (
              <>
                <span aria-hidden className="text-muted-foreground/50">
                  ·
                </span>
                <Link
                  href={orgPath(orgId, `/rooms/${t.room.id}/monitoring`)}
                  className="text-sm text-muted-foreground hover:text-foreground hover:underline"
                >
                  {t.room.name}
                </Link>
              </>
            )}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_16rem]">
        <div className="space-y-4">
          <div className="rounded-lg border p-4">
            <div className="mb-2 text-xs text-muted-foreground">
              {t.createdByEmail ?? 'Former member'} · {dateTime(t.createdAt)}
            </div>
            <p className="whitespace-pre-wrap text-sm">{t.body}</p>
          </div>
          {t.comments.map((c) => (
            <div
              key={c.id}
              className={`rounded-lg border p-4 ${c.visibility === 'internal' ? 'border-warning/50 bg-warning/5' : ''}`}
            >
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                {c.visibility === 'internal' && (
                  <span className="inline-flex items-center gap-1 font-medium text-warning">
                    <Lock className="size-3" /> Internal note
                  </span>
                )}
                {c.authorEmail} · {dateTime(c.createdAt)}
              </div>
              <p className="whitespace-pre-wrap text-sm">{c.body}</p>
            </div>
          ))}
          {closed && role === 'customer_viewer' ? (
            <p className="text-sm text-muted-foreground">
              This request is closed. Reply to reopen it.
            </p>
          ) : null}
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              comment.mutate({ orgId, ticketId, body: reply, internal: canSupport && internal });
            }}
          >
            <Textarea
              aria-label="Reply"
              rows={3}
              maxLength={5000}
              placeholder="Write a reply"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
            />
            <div className="flex items-center justify-end gap-3">
              {canSupport && (
                <label className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={internal}
                    onChange={(e) => setInternal(e.target.checked)}
                  />
                  Internal note (your team and Kestrel only; customers cannot see it)
                </label>
              )}
              <Button type="submit" size="sm" disabled={comment.isPending || !reply.trim()}>
                {comment.isPending && <Spinner />}
                {internal && canSupport ? 'Add note' : 'Reply'}
              </Button>
            </div>
          </form>
        </div>

        <aside className="space-y-4">
          {canSupport ? (
            <>
              {t.sla && (
                <Field label="Target">
                  <SlaBadge sla={t.sla} className="text-sm" />
                </Field>
              )}
              <Field label="Status">
                <SimpleSelect
                  className="w-full"
                  value={t.status as 'open'}
                  onValueChange={(status) => update.mutate({ orgId, ticketId, status })}
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
                  onValueChange={(priority) => update.mutate({ orgId, ticketId, priority })}
                  options={Object.entries(PRIORITY_LABEL).map(([value, label]) => ({
                    value: value as 'normal',
                    label,
                  }))}
                />
              </Field>
              {!closed && t.routedTo !== 'kestrel' && (t.providerName || t.providerAvailable) && (
                <Field label="Service provider">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={route.isPending}
                    onClick={() =>
                      route.mutate({ orgId, ticketId, to: t.providerName ? 'org' : 'provider' })
                    }
                  >
                    {t.providerName ? 'Take back for our team' : 'Send to our service provider'}
                  </Button>
                </Field>
              )}
              {t.routedTo !== 'kestrel' && !closed && (
                <Field label="Kestrel support">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={escalate.isPending}
                    onClick={() => setConfirmEscalate(true)}
                  >
                    Escalate to Kestrel support
                  </Button>
                </Field>
              )}
              <Field label="Assigned to">
                <SimpleSelect
                  className="w-full"
                  value={t.assignedTo ?? 'none'}
                  onValueChange={(v) =>
                    update.mutate({ orgId, ticketId, assignedTo: v === 'none' ? null : v })
                  }
                  options={[
                    { value: 'none', label: 'Unassigned' },
                    ...staff.map((m) => ({
                      value: m.userId,
                      label: m.userId === user.id ? 'Me' : m.label,
                    })),
                  ]}
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Assigned to">
                <span className="text-sm">{t.assigneeEmail ?? 'Not yet assigned'}</span>
              </Field>
              {!closed && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ orgId, ticketId, status: 'closed' })}
                >
                  Close this request
                </Button>
              )}
            </>
          )}
        </aside>
      </div>
      <ConfirmDialog
        open={confirmEscalate}
        onOpenChange={setConfirmEscalate}
        title="Send this to Kestrel support?"
        description="Kestrel support will be able to read this ticket and reply to it. Use this when the problem is with Kestrel itself, not your own rooms."
        confirmLabel="Escalate"
        onConfirm={() => escalate.mutate({ orgId, ticketId })}
      />
    </PageContainer>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}
