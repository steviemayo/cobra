'use client';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Printer, ShieldAlert } from 'lucide-react';
import { PageContainer } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/trpc/client';
import type { RegisterPayload, RowChange } from '@/server/register-issues';
import Link from 'next/link';

const dash = (v: string | null | undefined) => v || '–';

/** One issued register, laid out to be read and printed (use the browser's Print, Save as PDF). */
export function RegisterIssueView({ issueId }: { issueId: string }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const q = useQuery(trpc.register.issue.queryOptions({ orgId, issueId }));
  if (q.isPending)
    return (
      <PageContainer>
        <Skeleton className="h-40 w-full" />
      </PageContainer>
    );
  if (q.isError)
    return (
      <PageContainer>
        <p className="text-sm text-destructive">{q.error.message}</p>
      </PageContainer>
    );
  const doc = q.data.document as unknown as {
    payload: RegisterPayload;
    hash: string;
    signature: string;
    keyId: string;
  };
  const p = doc.payload;
  const ok = q.data.verified.valid;
  const diff = p.changesSince?.diff;
  return (
    <PageContainer wide className="print:max-w-none print:p-0">
      <div className="flex items-center justify-between print:hidden">
        <Link
          href={orgPath(orgId, '/register-issues')}
          className="text-sm text-muted-foreground hover:underline"
        >
          All register issues
        </Link>
        <Button size="sm" variant="outline" onClick={() => window.print()}>
          <Printer data-icon="inline-start" /> Print or save as PDF
        </Button>
      </div>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{p.title}</h1>
        <p className="text-sm text-muted-foreground">
          {p.orgName} · {p.scopeName} · issued {new Date(p.takenAt).toLocaleString('en-AU')}
        </p>
        <p className="flex items-center gap-2 text-xs">
          {ok ? (
            <CheckCircle2 className="size-3.5 text-success" />
          ) : (
            <ShieldAlert className="size-3.5 text-destructive" />
          )}
          {ok
            ? 'Signature checked: Kestrel signed exactly this content.'
            : 'The signature does not check out.'}
          <code className="text-muted-foreground">
            key {doc.keyId} · {doc.hash.slice(0, 16)}
          </code>
        </p>
      </header>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Devices', p.summary.devices],
          ['Monitored', p.summary.monitored],
          ['Recorded only', p.summary.recordedOnly],
          ['Complete', `${p.summary.completenessPct}%`],
        ].map(([k, v]) => (
          <div key={String(k)} className="rounded-lg border px-4 py-3">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="tabular text-xl font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      {diff && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">Changes since R{p.changesSince!.number}</h2>
          <p className="text-sm text-muted-foreground">
            {diff.added.length} added, {diff.removed.length} removed, {diff.changed.length} changed.
          </p>
          <ul className="space-y-1 text-sm">
            {diff.added.map((a) => (
              <li key={a.id}>Added: {a.name}</li>
            ))}
            {diff.removed.map((a) => (
              <li key={a.id}>Removed: {a.name}</li>
            ))}
            {diff.changed.map((c: RowChange) => (
              <li key={c.id}>
                {c.name}:{' '}
                {c.fields.map((f) => `${f.field} ${dash(f.before)} to ${dash(f.after)}`).join('; ')}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b">
              {[
                'Device',
                'Category',
                'Site',
                'Area',
                'Room',
                'Make / model',
                'Serial',
                'MAC',
                'IP',
                'Firmware',
                'Asset tag',
                'Status',
                'Warranty',
              ].map((h) => (
                <th key={h} className="px-2 py-1.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r) => (
              <tr key={r.id} className="border-b align-top">
                <td className="px-2 py-1.5 font-medium">{r.name}</td>
                <td className="px-2 py-1.5">{r.categoryLabel}</td>
                <td className="px-2 py-1.5">{r.site}</td>
                <td className="px-2 py-1.5">{dash(r.area)}</td>
                <td className="px-2 py-1.5">{dash(r.room)}</td>
                <td className="px-2 py-1.5">
                  {[r.make, r.model].filter(Boolean).join(' ') || '–'}
                </td>
                <td className="px-2 py-1.5 font-mono">
                  {dash(r.serial)}
                  {r.sources.serial && (
                    <span className="ml-1 font-sans text-muted-foreground">
                      ({r.sources.serial === 'discovered' ? 'from device' : 'entered'})
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 font-mono">{dash(r.mac)}</td>
                <td className="px-2 py-1.5">{dash(r.ip)}</td>
                <td className="px-2 py-1.5">{dash(r.firmware)}</td>
                <td className="px-2 py-1.5">{dash(r.assetTag)}</td>
                <td className="px-2 py-1.5">{r.status.replace('_', ' ')}</td>
                <td className="px-2 py-1.5">{dash(r.warrantyEndsOn)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        The signature shows Kestrel issued this content at this time and that it has not been
        changed. Values marked entered were typed in by people. Check this document at /verify with
        the signed JSON.
      </p>
    </PageContainer>
  );
}
