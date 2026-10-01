'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileCheck2 } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/common/empty-state';
import { dateTime } from '@/components/common/health';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { Section } from '@/components/common/section';
import { SimpleSelect } from '@/components/common/simple-select';
import { VerifyDocument } from '@/components/common/verify-document';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { downloadFile } from '@/lib/download';
import { useEstate } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';

const EVERY = [
  { value: '0', label: 'Never by itself' },
  { value: '30', label: 'Every month' },
  { value: '90', label: 'Every quarter' },
  { value: '365', label: 'Every year' },
];

/** Signed, numbered copies of the asset register, kept for the record. */
export function RegisterIssuesView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport, isOwner, role } = useOrg();
  const { sites } = useEstate();
  const issues = useQuery(trpc.register.issues.queryOptions({ orgId, kind: 'register' }));
  const schedule = useQuery(trpc.register.schedule.queryOptions({ orgId }));
  const [scope, setScope] = useState('org');
  const issue = useMutation(
    trpc.register.issue_now.mutationOptions({
      onSuccess: async (r) => {
        toast.success(`Issued as R${r.number}`);
        await qc.invalidateQueries({ queryKey: trpc.register.issues.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setSchedule = useMutation(
    trpc.register.setSchedule.mutationOptions({
      onSuccess: async () => {
        toast.success('Saved');
        await qc.invalidateQueries({ queryKey: trpc.register.schedule.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  async function download(issueId: string, as: 'json' | 'csv') {
    try {
      const data = await qc.fetchQuery(trpc.register.issue.queryOptions({ orgId, issueId }));
      if (as === 'json') {
        downloadFile({
          filename: `register-R${data.number}.json`,
          contentType: 'application/json',
          body: JSON.stringify(data.document, null, 2),
        });
      } else {
        const rows = (data.document as { payload: { rows: Record<string, string | null>[] } })
          .payload.rows;
        const head = [
          'Name',
          'Category',
          'Site',
          'Area',
          'Room',
          'Make',
          'Model',
          'Serial',
          'MAC',
          'IP',
          'Firmware',
          'Asset tag',
          'Status',
          'Warranty ends',
        ];
        const keys = [
          'name',
          'categoryLabel',
          'site',
          'area',
          'room',
          'make',
          'model',
          'serial',
          'mac',
          'ip',
          'firmware',
          'assetTag',
          'status',
          'warrantyEndsOn',
        ];
        const cell = (v: string | null | undefined) => {
          const s = v ?? '';
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        downloadFile({
          filename: `register-R${data.number}.csv`,
          contentType: 'text/csv',
          body: [head.join(','), ...rows.map((r) => keys.map((k) => cell(r[k])).join(','))].join(
            '\r\n',
          ),
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not download');
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Register issues"
        description="A register issue is a numbered, frozen copy of the asset register, signed by Kestrel so it can be kept, handed over and checked later. The signature shows the content is unchanged; values typed in by people are marked as entered."
        actions={
          canSupport && (
            <>
              <SimpleSelect
                size="sm"
                className="w-40"
                value={scope}
                onValueChange={setScope}
                options={[
                  { value: 'org', label: 'Whole organisation' },
                  ...sites.map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
              <Button
                size="sm"
                disabled={issue.isPending}
                onClick={() =>
                  issue.mutate({
                    orgId,
                    scope: scope === 'org' ? 'org' : 'site',
                    scopeId: scope === 'org' ? null : scope,
                  })
                }
              >
                <FileCheck2 data-icon="inline-start" /> Issue now
              </Button>
            </>
          )
        }
      />
      {issues.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : issues.isError ? (
        <p className="text-sm text-destructive">{issues.error.message}</p>
      ) : issues.data.length === 0 ? (
        <EmptyState
          icon={FileCheck2}
          title="Nothing issued yet"
          description="Issue the register to keep a signed record of what you have and where it is."
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {issues.data.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <Link
                  href={orgPath(orgId, `/register-issues/${i.id}`)}
                  className="text-sm font-medium hover:underline"
                >
                  {i.title}
                </Link>
                <div className="text-xs text-muted-foreground">
                  {dateTime(i.takenAt)} · {i.takenBy ? 'Issued by a person' : 'Issued on schedule'}{' '}
                  · <code>{i.hash.slice(0, 12)}</code>
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="xs" variant="outline" onClick={() => void download(i.id, 'csv')}>
                  <Download data-icon="inline-start" /> CSV
                </Button>
                <Button size="xs" variant="outline" onClick={() => void download(i.id, 'json')}>
                  <Download data-icon="inline-start" /> Signed JSON
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {(isOwner || role === 'dev') && (
        <Section title="Issue by itself">
          <div className="flex flex-wrap items-center gap-3 p-4 text-sm">
            <SimpleSelect
              size="sm"
              className="w-48"
              value={String(schedule.data?.everyDays ?? 0)}
              onValueChange={(v) =>
                setSchedule.mutate({ orgId, everyDays: v === '0' ? null : Number(v) })
              }
              options={EVERY}
            />
            {schedule.data?.lastIssuedAt && (
              <span className="text-xs text-muted-foreground">
                Last by schedule {dateTime(schedule.data.lastIssuedAt)}
              </span>
            )}
          </div>
        </Section>
      )}

      <Section title="Check a document">
        <div className="p-4">
          <p className="mb-3 text-sm text-muted-foreground">
            Anyone can check a register or report against Kestrel&apos;s signing keys at{' '}
            <code>/verify</code>, without signing in.
          </p>
          <VerifyDocument />
        </div>
      </Section>
    </PageContainer>
  );
}
