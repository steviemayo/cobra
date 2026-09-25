'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { hasStaffRole } from '@kestrel/model';
import { AuditExportButtons } from '@/components/common/audit-export-buttons';
import { SimpleSelect } from '@/components/common/simple-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { useTRPC } from '@/trpc/client';

const OPTIONS = [12, 24, 36, 60, 84, 120].map((months) => ({
  value: String(((months * 365) / 12) | 0),
  label: months === 12 ? '12 months (default)' : `${months / 12} years`,
}));

const months = (days: number) => `${Math.round(days / 30.4)} months`;

/**
 * How long an organisation's activity log is kept, and downloading it. Staff can extend the period
 * (admin only), never shorten it below 12 months. Both changes and downloads are audited.
 */
export function RetentionPanel({ orgId }: { orgId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const me = useQuery(trpc.staff.me.queryOptions());
  const current = useQuery(trpc.staff.auditLog.retention.queryOptions({ orgId }));
  const [days, setDays] = useState('');
  const [reason, setReason] = useState('');
  const canSet = hasStaffRole(me.data?.roles ?? [], 'admin');
  const canExport = canSet || hasStaffRole(me.data?.roles ?? [], 'support');

  const set = useMutation(
    trpc.staff.auditLog.setRetention.mutationOptions({
      onSuccess: async () => {
        setReason('');
        await qc.invalidateQueries({ queryKey: trpc.staff.auditLog.retention.queryKey({ orgId }) });
        toast.success('Retention updated');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const exportLog = useMutation(trpc.staff.auditLog.export.mutationOptions());

  if (!current.data) return null;
  const chosen = days || String(current.data.days);
  const changed = Number(chosen) !== current.data.days;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Activity log retention</h2>
      <p className="text-sm text-muted-foreground">
        Kept for {months(current.data.days)}
        {current.data.custom ? ' (extended)' : ''}. Billing and access changes are kept for{' '}
        {months(current.data.longKeptDays)}. Extending is written to the organisation’s own log.
      </p>
      {canSet && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="ret-days">Keep for</Label>
            <SimpleSelect
              id="ret-days"
              value={chosen}
              onValueChange={setDays}
              options={
                OPTIONS.some((o) => o.value === String(current.data!.days))
                  ? OPTIONS
                  : [
                      ...OPTIONS,
                      { value: String(current.data.days), label: months(current.data.days) },
                    ]
              }
            />
          </div>
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="ret-reason">Reason</Label>
            <Input
              id="ret-reason"
              maxLength={300}
              placeholder="Why is this being extended?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={!changed || reason.trim().length < 3 || set.isPending}
            onClick={() => set.mutate({ orgId, days: Number(chosen), reason })}
          >
            {set.isPending && <Spinner />} Save
          </Button>
        </div>
      )}
      {canExport && (
        <div className="flex items-center gap-3 pt-1">
          <span className="text-sm text-muted-foreground">Download their activity log</span>
          <AuditExportButtons run={(format) => exportLog.mutateAsync({ orgId, format })} />
        </div>
      )}
    </section>
  );
}
