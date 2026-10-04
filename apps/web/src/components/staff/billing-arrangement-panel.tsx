'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { hasStaffRole } from '@kestrel/model';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { formatDate, plural } from '@/lib/format';
import { useTRPC } from '@/trpc/client';

/**
 * Who pays for this organisation: a connected provider paying on its behalf, the discount Kestrel
 * gives it as a provider, and a way to unwind an arrangement. Reading needs staff; changing needs
 * the billing role (BD-13).
 */
export function BillingArrangementPanel({ orgId }: { orgId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const me = useQuery(trpc.staff.me.queryOptions());
  const state = useQuery(trpc.staff.delegation.get.queryOptions({ orgId }));
  const canEdit = hasStaffRole(me.data?.roles ?? [], 'billing');
  const [percent, setPercent] = useState('');
  const [confirm, setConfirm] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: trpc.staff.delegation.get.queryKey() });
  const end = useMutation(
    trpc.staff.delegation.end.mutationOptions({
      onSuccess: async () => {
        setConfirm(false);
        await refresh();
        toast.success('Arrangement ended.');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setDiscount = useMutation(
    trpc.staff.delegation.setDiscount.mutationOptions({
      onSuccess: async () => {
        setPercent('');
        await refresh();
        toast.success('Discount saved. It applies to subscriptions started from now on.');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (state.isPending) return <Skeleton className="h-24 w-full" />;
  const d = state.data;
  if (!d) return null;
  const arranged = d.status !== 'none';

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h2 className="text-sm font-medium">Who pays</h2>
      <p className="text-sm text-muted-foreground">
        {d.status === 'none' && 'This organisation pays Kestrel directly.'}
        {d.status === 'requested' && `Waiting for ${d.payerName ?? 'a provider'} to accept paying.`}
        {d.status === 'active' &&
          `${d.payerName ?? 'A provider'} pays for this organisation${
            d.handoverAt && d.handoverAt > new Date()
              ? `, charging from ${formatDate(d.handoverAt)}`
              : ''
          }.`}
        {d.status === 'ending' &&
          `${d.payerName ?? 'A provider'} stops paying${d.endsAt ? ` on ${formatDate(d.endsAt)}` : ''}.`}
      </p>
      {arranged && canEdit && d.status !== 'ending' && (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={end.isPending}
            onClick={() => setConfirm(true)}
          >
            {end.isPending && <Spinner />}
            {d.status === 'requested' ? 'Withdraw the request' : 'End this arrangement'}
          </Button>
          <ConfirmDialog
            open={confirm}
            onOpenChange={setConfirm}
            title="End this billing arrangement?"
            destructive
            confirmLabel="End it"
            description="Before the provider has started charging, the organisation's own subscription carries on as before. After, the provider's stops at the end of its period and the organisation is warned."
            onConfirm={() => end.mutate({ orgId })}
          />
        </>
      )}

      {d.customers.length > 0 && (
        <div className="space-y-1 text-sm">
          <div className="font-medium">Pays for {plural(d.customers.length, 'customer')}</div>
          <ul className="divide-y rounded-md border">
            {d.customers.map((c) => (
              <li key={c.orgId} className="flex justify-between gap-2 px-3 py-2">
                <span>{c.orgName}</span>
                <span className="text-muted-foreground">
                  {plural(c.rooms, 'room')}, {c.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2 border-t pt-3">
        <div className="text-sm font-medium">Provider discount</div>
        <p className="text-sm text-muted-foreground">
          {d.discountPercent
            ? `${d.discountPercent}% off every subscription this organisation pays for as a provider.`
            : 'No standing discount. A provider can still type a discount code when accepting a customer.'}{' '}
          A code and this discount do not add up: the larger one applies.
        </p>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              min={1}
              max={100}
              className="w-24"
              aria-label="Discount percent"
              placeholder="%"
              value={percent}
              onChange={(ev) => setPercent(ev.target.value)}
            />
            <Button
              size="sm"
              disabled={setDiscount.isPending || !percent.trim()}
              onClick={() => setDiscount.mutate({ orgId, percent: Number(percent) })}
            >
              {setDiscount.isPending && <Spinner />}
              Set discount
            </Button>
            {d.discountPercent !== null && (
              <Button
                size="sm"
                variant="outline"
                disabled={setDiscount.isPending}
                onClick={() => setDiscount.mutate({ orgId, percent: null })}
              >
                Clear
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
