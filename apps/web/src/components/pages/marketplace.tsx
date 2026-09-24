'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, Store } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
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
import { ROOM_TYPE_LABEL } from '@/lib/format';
import { useTRPC } from '@/trpc/client';

export const dollars = (cents: number) => (cents === 0 ? 'Free' : `$${(cents / 100).toFixed(2)}`);

const STATUS_LABEL: Record<string, string> = {
  pending: 'In review',
  published: 'Live',
  rejected: 'Not approved',
  withdrawn: 'Withdrawn',
};

export function MarketplaceView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canEdit } = useOrg();
  const [q, setQ] = useState('');
  const list = useQuery(
    trpc.marketplace.browse.queryOptions({ orgId, ...(q.trim() ? { q: q.trim() } : {}) }),
  );
  const canPublish = useQuery({
    ...trpc.billing.status.queryOptions({ orgId }),
    staleTime: 60_000,
  });
  const mine = useQuery({
    ...trpc.marketplace.mine.queryOptions({ orgId }),
    enabled: !!canPublish.data?.entitlements.marketplacePublish,
  });

  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get('purchase');
    if (r === 'success')
      toast.success('Thanks! The template appears in your templates in a moment.');
    if (r === 'cancelled') toast.message('Purchase cancelled. You haven’t been charged.');
  }, []);

  const get = useMutation(
    trpc.marketplace.get.mutationOptions({
      onSuccess: async (res) => {
        if ('url' in res && res.url) return window.location.assign(res.url);
        await qc.invalidateQueries({ queryKey: trpc.marketplace.browse.queryKey() });
        await qc.invalidateQueries({ queryKey: trpc.template.list.queryKey() });
        toast.success('Added to your templates');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const withdraw = useMutation(
    trpc.marketplace.withdraw.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.marketplace.mine.queryKey() }),
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <PageContainer>
      <PageHeader
        title="Marketplace"
        description="Room designs from other organisations. Add one to your templates and adapt it to your own equipment."
        actions={
          <Input
            aria-label="Search the marketplace"
            className="w-56"
            placeholder="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        }
      />
      {list.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : list.data?.length === 0 ? (
        <EmptyState
          icon={Store}
          title={q ? 'Nothing matches that' : 'Nothing here yet'}
          description="Designs appear once they’ve been reviewed."
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.data?.map((l) => (
            <li key={l.id} className="flex flex-col gap-2 rounded-lg border p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">{l.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {ROOM_TYPE_LABEL[l.roomType]} · {l.devices} devices · {l.activities} activities
                    · by {l.publisher}
                  </div>
                </div>
                <div className="text-sm font-medium">{dollars(l.priceCents)}</div>
              </div>
              {l.description && <p className="text-sm text-muted-foreground">{l.description}</p>}
              <div className="mt-auto flex items-center justify-between pt-1">
                <span className="text-xs text-muted-foreground">{l.downloads} added</span>
                {l.owned ? (
                  <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Check className="size-4" /> {l.mine ? 'Yours' : 'In your templates'}
                  </span>
                ) : (
                  canEdit && (
                    <Button
                      size="sm"
                      disabled={get.isPending}
                      onClick={() => get.mutate({ orgId, listingId: l.id })}
                    >
                      {get.isPending && get.variables?.listingId === l.id ? (
                        <Spinner />
                      ) : (
                        <Download data-icon="inline-start" />
                      )}
                      {l.priceCents === 0 ? 'Add' : `Buy ${dollars(l.priceCents)}`}
                    </Button>
                  )
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {mine.data && mine.data.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">Your listings</h2>
          <ul className="divide-y overflow-hidden rounded-lg border">
            {mine.data.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
              >
                <div>
                  <span className="font-medium">{m.name}</span>{' '}
                  <span className="text-muted-foreground">
                    v{m.version} · {dollars(m.priceCents)} · {m.downloads} added
                  </span>
                  {m.reviewNote && (
                    <div className="text-xs text-muted-foreground">Reviewer: {m.reviewNote}</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={m.status === 'rejected' ? 'destructive' : 'secondary'}>
                    {STATUS_LABEL[m.status] ?? m.status}
                  </Badge>
                  {canEdit && (m.status === 'pending' || m.status === 'published') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => withdraw.mutate({ orgId, listingId: m.id })}
                    >
                      Withdraw
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageContainer>
  );
}

/** Share one of the organisation's own templates. Device settings are never included. */
export function PublishDialog({
  template,
  onClose,
}: {
  template: { id: string; name: string; description: string } | null;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('0');
  const publish = useMutation(
    trpc.marketplace.publish.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: trpc.marketplace.mine.queryKey() });
        toast.success('Sent for review. It goes live once approved.');
        onClose();
      },
    }),
  );
  return (
    <Dialog open={!!template} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!template) return;
            publish.mutate({
              orgId,
              templateId: template.id,
              description: description || template.description,
              priceCents: Math.round(Number(price) * 100),
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Publish “{template?.name}”</DialogTitle>
            <DialogDescription>
              Others can add this design to their templates after a review. Addresses, passwords and
              calendar details are removed first.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="pub-desc">What is it good for?</Label>
            <Textarea
              id="pub-desc"
              rows={3}
              maxLength={1000}
              placeholder={template?.description}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pub-price">Price (AUD, 0 for free)</Label>
            <Input
              id="pub-price"
              type="number"
              min={0}
              max={10000}
              step="1"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
          {publish.error && <p className="text-sm text-destructive">{publish.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={publish.isPending}>
              {publish.isPending && <Spinner />}
              Send for review
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Kestrel staff: approve or reject listings waiting for review. */
export function MarketplaceReview() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const admin = useQuery(trpc.marketplace.isAdmin.queryOptions());
  const pending = useQuery({
    ...trpc.marketplace.pending.queryOptions(),
    enabled: admin.data === true,
  });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const review = useMutation(
    trpc.marketplace.review.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.marketplace.pending.queryKey() }),
      onError: (e) => toast.error(e.message),
    }),
  );
  if (admin.isPending) return null;
  if (!admin.data)
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">Not available.</p>
      </PageContainer>
    );
  return (
    <PageContainer>
      <PageHeader title="Marketplace review" description="Listings waiting for approval." />
      {pending.data?.length === 0 && <EmptyState icon={Check} title="Nothing to review" />}
      <ul className="space-y-3">
        {pending.data?.map((l) => (
          <li key={l.id} className="space-y-2 rounded-lg border p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">
                  {l.name} <span className="text-xs text-muted-foreground">v{l.version}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {ROOM_TYPE_LABEL[l.roomType]} · {l.devices} devices · {l.activities} activities ·
                  by {l.publisher} · {dollars(l.priceCents)}
                </div>
              </div>
            </div>
            {l.description && <p className="text-sm">{l.description}</p>}
            <Input
              aria-label="Note to the publisher"
              placeholder="Note to the publisher (shown if rejected)"
              value={notes[l.id] ?? ''}
              onChange={(e) => setNotes((n) => ({ ...n, [l.id]: e.target.value }))}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={review.isPending}
                onClick={() => review.mutate({ listingId: l.id, approve: true })}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={review.isPending}
                onClick={() =>
                  review.mutate({ listingId: l.id, approve: false, note: notes[l.id] })
                }
              >
                Reject
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </PageContainer>
  );
}
