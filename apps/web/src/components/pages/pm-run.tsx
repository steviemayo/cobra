'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, CheckCircle2, ChevronDown, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { itemFailed, unanswered, type PmItem, type PmResult } from '@kestrel/model';
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
import { plural } from '@/lib/format';
import { shrinkImage } from '@/lib/shrink-image';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';
import { PmExportMenu } from './pm-export-menu';

type Run = RouterOutputs['pm']['run'];

const CHOICES: { value: 'pass' | 'fail' | 'na'; label: string }[] = [
  { value: 'pass', label: 'Pass' },
  { value: 'fail', label: 'Fail' },
  { value: 'na', label: 'N/A' },
];

/** One maintenance visit: a single room or device, or a visit to several rooms with a section for each. */
export function PmRunView({ runId }: { runId: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const { orgId } = useOrg();
  const run = useQuery(trpc.pm.run.queryOptions({ orgId, runId }));
  const parentRunId = run.data?.parentRunId ?? null;
  // One room of a visit to several rooms is opened through its visit.
  useEffect(() => {
    if (parentRunId) router.replace(orgPath(orgId, `/pm/runs/${parentRunId}`));
  }, [parentRunId, orgId, router]);
  if (run.isError)
    return (
      <PageContainer>
        <p className="text-sm text-destructive">{run.error.message}</p>
      </PageContainer>
    );
  if (run.isPending || parentRunId)
    return (
      <PageContainer>
        <Skeleton className="h-40 w-full" />
      </PageContainer>
    );
  return run.data.multi ? (
    <PmMultiRun key={runId} runId={runId} r={run.data} />
  ) : (
    <PmSingleRun key={runId} runId={runId} r={run.data} />
  );
}

/** Refreshes everything a change to a visit can alter. */
function useRefresh() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.pm.run.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.pm.runs.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.pm.schedules.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.monitoring.estate.queryKey() }),
    ]);
}

function visitTitle(r: Run) {
  return r.multi
    ? `${r.scopeLabel ?? 'Several rooms'}${r.dueOn ? ` · due ${new Date(r.dueOn).toLocaleDateString('en-AU')}` : ''}`
    : `${r.roomName ?? r.deviceName ?? ''}${r.deviceName && r.roomName ? ` · ${r.deviceName}` : ''}${r.dueOn ? ` · due ${new Date(r.dueOn).toLocaleDateString('en-AU')}` : ''}`;
}

function HeaderActions({ r, runId }: { r: Run; runId: string }) {
  return (
    <div className="flex items-center gap-2">
      {r.status === 'signed' ? <Badge>Signed off</Badge> : <Badge variant="secondary">Draft</Badge>}
      <PmExportMenu
        filter={{ runId }}
        name={`maintenance-visit-${runId.slice(0, 8)}`}
        title={r.templateName}
        subtitle={visitTitle(r)}
      />
    </div>
  );
}

