'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ClipboardCheck, Download, FileCheck2 } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/common/empty-state';
import { dateTime } from '@/components/common/health';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { Section } from '@/components/common/section';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { downloadFile } from '@/lib/download';
import { plural } from '@/lib/format';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';
import { PmExportMenu } from './pm-export-menu';

type Visit = RouterOutputs['pm']['runs'][number];

/** The badge for how a visit or room turned out. */
function Outcome({ status, failed }: { status: string; failed: number }) {
  if (status === 'draft') return <Badge variant="secondary">Draft</Badge>;
  if (status === 'skipped') return <Badge variant="outline">Skipped</Badge>;
  return failed ? <Badge variant="destructive">{failed} failed</Badge> : <Badge>Passed</Badge>;
}

/** One visit. A visit to several rooms is one record that opens to show each room as a segment. */
function VisitRow({ v, compact }: { v: Visit; compact?: boolean }) {
  const { orgId } = useOrg();
  const [open, setOpen] = useState(false);
  const skipped = v.segments.filter((s) => s.status === 'skipped').length;
  const href = orgPath(orgId, `/pm/runs/${v.parentRunId ?? v.id}`);
  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href={href} className="text-sm font-medium hover:underline">
            {v.templateName}
          </Link>
          <div className="text-xs text-muted-foreground">
            {v.multi ? (
              <>
                {v.scopeLabel} · {plural(v.segments.length, 'room')}
                {skipped > 0 && ` (${skipped} skipped)`} ·{' '}
              </>
            ) : (
              !compact && (v.roomName ?? v.deviceName) && `${v.roomName ?? v.deviceName} · `
            )}
            {v.parentRunId && `part of ${v.parentLabel ?? 'a multi-room visit'} · `}
            {v.status === 'signed'
              ? `signed by ${v.signedByName} ${v.signedAt ? dateTime(v.signedAt) : ''}`
              : `draft started ${dateTime(v.createdAt)}`}
          </div>
        </div>
        <span className="flex items-center gap-2">
          {v.correctsRunId && <Badge variant="outline">Correction</Badge>}
          <Outcome status={v.status} failed={v.failedCount} />
          {v.multi && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={open ? 'Hide the rooms' : 'Show the rooms'}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              <ChevronDown className={open ? 'rotate-180' : undefined} />
            </Button>
          )}
        </span>
      </div>
      {v.multi && open && (
        <ul className="mt-2 divide-y rounded-md border text-xs">
          {v.segments.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5"
            >
              <span>
                {[s.roomName, s.deviceName].filter(Boolean).join(' · ')}
                {s.skipReason && (
                  <span className="text-muted-foreground"> — skipped: {s.skipReason}</span>
                )}
                {s.workedByName && s.status !== 'skipped' && (
                  <span className="text-muted-foreground"> — {s.workedByName}</span>
                )}
              </span>
              <Outcome status={s.status} failed={s.failedCount} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Visits, for a room or a device: the record kept next to the equipment. */
export function PmRuns({
  roomId,
  deviceId,
  compact,
}: {
  roomId?: string;
  deviceId?: string;
  compact?: boolean;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const runs = useQuery(
    trpc.pm.runs.queryOptions({ orgId, roomId, deviceId, limit: compact ? 10 : 200 }),
  );
  if (runs.isPending) return <Skeleton className="h-16 w-full" />;
  if (runs.isError) return <p className="text-sm text-destructive">{runs.error.message}</p>;
  if (runs.data.length === 0)
    return <p className="text-sm text-muted-foreground">No visits recorded yet.</p>;
  return (
    <ul className="divide-y rounded-lg border">
      {runs.data.map((r) => (
        <VisitRow key={r.id} v={r} compact={compact} />
      ))}
    </ul>
  );
}

/** Visits under their site, sites in name order, visits without one last. */
function groupBySite(visits: Visit[]) {
  const by = new Map<string, { key: string; name: string; visits: Visit[] }>();
  for (const v of visits) {
    const key = v.siteId ?? '';
    const g = by.get(key) ?? { key, name: v.siteName ?? 'No site', visits: [] };
    g.visits.push(v);
    by.set(key, g);
  }
  return [...by.values()].sort(
    (a, b) => (a.key === '' ? 1 : 0) - (b.key === '' ? 1 : 0) || a.name.localeCompare(b.name),
  );
}

/** Every visit across the organisation, with a signed report for a period. */
export function PmRecordsView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const [failedOnly, setFailedOnly] = useState(false);
  const [status, setStatus] = useState<'' | 'signed' | 'draft'>('');
  const [bySite, setBySite] = useState(false);
  const runs = useQuery(
    trpc.pm.runs.queryOptions({ orgId, failedOnly, ...(status ? { status } : {}), limit: 500 }),
  );
  const reports = useQuery(trpc.register.issues.queryOptions({ orgId, kind: 'pm_report' }));
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const [from, setFrom] = useState(yearStart);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const report = useMutation(
    trpc.pm.issueReport.mutationOptions({
      onSuccess: async (r) => {
        toast.success(`Report M${r.number} issued`);
        await qc.invalidateQueries({ queryKey: trpc.register.issues.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  async function downloadReport(issueId: string, number: number) {
    try {
      const data = await qc.fetchQuery(trpc.register.issue.queryOptions({ orgId, issueId }));
      downloadFile({
        filename: `maintenance-report-M${number}.json`,
        contentType: 'application/json',
        body: JSON.stringify(data.document, null, 2),
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not download');
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="PM records"
        description="Every maintenance visit, kept as a permanent record. Signed visits cannot be edited."
        actions={
          <PmExportMenu
            filter={{ failedOnly, ...(status ? { status } : {}) }}
            name="maintenance-records"
            title="Maintenance records"
            subtitle={`${failedOnly ? 'Visits with failures' : 'All visits'}${status ? `, ${status} only` : ''} · ${new Date().toLocaleDateString('en-AU')}`}
            disabled={(runs.data ?? []).length === 0}
          />
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <SimpleSelect
          size="sm"
          className="w-36"
          value={status || '__all'}
          onValueChange={(v) => setStatus(v === '__all' ? '' : (v as 'signed' | 'draft'))}
          options={[
            { value: '__all', label: 'Any status' },
            { value: 'signed', label: 'Signed' },
            { value: 'draft', label: 'Drafts' },
          ]}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={failedOnly}
            onChange={(e) => setFailedOnly(e.target.checked)}
          />{' '}
          Only visits with failures
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={bySite} onChange={(e) => setBySite(e.target.checked)} />{' '}
          Group by site
        </label>
      </div>
      {runs.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : runs.data && runs.data.length > 0 ? (
        bySite ? (
          <div className="space-y-4">
            {groupBySite(runs.data).map((g) => (
              <section key={g.key} className="space-y-1.5">
                <h2 className="text-sm font-medium">
                  {g.name}{' '}
                  <span className="text-xs font-normal text-muted-foreground">
                    {plural(g.visits.length, 'visit')}
                  </span>
                </h2>
                <ul className="divide-y rounded-lg border">
                  {g.visits.map((r) => (
                    <VisitRow key={r.id} v={r} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {runs.data.map((r) => (
              <VisitRow key={r.id} v={r} />
            ))}
          </ul>
        )
      ) : (
        <EmptyState
          icon={ClipboardCheck}
          title="No visits yet"
          description="Start a visit from the Schedule page."
        />
      )}

      <Section title="Signed reports">
        <div className="space-y-3 p-4">
          {canSupport && (
            <div className="flex flex-wrap items-end gap-2 text-sm">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">From</div>
                <Input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">To</div>
                <Input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="h-8"
                />
              </div>
              <Button
                size="sm"
                disabled={report.isPending}
                onClick={() => report.mutate({ orgId, from: new Date(from), to: new Date(to) })}
              >
                <FileCheck2 data-icon="inline-start" /> Issue signed report
              </Button>
            </div>
          )}
          {(reports.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No reports yet. A report is a signed copy of the visits in a period. Check one at
              /verify.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {reports.data!.map((i) => (
                <li key={i.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span>
                    {i.title}{' '}
                    <span className="text-xs text-muted-foreground">{dateTime(i.takenAt)}</span>
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void downloadReport(i.id, i.number)}
                  >
                    <Download data-icon="inline-start" /> Signed JSON
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>
    </PageContainer>
  );
}
