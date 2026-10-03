'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { timeAgo } from '@/lib/format';
import { useTRPC } from '@/trpc/client';

const DEFAULT_DAYS = 14;

/**
 * Organisations that asked to pay yearly by invoice instead of card, and those already approved.
 * Approving sets the days they have to pay (14 unless changed); declining needs a reason the owner
 * will see. An approved organisation can have its days changed, or be revoked.
 */
export function StaffInvoiceRequests() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const pending = useQuery({
    ...trpc.staff.invoiceRequests.list.queryOptions(),
    refetchInterval: 30_000,
  });
  const approved = useQuery(trpc.staff.invoiceRequests.approved.queryOptions());
  const [declining, setDeclining] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  // Days being typed, per organisation. Anything not typed shows the stored value.
  const [days, setDays] = useState<Record<string, string>>({});

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: trpc.staff.invoiceRequests.list.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.staff.invoiceRequests.approved.queryKey() }),
    ]);
    setDeclining(null);
    setRevoking(null);
    setReason('');
  };
  const fail = (e: { message: string }) => toast.error(e.message);
  const decide = useMutation(
    trpc.staff.invoiceRequests.decide.mutationOptions({
      onSuccess: async (_r, v) => {
        await refresh();
        toast.success(v.approve ? 'Approved' : 'Declined');
      },
      onError: fail,
    }),
  );
  const setDaysFor = useMutation(
    trpc.staff.invoiceRequests.setDays.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Days to pay updated');
      },
      onError: fail,
    }),
  );
  const revoke = useMutation(
    trpc.staff.invoiceRequests.revoke.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Invoice billing revoked');
      },
      onError: fail,
    }),
  );

  const daysInput = (orgId: string, stored: number) => (
    <Input
      type="number"
      min={1}
      max={90}
      className="w-20"
      aria-label="Days to pay"
      value={days[orgId] ?? String(stored)}
      onChange={(ev) => setDays((d) => ({ ...d, [orgId]: ev.target.value }))}
    />
  );

  return (
    <PageContainer className="max-w-3xl">
      <PageHeader
        title="Invoice requests"
        description="Organisations asking to pay yearly by invoice instead of card. Once approved, the owner starts the subscription and Stripe emails the invoice, due in the number of days you set (14 by default)."
      />
      {pending.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : !pending.data?.length ? (
        <EmptyState icon={FileText} title="No requests waiting" />
      ) : (
        <ul className="space-y-3">
          {pending.data.map((r) => (
            <li key={r.orgId} className="space-y-2 rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <Link
                    href={`/staff/orgs/${r.orgId}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {r.orgName}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {r.requestedAt ? `Asked ${timeAgo(r.requestedAt)}` : 'Asked'}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    Days to pay
                    {daysInput(r.orgId, DEFAULT_DAYS)}
                  </label>
                  <Button
                    size="sm"
                    disabled={decide.isPending}
                    onClick={() =>
                      decide.mutate({
                        orgId: r.orgId,
                        approve: true,
                        days: Number(days[r.orgId] ?? DEFAULT_DAYS),
                      })
                    }
                  >
                    {decide.isPending && decide.variables?.orgId === r.orgId && <Spinner />}
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDeclining(declining === r.orgId ? null : r.orgId)}
                  >
                    Decline
                  </Button>
                </div>
              </div>
              {r.note && <p className="text-sm">{r.note}</p>}
              {declining === r.orgId && (
                <form
                  className="flex gap-2"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    decide.mutate({ orgId: r.orgId, approve: false, reason });
                  }}
                >
                  <Input
                    aria-label="Reason shown to the owner"
                    placeholder="Reason shown to the owner"
                    value={reason}
                    onChange={(ev) => setReason(ev.target.value)}
                  />
                  <Button type="submit" size="sm" disabled={decide.isPending}>
                    Send
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {!!approved.data?.length && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Approved</h2>
          <ul className="space-y-3">
            {approved.data.map((o) => (
              <li key={o.orgId} className="space-y-2 rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <Link
                      href={`/staff/orgs/${o.orgId}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {o.orgName}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {o.invoiced ? 'Billed by invoice' : 'Approved, not started yet'}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      Days to pay
                      {daysInput(o.orgId, o.days)}
                    </label>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        setDaysFor.isPending ||
                        Number(days[o.orgId] ?? o.days) === o.days ||
                        !days[o.orgId]
                      }
                      onClick={() =>
                        setDaysFor.mutate({ orgId: o.orgId, days: Number(days[o.orgId]) })
                      }
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRevoking(revoking === o.orgId ? null : o.orgId)}
                    >
                      Revoke
                    </Button>
                  </div>
                </div>
                {revoking === o.orgId && (
                  <form
                    className="space-y-2"
                    onSubmit={(ev) => {
                      ev.preventDefault();
                      revoke.mutate({ orgId: o.orgId, reason });
                    }}
                  >
                    <p className="text-xs text-muted-foreground">
                      This only stops them choosing invoice billing again. A running invoiced
                      subscription keeps its current term; cancel it in Stripe if needed.
                    </p>
                    <div className="flex gap-2">
                      <Input
                        aria-label="Reason for revoking"
                        placeholder="Reason (kept in the audit trail, shown to the owner)"
                        value={reason}
                        onChange={(ev) => setReason(ev.target.value)}
                      />
                      <Button type="submit" size="sm" disabled={revoke.isPending}>
                        {revoke.isPending && <Spinner />}
                        Revoke
                      </Button>
                    </div>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageContainer>
  );
}