/** Notices about the visit this one corrects, or the corrections made to it. */
function CorrectionNotices({ r }: { r: Run }) {
  const { orgId } = useOrg();
  const signed = r.status === 'signed';
  return (
    <>
      {r.corrects && (
        <div className="rounded-md border border-warning/50 bg-warning/5 p-3 text-sm">
          This visit corrects{' '}
          <Link
            href={orgPath(orgId, `/pm/runs/${r.corrects.id}`)}
            className="underline underline-offset-2"
          >
            an earlier one
          </Link>
          {r.corrects.signedByName ? ` signed by ${r.corrects.signedByName}` : ''}. Reason:{' '}
          {r.correctionReason}. When you sign it, it replaces that visit in reports, and both stay
          on record.
        </div>
      )}
      {signed && r.corrections.length > 0 && (
        <div className="rounded-md border p-3 text-sm">
          {r.corrections.some((c) => c.status === 'signed')
            ? 'This visit has been corrected. Reports use the correction.'
            : 'A correction to this visit is in progress.'}{' '}
          {r.corrections.map((c) => (
            <Link
              key={c.id}
              href={orgPath(orgId, `/pm/runs/${c.id}`)}
              className="mr-2 underline underline-offset-2"
            >
              {c.status === 'signed'
                ? `Correction signed${c.signedAt ? ` ${dateTime(c.signedAt)}` : ''}`
                : 'Open the draft correction'}
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

/** The questions of a checklist for one room or device, with photos and what Kestrel saw. */
function ChecklistRows({
  runId,
  items,
  results,
  onChange,
  photos,
  locked,
}: {
  runId: string;
  items: PmItem[];
  results: PmResult[];
  onChange: (itemId: string, patch: Partial<PmResult>) => void;
  photos: { id: string; itemId: string }[];
  locked: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const by = new Map(results.map((x) => [x.itemId, x]));
  const addPhoto = useMutation(
    trpc.pm.addPhoto.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.pm.run.queryKey() }),
      onError: (e) => toast.error(e.message),
    }),
  );
  const removePhoto = useMutation(
    trpc.pm.removePhoto.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.pm.run.queryKey() }),
      onError: (e) => toast.error(e.message),
    }),
  );
  const takePhoto = async (itemId: string, file: File | undefined) => {
    if (!file) return;
    try {
      const shrunk = await shrinkImage(file);
      await addPhoto.mutateAsync({ orgId, runId, itemId, ...shrunk });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add that photo');
    }
  };
  return (
    <ul className="divide-y">
      {items.map((item) => {
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
                      disabled={locked}
                      onClick={() => onChange(item.id, { result: c.value })}
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
                    disabled={locked}
                    value={typeof a?.result === 'number' ? a.result : ''}
                    onChange={(e) =>
                      onChange(item.id, {
                        result: e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                    aria-label={item.label}
                  />
                  {item.unit && <span className="text-xs text-muted-foreground">{item.unit}</span>}
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
                disabled={locked}
                value={typeof a?.result === 'string' ? a.result : ''}
                onChange={(e) => onChange(item.id, { result: e.target.value || null })}
                maxLength={2000}
                aria-label={item.label}
              />
            )}
            {item.type === 'photo' && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  {photos
                    .filter((p) => p.itemId === item.id)
                    .map((p) => (
                      <PhotoThumb
                        key={p.id}
                        runId={runId}
                        photoId={p.id}
                        onRemove={
                          locked
                            ? undefined
                            : () => removePhoto.mutate({ orgId, runId, photoId: p.id })
                        }
                      />
                    ))}
                </div>
                {!locked && (
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs hover:bg-muted/50">
                    <Camera className="size-3.5" />
                    {addPhoto.isPending ? 'Adding the photo' : 'Take or add a photo'}
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="sr-only"
                      disabled={addPhoto.isPending}
                      onChange={(ev) => {
                        void takePhoto(item.id, ev.target.files?.[0]);
                        ev.target.value = '';
                      }}
                    />
                  </label>
                )}
                {locked && !photos.some((p) => p.itemId === item.id) && (
                  <p className="text-xs text-muted-foreground">No photos were taken.</p>
                )}
              </div>
            )}
            {a?.auto && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Sparkles className="size-3" /> Kestrel saw: {a.auto.value} ({dateTime(a.auto.at)})
              </p>
            )}
            {item.type !== 'text' && (
              <Input
                className="h-8 text-xs"
                placeholder="Note (optional)"
                disabled={locked}
                value={a?.note ?? ''}
                onChange={(e) => onChange(item.id, { note: e.target.value || undefined })}
                maxLength={500}
                aria-label={`Note for ${item.label}`}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The footer of a signed visit: who signed, and how to correct it. */
function SignedPanel({ r, runId }: { r: Run; runId: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const { orgId, canSupport } = useOrg();
  const refresh = useRefresh();
  const [correcting, setCorrecting] = useState(false);
  const [reason, setReason] = useState('');
  const correct = useMutation(
    trpc.pm.correctRun.mutationOptions({
      onSuccess: async (res) => {
        toast.success(res.existing ? 'A correction is already open' : 'Correction started');
        await refresh();
        router.push(orgPath(orgId, `/pm/runs/${res.id}`));
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <div className="flex items-start gap-3 rounded-lg border p-4 text-sm">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
      <div>
        Signed off by <span className="font-medium">{r.signedByName}</span>
        {r.signedAt ? ` on ${dateTime(r.signedAt)}` : ''}.{' '}
        {r.failedCount
          ? `${r.failedCount} item${r.failedCount === 1 ? '' : 's'} failed.`
          : 'Everything passed.'}{' '}
        This record cannot be changed. If something is wrong, start a correction: a new visit that
        starts from these answers and photos, and replaces this one in reports once signed.
        {canSupport && (
          <div className="mt-2">
            {correcting ? (
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Why does it need correcting?</Label>
                  <Input
                    className="h-8 w-72"
                    maxLength={500}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
                <Button
                  size="sm"
                  disabled={reason.trim().length < 5 || correct.isPending}
                  onClick={() => correct.mutate({ orgId, runId, reason: reason.trim() })}
                >
                  Start a correction
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCorrecting(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setCorrecting(true)}>
                Correct this visit
              </Button>
            )}
          </div>
        )}
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
  );
}

/** Name, ticket choices and the buttons that save, sign off or discard a draft visit. */
function SignOff({
  failedNow,
  hasDevice,
  multi,
  correction,
  saving,
  signing,
  onSave,
  onSign,
  onDiscard,
}: {
  failedNow: number;
  hasDevice: boolean;
  multi: boolean;
  correction: boolean;
  saving: boolean;
  signing: boolean;
  onSave: () => Promise<unknown>;
  onSign: (a: { name: string; raiseTicket: boolean; markInRepair: boolean }) => void;
  onDiscard: () => void;
}) {
  const [name, setName] = useState('');
  // The visit being corrected may already have raised a ticket, so a correction does not by default.
  const [raiseTicket, setRaiseTicket] = useState(!correction);
  const [markInRepair, setMarkInRepair] = useState(false);
  return (
    <Section title="Sign off">
      <div className="space-y-3 p-4">
        {failedNow > 0 && (
          <div className="space-y-2 rounded-md border border-warning/50 bg-warning/5 p-3 text-sm">
            <div>
              {failedNow} item{failedNow === 1 ? '' : 's'} failed.
            </div>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={raiseTicket} onCheckedChange={(c) => setRaiseTicket(!!c)} />{' '}
              {multi
                ? 'Raise a ticket for each room with failed items'
                : 'Raise a ticket for the failed items'}
            </label>
            {hasDevice && (
              <label className="flex items-center gap-2 text-xs">
                <Checkbox checked={markInRepair} onCheckedChange={(c) => setMarkInRepair(!!c)} />{' '}
                {multi ? 'Mark failed devices as in repair' : 'Mark the device as in repair'}
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
            disabled={saving}
            onClick={() => void onSave().then(() => toast.success('Saved'))}
          >
            Save draft
          </Button>
          <Button
            size="sm"
            disabled={!name.trim() || signing || saving}
            onClick={async () => {
              try {
                await onSave();
              } catch {
                return;
              }
              onSign({ name: name.trim(), raiseTicket, markInRepair });
            }}
          >
            Sign off
          </Button>
          <Button size="sm" variant="ghost" onClick={onDiscard}>
            Discard
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {multi
            ? 'One sign-off covers every room. Once signed off, the visit is a permanent record and cannot be edited.'
            : 'Once signed off, a visit is a permanent record and cannot be edited.'}
        </p>
      </div>
    </Section>
  );
}

function signedToast(r: { failed: number; tickets: number }) {
  toast.success(
    r.failed
      ? `Signed off with ${r.failed} failed. ${r.tickets ? (r.tickets === 1 ? 'A ticket was raised.' : `${r.tickets} tickets were raised.`) : ''}`
      : 'Signed off',
  );
}

/** A visit to one room or device. */
function PmSingleRun({ runId, r }: { runId: string; r: Run }) {
  const trpc = useTRPC();
  const router = useRouter();
  const { orgId, canSupport } = useOrg();
  const refresh = useRefresh();
  const [results, setResults] = useState<PmResult[]>(r.results);
  const [notes, setNotes] = useState(r.notes ?? '');
  const save = useMutation(
    trpc.pm.saveRun.mutationOptions({ onError: (e) => toast.error(e.message) }),
  );
  const sign = useMutation(
    trpc.pm.signRun.mutationOptions({
      onSuccess: async (res) => {
        signedToast(res);
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
  const signed = r.status === 'signed';
  const by = new Map(results.map((x) => [x.itemId, x]));
  const failedNow = r.items.filter((i) => itemFailed(i, by.get(i.id)?.result ?? null)).length;
  const persist = () => save.mutateAsync({ orgId, runId, results, notes });
  return (
    <PageContainer>
      <PageHeader
        title={r.templateName}
        description={visitTitle(r)}
        actions={<HeaderActions r={r} runId={runId} />}
      />
      <CorrectionNotices r={r} />
      <Section title="Checklist">
        <ChecklistRows
          runId={runId}
          items={r.items}
          results={results}
          photos={r.photos}
          locked={signed || !canSupport}
          onChange={(itemId, patch) =>
            setResults(results.map((x) => (x.itemId === itemId ? { ...x, ...patch } : x)))
          }
        />
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
        <SignedPanel r={r} runId={runId} />
      ) : canSupport ? (
        <SignOff
          failedNow={failedNow}
          hasDevice={!!r.deviceId}
          multi={false}
          correction={!!r.correctsRunId}
          saving={save.isPending}
          signing={sign.isPending}
          onSave={persist}
          onSign={(a) => sign.mutate({ orgId, runId, ...a })}
          onDiscard={() => !discard.isPending && discard.mutate({ orgId, runId })}
        />
      ) : null}
    </PageContainer>
  );
}

type Segment = Run['segments'][number];
type Answers = { results: PmResult[]; notes: string };

/** A visit to several rooms: one section for each room, one sign-off for all of them. */
function PmMultiRun({ runId, r }: { runId: string; r: Run }) {
  const trpc = useTRPC();
  const router = useRouter();
  const { orgId, canSupport } = useOrg();
  const refresh = useRefresh();
  const signed = r.status === 'signed';
  const [answers, setAnswers] = useState<Record<string, Answers>>(() =>
    Object.fromEntries(r.segments.map((s) => [s.id, { results: s.results, notes: s.notes ?? '' }])),
  );
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [skipping, setSkipping] = useState<string | null>(null);
  const [skipReason, setSkipReason] = useState('');
  const save = useMutation(
    trpc.pm.saveRun.mutationOptions({ onError: (e) => toast.error(e.message) }),
  );
  const sign = useMutation(
    trpc.pm.signRun.mutationOptions({
      onSuccess: async (res) => {
        signedToast(res);
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
  const skip = useMutation(
    trpc.pm.skipRoom.mutationOptions({
      onSuccess: async () => {
        setSkipping(null);
        setSkipReason('');
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const unskip = useMutation(
    trpc.pm.unskipRoom.mutationOptions({
      onSuccess: refresh,
      onError: (e) => toast.error(e.message),
    }),
  );

  const mine = (s: Segment): Answers =>
    answers[s.id] ?? { results: s.results, notes: s.notes ?? '' };
  const active = r.segments.filter((s) => s.status === 'draft');
  const stateOf = (s: Segment) => {
    const a = mine(s);
    const by = new Map(a.results.map((x) => [x.itemId, x]));
    return {
      missing: unanswered(r.items, a.results).length,
      failed: r.items.filter((i) => itemFailed(i, by.get(i.id)?.result ?? null)).length,
    };
  };
  const ready = r.segments.filter((s) => s.status !== 'draft' || stateOf(s).missing === 0).length;
  const failedNow = active.reduce((n, s) => n + stateOf(s).failed, 0);
  const saveRoom = (s: Segment) =>
    save.mutateAsync({ orgId, runId: s.id, results: mine(s).results, notes: mine(s).notes });
  const saveAll = async () => {
    // One at a time: each save also updates the visit's failed total.
    for (const s of active) await saveRoom(s);
  };
  const toggle = (id: string) =>
    setOpenIds((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));

  return (
    <PageContainer>
      <PageHeader
        title={r.templateName}
        description={visitTitle(r)}
        actions={<HeaderActions r={r} runId={runId} />}
      />
      <CorrectionNotices r={r} />
      <div className="rounded-md border p-3 text-sm">
        {signed
          ? `${plural(r.segments.length, 'room')} in this visit.`
          : `${ready} of ${plural(r.segments.length, 'room')} ready. Open a room to answer its checklist, or skip it with a reason. Different people can work on different rooms.`}
      </div>

      <ul className="space-y-2">
        {r.segments.map((s) => {
          const st = stateOf(s);
          const open = openIds.includes(s.id);
          const where = [s.roomName, s.deviceName].filter(Boolean).join(' · ') || 'Room';
          const locked = signed || s.status !== 'draft' || !canSupport;
          return (
            <li key={s.id} className="rounded-lg border">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggle(s.id)}
                className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left"
              >
                <span className="text-sm font-medium">
                  {where}
                  {s.workedByName && s.status !== 'skipped' && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {s.workedByName}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  {s.status === 'skipped' ? (
                    <Badge variant="outline">Skipped</Badge>
                  ) : signed ? (
                    s.failedCount ? (
                      <Badge variant="destructive">{s.failedCount} failed</Badge>
                    ) : (
                      <Badge>Passed</Badge>
                    )
                  ) : st.failed ? (
                    <Badge variant="destructive">{st.failed} failed</Badge>
                  ) : st.missing === 0 ? (
                    <Badge>Ready</Badge>
                  ) : (
                    <Badge variant="secondary">{st.missing} to answer</Badge>
                  )}
                  <ChevronDown className={cn('size-4', open && 'rotate-180')} />
                </span>
              </button>
              {open && (
                <div className="border-t">
                  {s.status === 'skipped' ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                      <span>Skipped: {s.skipReason}</span>
                      {!signed && canSupport && (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={unskip.isPending}
                          onClick={() => unskip.mutate({ orgId, runId: s.id })}
                        >
                          Bring it back
                        </Button>
                      )}
                    </div>
                  ) : (
                    <>
                      <ChecklistRows
                        runId={s.id}
                        items={r.items}
                        results={mine(s).results}
                        photos={s.photos}
                        locked={locked}
                        onChange={(itemId, patch) =>
                          setAnswers((a) => ({
                            ...a,
                            [s.id]: {
                              ...mine(s),
                              results: mine(s).results.map((x) =>
                                x.itemId === itemId ? { ...x, ...patch } : x,
                              ),
                            },
                          }))
                        }
                      />
                      <div className="space-y-2 border-t px-4 py-3">
                        <Label className="text-xs">Notes on this room</Label>
                        <Textarea
                          rows={2}
                          value={mine(s).notes}
                          disabled={locked}
                          maxLength={4000}
                          onChange={(e) =>
                            setAnswers((a) => ({
                              ...a,
                              [s.id]: { ...mine(s), notes: e.target.value },
                            }))
                          }
                        />
                        {!locked &&
                          (skipping === s.id ? (
                            <div className="flex flex-wrap items-end gap-2">
                              <div className="space-y-1.5">
                                <Label className="text-xs">Why is this room being skipped?</Label>
                                <Input
                                  className="h-8 w-72"
                                  maxLength={300}
                                  value={skipReason}
                                  onChange={(e) => setSkipReason(e.target.value)}
                                />
                              </div>
                              <Button
                                size="sm"
                                disabled={skipReason.trim().length < 3 || skip.isPending}
                                onClick={() =>
                                  skip.mutate({ orgId, runId: s.id, reason: skipReason.trim() })
                                }
                              >
                                Skip this room
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setSkipping(null)}>
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={save.isPending}
                                onClick={() =>
                                  void saveRoom(s).then(() => toast.success(`${where} saved`))
                                }
                              >
                                Save this room
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => {
                                  setSkipping(s.id);
                                  setSkipReason('');
                                }}
                              >
                                Skip this room
                              </Button>
                            </div>
                          ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {signed ? (
        <SignedPanel r={r} runId={runId} />
      ) : canSupport ? (
        <SignOff
          failedNow={failedNow}
          hasDevice={active.some((s) => s.deviceId)}
          multi
          correction={!!r.correctsRunId}
          saving={save.isPending}
          signing={sign.isPending}
          onSave={saveAll}
          onSign={(a) => sign.mutate({ orgId, runId, ...a })}
          onDiscard={() => !discard.isPending && discard.mutate({ orgId, runId })}
        />
      ) : null}
    </PageContainer>
  );
}

/** One photo of a visit, fetched when it is shown. */
function PhotoThumb({
  runId,
  photoId,
  onRemove,
}: {
  runId: string;
  photoId: string;
  onRemove?: () => void;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const photo = useQuery({
    ...trpc.pm.photo.queryOptions({ orgId, runId, photoId }),
    staleTime: Infinity,
  });
  return (
    <div className="relative size-24 overflow-hidden rounded-md border bg-muted">
      {photo.data ? (
        <img
          src={photo.data.dataUrl}
          alt="Photo taken during the visit"
          className="size-full object-cover"
        />
      ) : (
        <Skeleton className="size-full" />
      )}
      {onRemove && (
        <button
          type="button"
          aria-label="Remove photo"
          onClick={onRemove}
          className="absolute top-1 right-1 rounded-full bg-background/90 p-0.5 shadow"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
