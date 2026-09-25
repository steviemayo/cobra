'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { timeAgo } from '@/lib/format';
import { useTRPC } from '@/trpc/client';

const ANY = '__any';

/** What staff have done or looked at across organisations. Filter by person, organisation or kind of action. */
export function StaffAudit() {
  const trpc = useTRPC();
  const people = useQuery(trpc.staff.audit.people.queryOptions());
  const orgs = useQuery(trpc.staff.orgs.list.queryOptions());
  const [staffUserId, setStaff] = useState(ANY);
  const [orgId, setOrg] = useState(ANY);
  const [action, setAction] = useState('');
  // The start of each page after the first: rows older than the last row of the page before.
  const [cursors, setCursors] = useState<Date[]>([]);
  const cursor = cursors.at(-1);

  const page = useQuery({
    ...trpc.staff.audit.list.queryOptions({
      ...(staffUserId !== ANY ? { staffUserId } : {}),
      ...(orgId !== ANY ? { orgId } : {}),
      ...(action.trim() ? { action: action.trim() } : {}),
      ...(cursor ? { before: cursor } : {}),
    }),
    placeholderData: (previous) => previous,
  });
  const filtered =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setCursors([]);
    };

  return (
    <PageContainer wide>
      <PageHeader
        title="Staff audit trail"
        description="What Kestrel staff have looked at or changed. Reading this page is not itself recorded."
      />
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="sa-staff">Staff member</Label>
          <SimpleSelect
            id="sa-staff"
            value={staffUserId}
            onValueChange={filtered(setStaff)}
            options={[
              { value: ANY, label: 'Anyone' },
              ...(people.data ?? []).map((p) => ({ value: p.userId, label: p.email ?? p.userId })),
            ]}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sa-org">Organisation</Label>
          <SimpleSelect
            id="sa-org"
            value={orgId}
            onValueChange={filtered(setOrg)}
            options={[
              { value: ANY, label: 'Any organisation' },
              ...(orgs.data ?? []).map((o) => ({ value: o.id, label: o.name })),
            ]}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sa-action">Action starts with</Label>
          <Input
            id="sa-action"
            className="w-44"
            placeholder="session."
            value={action}
            onChange={(e) => filtered(setAction)(e.target.value)}
          />
        </div>
      </div>

      {page.isPending && <Skeleton className="h-64 w-full" />}
      {page.error && <p className="text-sm text-destructive">{page.error.message}</p>}
      {page.data && page.data.rows.length === 0 && (
        <EmptyState icon={ScrollText} title="Nothing matches" description="Try a wider filter." />
      )}
      {page.data && page.data.rows.length > 0 && (
        <ul className="divide-y rounded-lg border text-sm">
          {page.data.rows.map((r) => (
            <li
              key={r.id}
              className="grid gap-x-4 gap-y-0.5 px-3 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)_12rem]"
            >
              <span className="text-xs text-muted-foreground" title={new Date(r.at).toISOString()}>
                {timeAgo(r.at)}
              </span>
              <span>
                <strong className="font-medium">{r.staff}</strong> {r.what}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {r.orgId && (
                  <Link className="hover:underline" href={`/staff/orgs/${r.orgId}`}>
                    {r.orgName}
                  </Link>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={cursors.length === 0}
          onClick={() => setCursors((c) => c.slice(0, -1))}
        >
          Newer
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!page.data?.more}
          onClick={() => {
            const last = page.data?.rows.at(-1);
            if (last) setCursors((c) => [...c, new Date(last.at)]);
          }}
        >
          Older
        </Button>
      </div>
    </PageContainer>
  );
}
