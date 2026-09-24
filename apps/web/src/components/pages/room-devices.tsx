'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Cpu } from 'lucide-react';
import { DEVICE_CATALOG, type Device } from '@kestrel/model';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { buttonVariants } from '@/components/ui/button';
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

function controlLabel(d: Device): string {
  if (!d.control) return DEVICE_CATALOG[d.category].controllable ? 'Not set' : 'None needed';
  return d.control.kind === 'driver'
    ? `Driver: ${d.control.driverId}`
    : `Generic ${d.control.protocol.toUpperCase()}`;
}

export function RoomDevices({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const draft = useQuery({ ...trpc.draft.get.queryOptions({ orgId, roomId }), staleTime: 0 });
  const designHref = orgPath(orgId, `/rooms/${roomId}/design`);

  return (
    <PageContainer className="pt-5">
      {draft.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : !draft.data || draft.data.model.devices.length === 0 ? (
        <EmptyState
          icon={Cpu}
          title="No devices modelled"
          description="Add devices in the designer and they’ll be listed here."
          action={
            <Link href={designHref} className={buttonVariants()}>
              Open designer
            </Link>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Device</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Control</TableHead>
                <TableHead className="text-right">Inputs</TableHead>
                <TableHead className="text-right">Outputs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {draft.data.model.devices.map((d) => {
                const unset = DEVICE_CATALOG[d.category].controllable && !d.control;
                return (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {DEVICE_CATALOG[d.category].label}
                    </TableCell>
                    <TableCell className={unset ? 'text-destructive' : 'text-muted-foreground'}>
                      {controlLabel(d)}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {d.ports.filter((p) => p.direction === 'in').length}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {d.ports.filter((p) => p.direction === 'out').length}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </PageContainer>
  );
}
