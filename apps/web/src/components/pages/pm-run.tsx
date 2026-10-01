'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { itemFailed, type PmItem, type PmResult } from '@kestrel/model';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { Section } from '@/components/common/section';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { dateTime } from '@/components/common/health';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

const CHOICES: { value: 'pass' | 'fail' | 'na'; label: string }[] = [
  { value: 'pass', label: 'Pass' },
  { value: 'fail', label: 'Fail' },
  { value: 'na', label: 'N/A' },
];

/** One maintenance visit: the checklist, the answers monitoring already gave, and the sign-off. */
export function PmRunView({ runId }: { runId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const { orgId, canSupport } = useOrg();
  const run = useQuery(trpc.pm.run.queryOptions({ orgId, runId }));
  const [results, setResults] = useState<PmResult[] | null>(null);
  const [notes, setNotes] = useState('');
  const [name, setName] = useState('');
  const [raiseTicket, setRaiseTicket] = useState(true);
  const [markInRepair, setMarkInRepair] = useState(false);
  useEffect(() => {
    if (run.data && results === null) {
      setResults(run.data.results);
      setNotes(run.data.notes ?? '');
    }
  }, [run.data, results]);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.pm.run.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.pm.runs.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.pm.schedules.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.monitoring.estate.queryKey() }),
    ]);
  const save = useMutation(
    trpc.pm.saveRun.mutationOptions({ onError: (e) => toast.error(e.message) }),
  );
  const sign = useMutation(
    trpc.pm.signRun.mutationOptions({
      onSuccess: async (r) => {
        toast.success(
          r.failed
            ? `Signed off with ${r.failed} failed. ${r.ticketId ? 'A ticket was raised.' : ''}`
            : 'Signed off',
        );
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const discard = useMutation(
    trpc.pm.discardRun.mutationOptions({
      onSuccess: async () => {
        toast.success('Visit discarded');
        await refresh();
        router.push(orgPath(orgId, '/pm/schedule'));
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (run.isPending || results === null)
    return (
      <PageContainer>
        <Skeleton className="h-40 w-full" />
      </PageContainer>
    );
  if (run.isError)
    return (
      <PageContainer>
        <p className="text-sm text-destructive">{run.error.message}</p>
      </PageContainer>
    );
  const r = run.data;
  const signed = r.status === 'signed';
  const by = new Map(results.map((x) => [x.itemId, x]));
  const set = (item: PmItem, patch: Partial<PmResult>) =>
    setResults(results.map((x) => (x.itemId === item.id ? { ...x, ...patch } : x)));
  const failedNow = r.items.filter((i) => itemFailed(i, by.get(i.id)?.result ?? null)).length;
  const persist = () => save.mutateAsync({ orgId, runId, results, notes });

  return (
    <PageContainer>
      <PageHeader
        title={r.templateName}
        description={`${r.roomName ?? r.deviceName ?? ''}${r.deviceName && r.roomName ? ` · ${r.deviceName}` : ''}${r.dueOn ? ` · due ${new Date(r.dueOn).toLocaleDateString('en-AU')}` : ''}`}
        actions={signed ? <Badge>Signed off</Badge> : <Badge variant="secondary">Draft</Badge>}
      />
      <Section title="Checklist">
        <ul className="divide-y">
          {r.items.map((item) => {
            const a = by.get(item.id);
            const bad = itemFailed(item, a?.result ?? null);
            return (
              <li key={item.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium">
                    {item.label}
                    {bad && <span className="ml-2 text-xs text-destructive">Failed</span>}
                  </div>
                  {item.type === 'passfail' && (
                    <div className="flex gap-1" role="radiogroup" aria-label={item.label}>
                      {CHOICES.map((c) => (
                        <button
                          key={c.value}
                          type="button"
                          role="radio"
                          aria-checked={a?.result === c.value}
                          disabled={signed || !canSupport}
                          onClick={() => set(item, { result: c.value })}
                          className={cn(
                            'rounded-md border px-3 py-1 text-xs transition-colors',
                            a?.result === c.value
                              ? c.value === 'fail'
                                ? 'border-destructive bg-destructive/10 text-destructive'
                                : c.value === 'pass'
                                  ? 'border-success bg-success/10 text-success'
                                  : 'bg-muted'
                              : 'hover:bg-muted/50',
                          )}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {item.type === 'number' && (
                    <span className="flex items-center gap-2 text-sm">
                      <Input
                        type="number"
                        className="h-8 w-28"
                        disabled={signed || !canSupport}
                        value={typeof a?.result === 'number' ? a.result : ''}
                        onChange={(e) =>
                          set(item, {
                            result: e.target.value === '' ? null : Number(e.target.value),
                          })
                        }
                        aria-label={item.label}
                      />
                      {item.unit && (
                        <span className="text-xs text-muted-foreground">{item.unit}</span>
                      )}
                      {(item.min !== undefined || item.max !== undefined) && (
                        <span className="text-xs text-muted-foreground">
                          ({item.min ?? '…'} to {item.max ?? '…'})
                        </span>
                      )}
                    </span>
                  )}
                </div>
                {item.type === 'text' && (
                  <Textarea
                    rows={2}
                    disabled={signed || !canSupport}
                    value={typeof a?.result === 'string' ? a.result : ''}
                    onChange={(e) => set(item, { result: e.target.value || null })}
                    maxLength={2000}
                    aria-label={item.label}
                  />
                )}
                {item.type === 'photo' && (
                  <p className="text-xs text-muted-foreground">
                    Photos are not stored yet. Describe what you saw in the note.
                  </p>
                )}
                {a?.auto && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Sparkles className="size-3" /> Kestrel saw: {a.auto.value} (
                    {dateTime(a.auto.at)})
                  </p>
                )}
                {item.type !== 'text' && (
                  <Input
                    className="h-8 text-xs"
                    placeholder="Note (optional)"
                    disabled={signed || !canSupport}
                    value={a?.note ?? ''}
                    onChange={(e) => set(item, { note: e.target.value || undefined })}
                    maxLength={500}
                    aria-label={`Note for ${item.label}`}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      <div className="space-y-1.5">
        <Label className="text-xs">Notes on the visit</Label>
        <Textarea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={signed || !canSupport}
          maxLength={4000}
        />
      </div>

      {signed ? (
        <div className="flex items-start gap-3 rounded-lg border p-4 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
          <div>
            Signed off by <span className="font-medium">{r.signedByName}</span>
            {r.signedAt ? ` on ${dateTime(r.signedAt)}` : ''}.{' '}
            {r.failedCount
              ? `${r.failedCount} item${r.failedCount === 1 ? '' : 's'} failed.`
              : 'Everything passed.'}{' '}
            This record cannot be changed. To correct it, start a new visit.
            <div className="mt-2">
              <Link
                href={orgPath(orgId, '/pm/records')}
                className="text-muted-foreground hover:underline"
              >
                All maintenance records
              </Link>
            </div>
          </div>
        </div>
      ) : canSupport ? (
        <Section title="Sign off">
          <div className="space-y-3 p-4">
            {failedNow > 0 && (
              <div className="space-y-2 rounded-md border border-warning/50 bg-warning/5 p-3 text-sm">
                <div>
                  {failedNow} item{failedNow === 1 ? '' : 's'} failed.
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={raiseTicket} onCheckedChange={(c) => setRaiseTicket(!!c)} />{' '}
                  Raise a ticket for the failed items
                </label>
                {r.deviceId && (
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={markInRepair}
                      onCheckedChange={(c) => setMarkInRepair(!!c)}
                    />{' '}
                    Mark the device as in repair
                  </label>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Type your name to sign off</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-8 w-64"
                  maxLength={100}
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={save.isPending}
                onClick={() => void persist().then(() => toast.success('Saved'))}
              >
                Save draft
              </Button>
              <Button
                size="sm"
                disabled={!name.trim() || sign.isPending || save.isPending}
                onClick={async () => {
                  await persist();
                  sign.mutate({ orgId, runId, name: name.trim(), raiseTicket, markInRepair });
                }}
              >
                Sign off
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={discard.isPending}
                onClick={() => discard.mutate({ orgId, runId })}
              >
                Discard
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Once signed off, a visit is a permanent record and cannot be edited.
            </p>
          </div>
        </Section>
      ) : null}
    </PageContainer>
  );
}
