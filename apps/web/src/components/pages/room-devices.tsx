'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Package, Plus } from 'lucide-react';
import { assetCategoryLabel } from '@kestrel/model';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useEstate } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';
import { AddDeviceDialog } from './assets';
import { DeviceStateBadge } from './device-detail';
import { useRoom } from './room-shell';

/** The devices in one room, monitored or only recorded. The same rows as the asset register. */
export function RoomDeviceList({ roomId, compact }: { roomId: string; compact?: boolean }) {
  const trpc = useTRPC();
  const { orgId, canSupport } = useOrg();
  const { sites, rooms } = useEstate();
  const { room } = useRoom(roomId);
  const devices = useQuery({
    ...trpc.device.list.queryOptions({ orgId, roomId }),
    refetchInterval: 15_000,
  });
  const [adding, setAdding] = useState(false);

  if (devices.isPending) return <Skeleton className="h-24 w-full" />;
  if (devices.isError) return <p className="text-sm text-destructive">{devices.error.message}</p>;

  return (
    <div className="space-y-3">
      {devices.data.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No devices in this room"
          description="Add the equipment in the room. A networked device with a driver is monitored; anything else is recorded as an asset."
          action={
            canSupport ? <Button onClick={() => setAdding(true)}>Add a device</Button> : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Device</TableHead>
                <TableHead>State</TableHead>
                {!compact && <TableHead>Make / model</TableHead>}
                {!compact && <TableHead>Serial</TableHead>}
                <TableHead>Gateway</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.data.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={orgPath(orgId, `/devices/${d.id}`)}
                      className="inline-flex items-center gap-2 hover:underline"
                    >
                      {d.name}
                      {d.swapPending && <AlertTriangle className="size-3.5 text-warning" />}
                    </Link>
                    <div className="text-xs font-normal text-muted-foreground">
                      {assetCategoryLabel(d.category)}
                      {d.roomId !== roomId && ` · shared from ${d.roomName ?? 'another room'}`}
                      {d.roomId === roomId && d.sharedRooms.length > 0 &&
                        ` · shared with ${d.sharedRooms.length} other room${d.sharedRooms.length === 1 ? '' : 's'}`}
                    </div>
                  </TableCell>
                  <TableCell>
                    <DeviceStateBadge state={d.state} />
                  </TableCell>
                  {!compact && (
                    <TableCell className="text-sm">
                      {[d.make, d.model].filter(Boolean).join(' ') || (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </TableCell>
                  )}
                  {!compact && (
                    <TableCell className="font-mono text-xs">
                      {d.serial ?? <span className="text-muted-foreground">–</span>}
                    </TableCell>
                  )}
                  <TableCell className="text-sm text-muted-foreground">
                    {d.kind === 'passive' ? '–' : (d.gatewayName ?? 'Unassigned')}
                    {d.gatewayOverride && <span className="text-xs"> (set on device)</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {canSupport && devices.data.length > 0 && (
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          <Plus data-icon="inline-start" /> Add device
        </Button>
      )}
      {adding && room && (
        <AddDeviceDialog
          sites={sites}
          rooms={rooms}
          siteId={room.siteId}
          roomId={roomId}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

export function RoomDevices({ roomId }: { roomId: string }) {
  return (
    <PageContainer className="pt-5">
      <RoomDeviceList roomId={roomId} />
    </PageContainer>
  );
}
