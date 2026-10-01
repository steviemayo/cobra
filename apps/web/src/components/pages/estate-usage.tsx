'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Lightbulb } from 'lucide-react';
import { USAGE_KIND_LABEL, type UsageKind } from '@kestrel/model';
import { minutesLabel } from '@/components/common/usage-charts';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { Section } from '@/components/common/section';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTRPC } from '@/trpc/client';

/** How every monitored room is used, ranked, with what stands out. */
export function EstateUsageView() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [kind, setKind] = useState<UsageKind>('av');
  const [days, setDays] = useState(30);
  const usage = useQuery({
    ...trpc.roomUsage.estate.queryOptions({ orgId, kind, days }),
    refetchInterval: 60_000,
    retry: false,
  });
  const rows = [...(usage.data?.rows ?? [])].sort(
    (a, b) => (b.utilisation ?? -1) - (a.utilisation ?? -1),
  );

  return (
    <PageContainer>
      <PageHeader
        title="Usage"
        description="How the rooms are used, worked out from what their devices report. What counts as in use is set under Room definitions."
        actions={
          <>
            <SimpleSelect
              size="sm"
              className="w-40"
              value={kind}
              onValueChange={(v) => setKind(v as UsageKind)}
              options={[
                { value: 'av', label: USAGE_KIND_LABEL.av },
                { value: 'occupied', label: USAGE_KIND_LABEL.occupied },
              ]}
            />
            <SimpleSelect
              size="sm"
              className="w-36"
              value={String(days)}
              onValueChange={(v) => setDays(Number(v))}
              options={[
                { value: '7', label: 'Last 7 days' },
                { value: '30', label: 'Last 30 days' },
                { value: '90', label: 'Last 90 days' },
              ]}
            />
          </>
        }
      />
      {usage.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : usage.isError ? (
        <EmptyState
          icon={BarChart3}
          title="Usage is not available"
          description="Your plan may not include analytics."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="Nothing to measure yet"
          description="Usage comes from monitored devices. Add networked devices with a driver to your rooms."
        />
      ) : (
        <>
          {usage.data.insights.length > 0 && (
            <Section title="Worth a look">
              <ul className="divide-y">
                {usage.data.insights.map((i, n) => (
                  <li key={n} className="flex items-start gap-3 px-4 py-3 text-sm">
                    <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning" />
                    <div>
                      <Link
                        href={orgPath(orgId, `/rooms/${i.roomId}/usage`)}
                        className="font-medium hover:underline"
                      >
                        {i.title}
                      </Link>
                      <div className="text-xs text-muted-foreground">{i.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Room</TableHead>
                  <TableHead className="text-right">Utilisation</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                  <TableHead className="text-right">Average</TableHead>
                  <TableHead className="text-right">In use</TableHead>
                  <TableHead className="text-right">Out of hours</TableHead>
                  <TableHead>Now</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.roomId}>
                    <TableCell className="font-medium">
                      <Link
                        href={orgPath(orgId, `/rooms/${r.roomId}/usage`)}
                        className="hover:underline"
                      >
                        {r.roomName}
                      </Link>
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {r.utilisation === null ? '–' : `${Math.round(r.utilisation * 100)}%`}
                    </TableCell>
                    <TableCell className="tabular text-right">{r.sessions}</TableCell>
                    <TableCell className="tabular text-right">
                      {r.sessions ? minutesLabel(r.averageMinutes) : '–'}
                    </TableCell>
                    <TableCell className="tabular text-right">{minutesLabel(r.minutes)}</TableCell>
                    <TableCell className="tabular text-right text-muted-foreground">
                      {minutesLabel(r.afterHoursMinutes)}
                    </TableCell>
                    <TableCell>
                      {r.inUseNow === null ? (
                        '–'
                      ) : r.inUseNow ? (
                        <Badge>In use</Badge>
                      ) : (
                        <Badge variant="secondary">Empty</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </PageContainer>
  );
}
