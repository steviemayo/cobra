'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Download, FileCheck2 } from 'lucide-react';
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
import { useTRPC } from '@/trpc/client';

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

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
        <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
          <div>
            <Link
              href={orgPath(orgId, `/pm/runs/${r.id}`)}
              className="text-sm font-medium hover:underline"
            >
              {r.templateName}
            </Link>
            <div className="text-xs text-muted-foreground">
              {!compact && `${r.roomName ?? r.deviceName ?? ''} · `}
              {r.status === 'signed'
                ? `signed by ${r.signedByName} ${r.signedAt ? dateTime(r.signedAt) : ''}`
                : `draft started ${dateTime(r.createdAt)}`}
            </div>
          </div>
          <span className="flex items-center gap-2">
            {r.status === 'draft' && <Badge variant="secondary">Draft</Badge>}
            {r.status === 'signed' &&
              (r.failedCount ? (
                <Badge variant="destructive">{r.failedCount} failed</Badge>
              ) : (
                <Badge>Passed</Badge>
              ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Every visit across the organisation, with a signed report for a period. */
export function PmRecordsView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const [failedOnly, setFailedOnly] = useState(false);
  const [status, setStatus] = useState<'' | 'signed' | 'draft'>('');
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

  function exportCsv() {
    const rows = runs.data ?? [];
    const head = [
      'Checklist',
      'Room',
      'Device',
      'Status',
      'Failed items',
      'Signed by',
      'Signed at',
      'Due',
    ];
    downloadFile({
      filename: `maintenance-records-${new Date().toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv',
      body: [
        head.join(','),
        ...rows.map((r) =>
          [
            r.templateName,
            r.roomName,
            r.deviceName,
            r.status,
            r.failedCount,
            r.signedByName,
            r.signedAt ? new Date(r.signedAt).toISOString() : '',
            r.dueOn ? new Date(r.dueOn).toISOString().slice(0, 10) : '',
          ]
            .map(csvCell)
            .join(','),
        ),
      ].join('\r\n'),
    });
  }

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
          <Button
            size="sm"
            variant="outline"
            onClick={exportCsv}
            disabled={(runs.data ?? []).length === 0}
          >
            <Download data-icon="inline-start" /> Export CSV
          </Button>
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
      </div>
      {runs.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : runs.data && runs.data.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {runs.data.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
            >
              <div>
                <Link
                  href={orgPath(orgId, `/pm/runs/${r.id}`)}
                  className="text-sm font-medium hover:underline"
                >
                  {r.templateName}
                </Link>
                <div className="text-xs text-muted-foreground">
                  {r.roomName ?? r.deviceName} ·{' '}
                  {r.status === 'signed'
                    ? `signed by ${r.signedByName} ${r.signedAt ? dateTime(r.signedAt) : ''}`
                    : `draft ${dateTime(r.createdAt)}`}
                </div>
              </div>
              {r.status === 'draft' ? (
                <Badge variant="secondary">Draft</Badge>
              ) : r.failedCount ? (
                <Badge variant="destructive">{r.failedCount} failed</Badge>
              ) : (
                <Badge>Passed</Badge>
              )}
            </li>
          ))}
        </ul>
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
