'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { INCIDENT_KIND_LABEL, SeverityPill, dateTime } from '@/components/common/health';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { plural } from '@/lib/format';
import { useTRPC } from '@/trpc/client';

/** Open incidents across every customer, most serious first, with the customer named. */
export function MspIncidentsView() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [customer, setCustomer] = useState('');
  const [severity, setSeverity] = useState('');
  const [resolved, setResolved] = useState(false);
  const q = useQuery({
    ...trpc.msp.incidents.queryOptions({ orgId, includeResolved: resolved }),
    refetchInterval: 30_000,
  });
  const customers = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of q.data ?? []) m.set(i.customerOrgId, i.customerName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [q.data]);
  const rows = (q.data ?? []).filter(
    (i) => (!customer || i.customerOrgId === customer) && (!severity || i.severity === severity),
  );
  return (
    <PageContainer wide>
      <PageHeader
        title="All incidents"
        description="What is wrong right now across every customer you look after. Open one to work on it in that customer's organisation."
      />
      <div className="flex flex-wrap items-center gap-2">
        <SimpleSelect
          size="sm"
          className="w-48"
          value={customer}
          placeholder="All customers"
          onValueChange={(v) => setCustomer(v === '__all' ? '' : v)}
          options={[
            { value: '__all', label: 'All customers' },
            ...customers.map(([id, name]) => ({ value: id, label: name })),
          ]}
        />
        <SimpleSelect
          size="sm"
          className="w-36"
          value={severity}
          placeholder="Any severity"
          onValueChange={(v) => setSeverity(v === '__all' ? '' : v)}
          options={[
            { value: '__all', label: 'Any severity' },
            { value: 'critical', label: 'Critical' },
            { value: 'warning', label: 'Warning' },
            { value: 'info', label: 'Info' },
          ]}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={resolved}
            onChange={(e) => setResolved(e.target.checked)}
          />{' '}
          Include closed in the last week
        </label>
        <span className="ml-auto text-xs text-muted-foreground">
          {plural(rows.length, 'incident')}
        </span>
      </div>
      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : q.error ? (
        <p className="text-sm text-destructive">{q.error.message}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={AlertTriangle}
          title="Nothing is wrong"
          description="No open incidents across your customers."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Severity</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Incident</th>
                <th className="px-3 py-2 font-medium">Room</th>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Opened</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((i) => (
                <tr key={i.id} className="hover:bg-muted/40">
                  <td className="px-3 py-2">
                    <SeverityPill severity={i.severity} />
                  </td>
                  <td className="px-3 py-2">
                    <Link href={orgPath(i.customerOrgId)} className="hover:underline">
                      {i.customerName}
                    </Link>
                  </td>
                  <td className="px-3 py-2 font-medium">
                    <Link href={orgPath(i.customerOrgId, '/incidents')} className="hover:underline">
                      {i.title}
                    </Link>
                    {i.status !== 'open' && (
                      <Badge variant="secondary" className="ml-2">
                        Closed
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{i.roomName ?? '–'}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {INCIDENT_KIND_LABEL[i.kind] ?? i.kind}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{dateTime(i.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageContainer>
  );
}
