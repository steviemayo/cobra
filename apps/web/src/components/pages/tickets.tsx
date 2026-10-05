'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LifeBuoy, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { SlaBadge } from '@/components/common/sla-badge';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { timeAgo } from '@/lib/format';
import { useRoomsOverview } from '@/lib/use-estate';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

export const TICKET_STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
};
export const PRIORITY_LABEL: Record<string, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};
const STATUS_TONE: Record<string, string> = {
  open: 'bg-warning',
  in_progress: 'bg-brand',
  resolved: 'bg-success',
  closed: 'bg-muted-foreground/35',
};

export function TicketStatus({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', STATUS_TONE[status])} />
      {TICKET_STATUS_LABEL[status] ?? status}
    </span>
  );
}

/**
 * A ticket's identifier. When a service desk is linked, its reference leads (it is the one the desk's
 * people quote) with Kestrel's number beside it; otherwise Kestrel's number stands alone.
 */
export function TicketRef({
  kestrelRef,
  externalRefs,
  className,
}: {
  kestrelRef: string;
  externalRefs: { connector: string; ref: string }[];
  className?: string;
}) {
  const first = externalRefs[0];
  return (
    <span className={cn('font-mono', className)}>
      {first ? (
        <>
          <span title={first.connector}>{externalRefs.map((e) => e.ref).join(', ')}</span>
          <span className="ml-1.5 text-muted-foreground">{kestrelRef}</span>
        </>
      ) : (
        kestrelRef
      )}
    </span>
  );
}

/** Raise a support request, optionally about a room or an incident. */
export function NewTicketDialog({
  open,
  onOpenChange,
  defaults,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaults?: { roomId?: string; incidentId?: string; title?: string };
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const rooms = useRoomsOverview();
  const [title, setTitle] = useState(defaults?.title ?? '');
  const [body, setBody] = useState('');
  const [roomId, setRoomId] = useState(defaults?.roomId ?? 'none');
  const [priority, setPriority] = useState<'low' | 'normal' | 'high' | 'urgent'>('normal');
  const [toKestrel, setToKestrel] = useState(false);
  const create = useMutation(
    trpc.ticket.create.mutationOptions({
      onSuccess: async (made) => {
        await qc.invalidateQueries({ queryKey: trpc.ticket.list.queryKey() });
        // An incident shows the request raised from it.
        await qc.invalidateQueries({ queryKey: trpc.monitoring.incidents.queryKey() });
        toast.success(`Support request ${made.ref} sent`);
        setBody('');
        onOpenChange(false);
      },
    }),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({
              orgId,
              title,
              body,
              priority,
              toKestrel: canSupport && toKestrel,
              ...(roomId !== 'none' ? { roomId } : {}),
              ...(defaults?.incidentId ? { incidentId: defaults.incidentId } : {}),
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Get help</DialogTitle>
            <DialogDescription>Tell us what’s wrong. We’ll reply on the ticket.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="t-title">What’s the problem?</Label>
            <Input
              id="t-title"
              autoFocus
              required
              minLength={3}
              maxLength={150}
              placeholder="The screen in Boardroom stays black"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="t-body">Details</Label>
            <Textarea
              id="t-body"
              required
              maxLength={5000}
              rows={4}
              placeholder="What did you expect to happen, and what happened instead?"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="t-room">Room</Label>
              <SimpleSelect
                id="t-room"
                className="w-full"
                value={roomId}
                onValueChange={setRoomId}
                options={[
                  { value: 'none', label: 'Not about one room' },
                  ...(rooms.data ?? []).map((r) => ({ value: r.id, label: r.name })),
                ]}
              />
            </div>
            {canSupport && (
              <div className="space-y-2">
                <Label htmlFor="t-priority">Priority</Label>
                <SimpleSelect
                  id="t-priority"
                  className="w-full"
                  value={priority}
                  onValueChange={setPriority}
                  options={Object.entries(PRIORITY_LABEL).map(([value, label]) => ({
                    value: value as 'low',
                    label,
                  }))}
                />
              </div>
            )}
          </div>
          {canSupport && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={toKestrel}
                onChange={(e) => setToKestrel(e.target.checked)}
              />
              <span>
                Send to Kestrel support
                <span className="block text-xs text-muted-foreground">
                  For problems with Kestrel itself, not with your own rooms. Otherwise your own team
                  picks it up first.
                </span>
              </span>
            </label>
          )}
          {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={create.isPending || title.trim().length < 3 || !body.trim()}
            >
              {create.isPending && <Spinner />}
              Send request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TicketsView() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [filter, setFilter] = useState<'active' | 'all' | 'resolved' | 'closed'>('active');
  const [creating, setCreating] = useState(false);
  const tickets = useQuery({
    ...trpc.ticket.list.queryOptions({ orgId, status: filter }),
    refetchInterval: 15_000,
  });

  return (
    <PageContainer>
      <PageHeader
        title="Support"
        description="Requests for help with rooms and equipment."
        actions={
          <>
            <SimpleSelect
              size="sm"
              className="w-36"
              value={filter}
              onValueChange={setFilter}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'resolved', label: 'Resolved' },
                { value: 'closed', label: 'Closed' },
                { value: 'all', label: 'All' },
              ]}
            />
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" /> New request
            </Button>
          </>
        }
      />
      {tickets.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : tickets.data?.length === 0 ? (
        <EmptyState
          icon={LifeBuoy}
          title={filter === 'active' ? 'No open requests' : 'Nothing here'}
          description="If something isn’t working, send a request and we’ll pick it up."
          action={<Button onClick={() => setCreating(true)}>New request</Button>}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Request</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Room</TableHead>
                <TableHead className="text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tickets.data?.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <Link
                      href={orgPath(orgId, `/tickets/${t.id}`)}
                      className="font-medium hover:underline"
                    >
                      {t.title}
                    </Link>
                    <TicketRef
                      kestrelRef={t.ref}
                      externalRefs={t.externalRefs}
                      className="ml-2 text-xs font-normal text-muted-foreground"
                    />
                    {t.routedTo.startsWith('msp:') && (
                      <span className="ml-2 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
                        With service provider
                      </span>
                    )}
                    {t.routedTo === 'kestrel' && (
                      <span className="ml-2 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
                        With Kestrel
                      </span>
                    )}
                    {t.createdByEmail && (
                      <div className="text-xs text-muted-foreground">
                        {t.mine ? 'You' : t.createdByEmail}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <TicketStatus status={t.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {PRIORITY_LABEL[t.priority]}
                  </TableCell>
                  <TableCell>
                    <SlaBadge sla={t.sla} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{t.roomName ?? '–'}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {timeAgo(t.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {creating && <NewTicketDialog open onOpenChange={setCreating} />}
    </PageContainer>
  );
}
