'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { HealthPill } from '@/components/common/health';
import { DesignBadge, GatewayStatus } from '@/components/common/status';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { orgPath, useOrg } from '@/components/shell/org-context';
import type { RoomLive } from '@/lib/use-estate';
import { timeAgo } from '@/lib/format';
import type { RouterOutputs } from '@/trpc/types';

export type RoomRow = RouterOutputs['room']['overview'][number];

export function RoomsTable({
  rooms,
  live,
  showSite = true,
}: {
  rooms: RoomRow[];
  /** Live monitoring state by room id, from `useEstate()`/`useRoomsLive()`. Omit while it loads. */
  live?: Map<string, RoomLive>;
  showSite?: boolean;
}) {
  const router = useRouter();
  const { orgId } = useOrg();
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead>Room</TableHead>
            {showSite && <TableHead>Site</TableHead>}
            <TableHead>Live status</TableHead>
            <TableHead>Design</TableHead>
            <TableHead className="text-right">Devices</TableHead>
            <TableHead>Gateway</TableHead>
            <TableHead className="text-right">Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rooms.map((r) => {
            const href = orgPath(orgId, `/rooms/${r.id}`);
            const liveRoom = live?.get(r.id);
            return (
              <TableRow key={r.id} className="cursor-pointer" onClick={() => router.push(href)}>
                <TableCell className="font-medium">
                  <Link
                    href={href}
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-2 hover:underline"
                  >
                    {r.name}
                    {r.kind === 'staging' && <Badge variant="secondary">Staging</Badge>}
                  </Link>
                </TableCell>
                {showSite && (
                  <TableCell>
                    <Link
                      href={orgPath(orgId, `/sites/${r.siteId}`)}
                      onClick={(e) => e.stopPropagation()}
                      className="text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {r.site.name}
                    </Link>
                  </TableCell>
                )}
                <TableCell>
                  {liveRoom ? (
                    <HealthPill level={liveRoom.health.level} reasons={liveRoom.health.reasons} />
                  ) : (
                    <span className="text-sm text-muted-foreground">–</span>
                  )}
                </TableCell>
                <TableCell>
                  <DesignBadge draft={r.draft} monitorOnly={r.monitorOnly} />
                </TableCell>
                <TableCell className="tabular text-right">
                  {liveRoom && liveRoom.devices.total > 0
                    ? `${liveRoom.devices.online} of ${liveRoom.devices.total} online`
                    : (r.draft?.devices ?? '—')}
                </TableCell>
                <TableCell>
                  <GatewayStatus gateway={r.gateway} />
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {timeAgo(r.draft?.updatedAt ?? r.updatedAt)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
