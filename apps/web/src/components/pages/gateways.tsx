'use client';
import { useQuery } from '@tanstack/react-query';
import { Router } from 'lucide-react';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { GatewayStatus } from '@/components/common/status';
import { useOrg } from '@/components/shell/org-context';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { timeAgo } from '@/lib/format';
import { useTRPC } from '@/trpc/client';

export function GatewaysView() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const gateways = useQuery(trpc.gateway.list.queryOptions({ orgId }));

  return (
    <PageContainer>
      <PageHeader
        title="Gateways"
        description="On-site machines that run your rooms and report their status."
      />
      {gateways.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : gateways.data?.length === 0 ? (
        <EmptyState
          icon={Router}
          title="No gateways yet"
          description="Gateway enrolment and deployment are coming in a later release. You can design rooms now; they’ll be ready to deploy when gateways arrive."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Gateway</TableHead>
                <TableHead>Site</TableHead>
                <TableHead className="text-right">Rooms</TableHead>
                <TableHead className="text-right">Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {gateways.data?.map((g) => (
                <TableRow key={g.id}>
                  <TableCell>
                    <GatewayStatus gateway={g} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{g.site.name}</TableCell>
                  <TableCell className="tabular text-right">{g._count.rooms}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {g.lastSeenAt ? timeAgo(g.lastSeenAt) : 'Never'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageContainer>
  );
}
