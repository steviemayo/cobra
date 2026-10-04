'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PLAN_LABEL, hasStaffRole } from '@kestrel/model';
import { SimpleSelect } from '@/components/common/simple-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { formatDate, timeAgo } from '@/lib/format';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Licence = RouterOutputs['staff']['licence']['get'];
type Ents = Licence['effective'];

const DAY = 86_400_000;
const endOfDay = (yyyyMmDd: string) => new Date(`${yyyyMmDd}T23:59:59Z`);
const inputDate = (d: Date) => d.toISOString().slice(0, 10);

const PLAN_OPTIONS = [
  { value: '', label: 'No change' },
  { value: 'trial', label: 'Trial' },
  { value: 'basic', label: 'Essentials' },
  { value: 'pro', label: 'Premium' },
];
const MONITORING_OPTIONS = [
  { value: '', label: 'No change' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];
const ROOMS_OPTIONS = [
  { value: '', label: 'No change' },
  { value: 'limit', label: 'Set a limit' },
  { value: 'none', label: 'No limit' },
];

function Summary({ title, e, extra }: { title: string; e: Ents; extra?: React.ReactNode }) {
  return (
    <div className="space-y-1 rounded-lg border p-3 text-sm">
      <div className="text-xs text-muted-foreground">{title}</div>
      <div className="text-lg font-medium">{PLAN_LABEL[e.plan]}</div>
      <div className="text-muted-foreground">
        Monitoring {e.monitoring ? 'on' : 'off'} ·{' '}
        {e.maxRooms === null ? 'no room limit' : `up to ${e.maxRooms} rooms`}
        {e.trialDaysLeft ? ` · ${e.trialDaysLeft}d of trial left` : ''}
      </div>
      {extra}
    </div>
  );
}

/**
 * Licence and trial control for one organisation. Anyone on staff can read it; changing it needs
 * the billing role (or admin), and every change needs a reason.
 */
export function LicencePanel({ orgId }: { orgId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const me = useQuery(trpc.staff.me.queryOptions());
  const licence = useQuery(trpc.staff.licence.get.queryOptions({ orgId }));
  const canEdit = hasStaffRole(me.data?.roles ?? [], 'billing');

  const [plan, setPlan] = useState('');
  const [trialEnd, setTrialEnd] = useState('');
  const [rooms, setRooms] = useState('');
  const [limit, setLimit] = useState('10');
  const [monitoring, setMonitoring] = useState('');
  const [ends, setEnds] = useState('');
  const [reason, setReason] = useState('');

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.staff.licence.get.queryKey({ orgId }) }),
      qc.invalidateQueries({ queryKey: trpc.staff.orgs.get.queryKey({ orgId }) }),
      qc.invalidateQueries({ queryKey: trpc.staff.orgs.list.queryKey() }),
    ]);
  const set = useMutation(
    trpc.staff.licence.set.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Licence adjusted');
        setPlan('');
        setTrialEnd('');
        setRooms('');
        setMonitoring('');
        setEnds('');
        setReason('');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const revoke = useMutation(
    trpc.staff.licence.revoke.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Adjustment removed');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (licence.isPending) return <Skeleton className="h-40 w-full" />;
  if (!licence.data) return null;
  const l = licence.data;
  const active = l.overrides.find((o) => o.active);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    set.mutate({
      orgId,
      plan: (plan || null) as 'trial' | 'basic' | 'pro' | null,
      trialEndsAt: trialEnd ? endOfDay(trialEnd) : null,
      maxRooms: rooms === 'limit' ? Number(limit) : null,
      unlimitedRooms: rooms === 'none',
      monitoring: monitoring === '' ? null : monitoring === 'on',
      expiresAt: ends ? endOfDay(ends) : null,
      reason,
    });
  };

  // Quick fills for the two things staff do most.
  const extendTrial = () => {
    const from = Math.max(Date.now(), l.billing.trialEndsAt?.getTime() ?? 0);
    setPlan('');
    setTrialEnd(inputDate(new Date(from + 14 * DAY)));
    setReason((r) => r || 'Extended the trial by 14 days');
  };
  const compPremium = () => {
    setPlan('pro');
    setTrialEnd('');
    setEnds(inputDate(new Date(Date.now() + 30 * DAY)));
    setReason((r) => r || 'Premium for 30 days');
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Licence and trial</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Summary
          title="What it pays for"
          e={l.base}
          extra={
            <div className="text-xs text-muted-foreground">
              Stripe status: {l.billing.status}
              {l.billing.managedByStripe ? '' : ' (no subscription)'}
              {l.billing.trialEndsAt ? ` · trial end ${formatDate(l.billing.trialEndsAt)}` : ''}
            </div>
          }
        />
        <Summary
          title={active ? 'What it may do now (adjusted)' : 'What it may do now'}
          e={l.effective}
        />
      </div>

      {active && (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-warning/50 p-3 text-sm">
          <div className="space-y-0.5">
            <div className="font-medium">Adjusted by Kestrel staff</div>
            <div className="text-muted-foreground">
              {[
                active.plan && `plan ${active.plan}`,
                active.trialEndsAt && `trial end ${formatDate(active.trialEndsAt)}`,
                active.unlimitedRooms
                  ? 'no room limit'
                  : active.maxRooms !== null && `up to ${active.maxRooms} rooms`,
                active.monitoring !== null && `monitoring ${active.monitoring ? 'on' : 'off'}`,
                active.expiresAt ? `ends ${formatDate(active.expiresAt)}` : 'no end date',
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
            <div className="text-xs text-muted-foreground">
              Reason: {active.reason} · {active.setBy ?? 'staff'} {timeAgo(active.createdAt)}
            </div>
          </div>
          {canEdit && (
            <Button
              size="sm"
              variant="outline"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate({ orgId, overrideId: active.id })}
            >
              Remove adjustment
            </Button>
          )}
        </div>
      )}

      {canEdit ? (
        <form onSubmit={submit} className="space-y-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">Adjust the licence</div>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={extendTrial}>
                Extend trial 14 days
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={compPremium}>
                Premium for 30 days
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Changes replace any earlier adjustment. The organisation sees what changed, not why.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="lic-plan">Plan</Label>
              <SimpleSelect
                id="lic-plan"
                className="w-full"
                value={plan}
                onValueChange={setPlan}
                options={PLAN_OPTIONS}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lic-trial">Trial ends</Label>
              <Input
                id="lic-trial"
                type="date"
                value={trialEnd}
                disabled={plan === 'basic' || plan === 'pro'}
                onChange={(e) => setTrialEnd(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lic-monitoring">Monitoring</Label>
              <SimpleSelect
                id="lic-monitoring"
                className="w-full"
                value={monitoring}
                onValueChange={setMonitoring}
                options={MONITORING_OPTIONS}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lic-rooms">Room limit</Label>
              <SimpleSelect
                id="lic-rooms"
                className="w-full"
                value={rooms}
                onValueChange={setRooms}
                options={ROOMS_OPTIONS}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lic-limit">Up to (rooms)</Label>
              <Input
                id="lic-limit"
                type="number"
                min={1}
                max={1000}
                value={limit}
                disabled={rooms !== 'limit'}
                onChange={(e) => setLimit(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lic-ends">Adjustment ends</Label>
              <Input
                id="lic-ends"
                type="date"
                value={ends}
                onChange={(e) => setEnds(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lic-reason">Reason (required, internal)</Label>
            <Textarea
              id="lic-reason"
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={set.isPending || reason.trim().length < 5}>
            {set.isPending && <Spinner />} Apply
          </Button>
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">Changing a licence needs the billing role.</p>
      )}

      {l.overrides.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            History ({l.overrides.length})
          </summary>
          <ul className="mt-2 divide-y rounded-lg border">
            {l.overrides.map((o) => (
              <li key={o.id} className="space-y-0.5 px-3 py-2">
                <div>
                  {[
                    o.plan && `plan ${o.plan}`,
                    o.trialEndsAt && `trial end ${formatDate(o.trialEndsAt)}`,
                    o.unlimitedRooms
                      ? 'no room limit'
                      : o.maxRooms !== null && `up to ${o.maxRooms} rooms`,
                    o.monitoring !== null && `monitoring ${o.monitoring ? 'on' : 'off'}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}{' '}
                  <span className="text-xs text-muted-foreground">
                    {o.active ? '(active)' : o.revokedAt ? '(removed)' : '(ended)'}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {o.reason} · {o.setBy ?? 'staff'} {timeAgo(o.createdAt)}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
