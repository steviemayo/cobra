'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Building2, Search } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Org = RouterOutputs['staff']['orgs']['list'][number];

const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'trial', label: 'On trial', test: (o: Org) => o.plan === 'trial' },
  {
    id: 'ending',
    label: 'Trial ending soon',
    test: (o: Org) => o.trialDaysLeft !== null && o.trialDaysLeft <= 7,
  },
  { id: 'incidents', label: 'Open incidents', test: (o: Org) => o.openIncidents > 0 },
  {
    id: 'offline',
    label: 'Gateway offline',
    test: (o: Org) => o.gateways > o.gatewaysOnline,
  },
  { id: 'nobilling', label: 'No billing record', test: (o: Org) => o.plan === 'none' },
] as const;

function Plan({ o }: { o: Org }) {
  const label = o.plan === 'none' ? 'None' : o.plan[0]!.toUpperCase() + o.plan.slice(1);
  return (
    <div>
      <div>{label}</div>
      {o.trialDaysLeft !== null && (
        <div
          className={cn(
            'text-xs',
            o.trialDaysLeft < 0
              ? 'text-destructive'
              : o.trialDaysLeft <= 7
                ? 'text-warning'
                : 'text-muted-foreground',
          )}
        >
          {o.trialDaysLeft < 0 ? `ended ${-o.trialDaysLeft}d ago` : `${o.trialDaysLeft}d left`}
        </div>
      )}
      {o.plan !== 'trial' && o.plan !== 'none' && (
        <div className="text-xs text-muted-foreground">{o.billingStatus}</div>
      )}
    </div>
  );
}

/** Every organisation on the platform, with the numbers staff need at a glance. */
export function StaffOrgs() {
  const trpc = useTRPC();
  const list = useQuery({ ...trpc.staff.orgs.list.queryOptions(), refetchInterval: 30_000 });
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');

  const rows = useMemo(() => {
    const test = FILTERS.find((f) => f.id === filter)!.test;
    const needle = q.trim().toLowerCase();
    return (list.data ?? []).filter(
      (o) => test(o) && (!needle || o.name.toLowerCase().includes(needle)),
    );
  }, [list.data, q, filter]);

  return (
    <PageContainer wide>
      <PageHeader
        title="Organisations"
        description="Every customer organisation. Opening one is recorded in the staff audit trail."
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search organisations"
            placeholder="Search"
            className="w-64 pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs',
              filter === f.id
                ? 'border-primary bg-primary/10 font-medium'
                : 'text-muted-foreground',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {list.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : list.error ? (
        <p className="text-sm text-destructive">{list.error.message}</p>
      ) : rows.length === 0 ? (
        <EmptyState icon={Building2} title="No organisations match" />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Organisation</th>
                <th className="px-3 py-2 font-medium">Plan</th>
                <th className="px-3 py-2 text-right font-medium">Rooms</th>
                <th className="px-3 py-2 text-right font-medium">Gateways</th>
                <th className="px-3 py-2 text-right font-medium">Incidents</th>
                <th className="px-3 py-2 text-right font-medium">Tickets</th>
                <th className="px-3 py-2 text-right font-medium">People</th>
                <th className="px-3 py-2 font-medium">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((o) => (
                <tr key={o.id} className="hover:bg-muted/40">
                  <td className="px-3 py-2">
                    <Link href={`/staff/orgs/${o.id}`} className="font-medium hover:underline">
                      {o.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Plan o={o} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {o.rooms}
                    {o.combinedRooms > 0 && (
                      <span className="text-xs text-muted-foreground"> +{o.combinedRooms}</span>
                    )}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right tabular-nums',
                      o.gateways > o.gatewaysOnline && 'text-warning',
                    )}
                  >
                    {o.gatewaysOnline}/{o.gateways}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right tabular-nums',
                      o.openIncidents > 0 && 'font-medium text-destructive',
                    )}
                  >
                    {o.openIncidents}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{o.openTickets}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{o.members}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {o.lastActivity ? timeAgo(o.lastActivity) : 'Never'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageContainer>
  );
}
