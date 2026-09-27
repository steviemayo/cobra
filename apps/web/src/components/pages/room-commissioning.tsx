'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCheck, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Run = RouterOutputs['commissioning']['get'];
type Item = Run['items'][number];
type Result = Item['result'];

const RESULT_TONE: Record<Result, string> = {
  pending: '',
  pass: 'border-success bg-success/10 text-success',
  fail: 'border-destructive bg-destructive/10 text-destructive',
  skip: 'border-muted-foreground/40 bg-muted text-muted-foreground',
};
const LABEL: Record<Exclude<Result, 'pending'>, string> = { pass: 'Works', fail: 'Problem', skip: 'Skip' };

/** Walking through a room to check it works, item by item, and signing it off. Made for a phone. */
export function RoomCommissioning({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const runs = useQuery(trpc.commissioning.list.queryOptions({ orgId, roomId }));
  const [openId, setOpenId] = useState<string | null>(null);
  const underway = runs.data?.find((r) => r.status === 'in_progress');
  const activeId = openId ?? underway?.id ?? null;

  const start = useMutation(
    trpc.commissioning.start.mutationOptions({
      onSuccess: async (r) => {
        await qc.invalidateQueries({ queryKey: trpc.commissioning.list.queryKey() });
        setOpenId(r.id);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <PageContainer className="max-w-3xl pt-5">
      {runs.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : activeId ? (
        <RunView roomId={roomId} runId={activeId} onBack={() => setOpenId(null)} canWork={canSupport} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-medium">Commissioning</h2>
              <p className="text-sm text-muted-foreground">
                Walk through the room and check each part works. The list is made from the room’s design, and a signed-off check is kept as a record.
              </p>
            </div>
            {canSupport && (
              <Button disabled={start.isPending} onClick={() => start.mutate({ orgId, roomId })}>
                {start.isPending && <Spinner />}
                Start a check
              </Button>
            )}
          </div>
          {runs.data?.length === 0 ? (
            <EmptyState icon={ClipboardCheck} title="No checks yet" description="Start a check when the room is installed, or after a big change." />
          ) : (
            <ul className="divide-y rounded-lg border">
              {runs.data?.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setOpenId(r.id)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm hover:bg-muted/40">
                    <span>
                      <span className="font-medium">{formatDate(r.startedAt)}</span>
                      {r.releaseNumber !== null && <span className="text-muted-foreground"> · release {r.releaseNumber}</span>}
                      <span className="block text-xs text-muted-foreground">{r.startedByEmail ?? 'Someone'}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {r.status === 'signed_off'
                        ? `Signed off · ${r.progress.pass} works, ${r.progress.fail} problems`
                        : `${r.progress.total - r.progress.pending} of ${r.progress.total} done`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PageContainer>
  );
}

function RunView({ roomId, runId, onBack, canWork }: { roomId: string; runId: string; onBack: () => void; canWork: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const run = useQuery(trpc.commissioning.get.queryOptions({ orgId, roomId, runId }));
  const [notes, setNotes] = useState('');
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.commissioning.get.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.commissioning.list.queryKey() }),
    ]);
  const set = useMutation(trpc.commissioning.setResult.mutationOptions({ onSuccess: refresh, onError: (e) => toast.error(e.message) }));
  const sign = useMutation(
    trpc.commissioning.signOff.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Signed off');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const groups = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const i of run.data?.items ?? []) map.set(i.group, [...(map.get(i.group) ?? []), i]);
    return [...map];
  }, [run.data]);

  if (run.isPending) return <Skeleton className="h-64 w-full" />;
  if (run.isError) return <p className="text-sm text-destructive">{run.error.message}</p>;
  const r = run.data;
  const done = r.status === 'signed_off';
  const p = r.progress;
  const editable = canWork && !done;

  return (
    <div className="space-y-5">
      <style>{`@media print { [data-slot="sidebar-wrapper"] > [data-slot="sidebar"], [data-slot="sidebar-gap"], [data-slot="sidebar-container"], header.sticky, nav { display: none !important; } }`}</style>
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← All checks
        </Button>
        <div className="flex gap-2">
          <Link href={orgPath(orgId, `/rooms/${roomId}/control`)} className="text-sm underline-offset-4 hover:underline self-center">
            Open room control
          </Link>
          {done && (
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer /> Print or save as PDF
            </Button>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-base font-medium">
          {r.roomName}: commissioning check {done ? '(signed off)' : ''}
        </h2>
        <p className="text-sm text-muted-foreground">
          Started {formatDate(r.startedAt)} by {r.startedByEmail ?? 'someone'}
          {r.releaseNumber !== null && ` · release ${r.releaseNumber}`}
        </p>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.total - p.pending}>
          <div className="h-full bg-primary" style={{ width: `${((p.total - p.pending) / Math.max(1, p.total)) * 100}%` }} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {p.total - p.pending} of {p.total} done · {p.pass} work · {p.fail} with a problem · {p.skip} skipped
        </p>
      </div>

      {groups.map(([group, items]) => (
        <section key={group} className="break-inside-avoid overflow-hidden rounded-lg border">
          <h3 className="border-b bg-muted/40 px-4 py-2 text-sm font-medium">{group}</h3>
          <ul className="divide-y">
            {items.map((i) => (
              <ItemRow
                key={i.id}
                item={i}
                editable={editable}
                busy={set.isPending && set.variables?.itemId === i.id}
                onSet={(result, note) => set.mutate({ orgId, roomId, runId, itemId: i.id, result, note })}
              />
            ))}
          </ul>
        </section>
      ))}

      {done ? (
        <section className="space-y-1 rounded-lg border bg-success/5 p-4 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="size-4 text-success" /> Signed off by {r.signedOffByEmail ?? 'someone'}
            {r.signedOffAt && ` on ${formatDate(r.signedOffAt)}`}
          </p>
          {r.notes && <p className="text-muted-foreground">{r.notes}</p>}
        </section>
      ) : editable ? (
        <section className="space-y-3 rounded-lg border p-4 print:hidden">
          <h3 className="text-sm font-medium">Sign off</h3>
          <Textarea placeholder="Anything to add (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          <Button disabled={p.pending > 0 || sign.isPending} onClick={() => sign.mutate({ orgId, roomId, runId, notes: notes || undefined })}>
            {sign.isPending && <Spinner />}
            {p.pending > 0 ? `${p.pending} to go` : 'Sign off this check'}
          </Button>
        </section>
      ) : null}
    </div>
  );
}

function ItemRow({
  item,
  editable,
  busy,
  onSet,
}: {
  item: Item;
  editable: boolean;
  busy: boolean;
  onSet: (result: Result, note?: string) => void;
}) {
  const [note, setNote] = useState(item.note ?? '');
  return (
    <li className="space-y-2 px-4 py-3">
      <div>
        <p className="text-sm font-medium">{item.label}</p>
        {item.hint && <p className="text-xs text-muted-foreground">{item.hint}</p>}
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={`Result for ${item.label}`}>
        {(['pass', 'fail', 'skip'] as const).map((r) => (
          <button
            key={r}
            type="button"
            disabled={!editable || busy}
            aria-pressed={item.result === r}
            // Tapping the chosen answer again clears it.
            onClick={() => onSet(item.result === r ? 'pending' : r, r === 'fail' ? note : undefined)}
            className={cn(
              'min-h-10 rounded-md border px-4 text-sm disabled:cursor-default',
              item.result === r ? RESULT_TONE[r] : 'text-muted-foreground hover:bg-muted disabled:hover:bg-transparent',
              !editable && item.result !== r && 'hidden print:hidden',
            )}
          >
            {LABEL[r]}
          </button>
        ))}
      </div>
      {item.result === 'fail' &&
        (editable ? (
          <Textarea
            aria-label={`What was wrong with ${item.label}`}
            placeholder="What was wrong?"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note.trim() !== (item.note ?? '') && onSet('fail', note)}
            className="min-h-16"
          />
        ) : (
          item.note && <p className="text-sm text-destructive">{item.note}</p>
        ))}
    </li>
  );
}
