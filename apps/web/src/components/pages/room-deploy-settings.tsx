'use client';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { useInvalidateEstate } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';
import { useRoom } from './room-shell';

const NONE = 'none';

/** Which gateway runs this room. Only gateways at the room's own site are offered. */
export function GatewaySetting({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const { room } = useRoom(roomId);
  const invalidate = useInvalidateEstate();
  const gateways = useQuery(trpc.gateway.list.queryOptions({ orgId }));
  const assign = useMutation(
    trpc.room.assignGateway.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          invalidate(),
          qc.invalidateQueries({ queryKey: trpc.gateway.list.queryKey() }),
        ]);
        toast.success('Gateway updated');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (!room) return null;
  const here = (gateways.data ?? []).filter((g) => g.siteId === room.siteId);
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Gateway</h2>
        <p className="text-sm text-muted-foreground">
          The on-site machine that runs this room. Publishing a release sends it there.
        </p>
      </div>
      <SimpleSelect
        className="w-full max-w-sm"
        value={room.gatewayId ?? NONE}
        onValueChange={(v) => assign.mutate({ orgId, roomId, gatewayId: v === NONE ? null : v })}
        disabled={assign.isPending}
        options={[
          { value: NONE, label: 'No gateway' },
          ...here.map((g) => ({ value: g.id, label: g.name })),
        ]}
      />
      {gateways.isSuccess && here.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No gateways at this site yet.{' '}
          <Link
            href={orgPath(orgId, '/gateways')}
            className="text-foreground underline-offset-4 hover:underline"
          >
            Add one
          </Link>
          .
        </p>
      )}
    </section>
  );
}
