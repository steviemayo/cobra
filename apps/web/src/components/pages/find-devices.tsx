'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Radar, RotateCw } from 'lucide-react';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { plural } from '@/lib/format';
import { useEstate } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';
import { AddDeviceDialog, type AddDeviceDefaults } from './assets';

type Found = RouterOutputs['discovery']['result']['found'][number];

/** How long to wait for a scan before telling the person it is taking too long. */
const GIVE_UP_MS = 120_000;
const POLL_MS = 2_000;

function defaultsFor(
  f: Found,
  gateway: { id: string; siteId: string | null } | undefined,
): AddDeviceDefaults {
  const s = f.suggestion;
  const label = f.name || f.model || s?.label || 'Device';
  const base: AddDeviceDefaults = {
    kind: s?.kind ?? 'passive',
    name: label.includes(f.host) ? label : `${label} (${f.host})`,
    ...(s?.category ? { category: s.category } : {}),
    make: f.manufacturer || s?.make || undefined,
    model: f.model || undefined,
    ...(gateway?.siteId ? { siteId: gateway.siteId } : {}),
  };
  if (base.kind === 'active') {
    base.driver = s?.driver;
    base.host = f.host;
    if (gateway?.siteId) base.gateway = { id: gateway.id, siteId: gateway.siteId };
  } else {
    base.ip = f.host;
  }
  return base;
}

/**
 * Asks a gateway to look at its own network and lists what answers, so an installer does not have
 * to hunt for addresses. Everything a gateway reports is a hint and is shown as plain text.
 */
export function FindDevicesDialog({
  gatewayId: initialGateway,
  onClose,
}: {
  gatewayId?: string;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const { sites, rooms } = useEstate();
  const gateways = useQuery(trpc.gateway.list.queryOptions({ orgId }));
  const [gatewayId, setGatewayId] = useState(initialGateway ?? '');
  const [network, setNetwork] = useState('');
  const [commandId, setCommandId] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [adding, setAdding] = useState<Found | null>(null);

  const gateway = gateways.data?.find((g) => g.id === gatewayId);
  const start = useMutation(
    trpc.discovery.start.mutationOptions({
      onSuccess: (res) => {
        setStartError(null);
        setTimedOut(false);
        setCommandId(res.commandId);
      },
      onError: (e) => setStartError(e.message),
    }),
  );

  // Stop waiting after two minutes. Polling itself stops when the dialog unmounts.
  useEffect(() => {
    if (!commandId) return;
    const t = setTimeout(() => setTimedOut(true), GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [commandId]);

  const result = useQuery({
    ...trpc.discovery.result.queryOptions({ orgId, commandId: commandId ?? '' }),
    enabled: !!commandId,
    retry: false,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return timedOut ||
        q.state.status === 'error' ||
        (status && status !== 'pending' && status !== 'sent')
        ? false
        : POLL_MS;
    },
  });

  const status = result.data?.status;
  const running =
    !!commandId && !timedOut && (!status || status === 'pending' || status === 'sent');
  const failed =
    status === 'failed' || status === 'expired'
      ? (result.data?.error ?? 'The scan did not finish.')
      : null;
  const done = status === 'succeeded' ? result.data : null;
  const canStart = !!gateway && gateway.status === 'online' && gateway.canDiscover && !running;

  function scan() {
    setCommandId(null);
    setStartError(null);
    start.mutate({ orgId, gatewayId, ...(network.trim() ? { subnet: network.trim() } : {}) });
  }

  const options = (gateways.data ?? []).map((g) => ({
    value: g.id,
    label:
      g.status !== 'online'
        ? `${g.name} (offline)`
        : !g.canDiscover
          ? `${g.name} (needs updating)`
          : g.name,
    disabled: g.status !== 'online' || !g.canDiscover,
  }));

  return (
    <>
      <Dialog open={!adding} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Find devices on your local network</DialogTitle>
            <DialogDescription>
              The gateway looks at its own network for projectors, switchers and other equipment and
              lists what answers. It only reads; nothing is changed. What it finds is a hint, so
              check each one before adding it.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label className="text-xs">Gateway</Label>
              <SimpleSelect
                value={gatewayId}
                onValueChange={(v) => {
                  setGatewayId(v);
                  setCommandId(null);
                  setStartError(null);
                }}
                options={options}
                placeholder={gateways.isPending ? 'Loading…' : 'Choose a gateway'}
                disabled={running}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Network (optional)</Label>
              <Input
                value={network}
                onChange={(e) => setNetwork(e.target.value)}
                placeholder="192.168.1"
                maxLength={40}
                disabled={running}
              />
            </div>
            <Button onClick={scan} disabled={!canStart || start.isPending}>
              <Radar data-icon="inline-start" /> {commandId ? 'Scan again' : 'Scan'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Leave the network blank to look at every private network the gateway is on. To look at
            one, type its first three numbers, like 192.168.1.
          </p>
          {gateways.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              There is no gateway yet. Set one up on the Gateways page first.
            </p>
          )}

          {(start.isPending || running) && (
            <div className="flex items-center gap-2 rounded-lg border px-4 py-3 text-sm">
              <Spinner />
              <span>
                {status === 'sent'
                  ? 'The gateway is looking. This can take a minute or two.'
                  : 'Waiting for the gateway to pick this up. It checks in every 30 seconds.'}
              </span>
            </div>
          )}

          {startError && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive">
              <span>{startError}</span>
              <Button variant="outline" size="sm" onClick={scan} disabled={!canStart}>
                <RotateCw data-icon="inline-start" /> Retry
              </Button>
            </div>
          )}
          {failed && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive">
              <span>{failed}</span>
              <Button variant="outline" size="sm" onClick={scan} disabled={!canStart}>
                <RotateCw data-icon="inline-start" /> Retry
              </Button>
            </div>
          )}
          {result.isError && !startError && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive">
              <span>{result.error.message}</span>
              <Button variant="outline" size="sm" onClick={scan} disabled={!canStart}>
                <RotateCw data-icon="inline-start" /> Retry
              </Button>
            </div>
          )}
          {timedOut && !done && !failed && (
            <div className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm">
              <span>
                The gateway has not answered yet. It may be busy or have lost its connection.
              </span>
              <Button variant="outline" size="sm" onClick={scan} disabled={!canStart}>
                <RotateCw data-icon="inline-start" /> Retry
              </Button>
            </div>
          )}

          {done && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Looked at {done.subnets.length > 0 ? done.subnets.join(', ') : 'the network'} (
                {plural(done.hostsScanned, 'address', 'addresses')}) and found{' '}
                {plural(done.found.length, 'device')}.
              </p>
              {done.truncated && (
                <div className="rounded-lg border border-warning/50 px-4 py-3 text-sm">
                  There was more than this list can show. Scan one network at a time to see the
                  rest.
                </div>
              )}
              {done.found.length === 0 ? (
                <div className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
                  Nothing answered. Check the gateway is on the same network as the equipment and
                  that the equipment is switched on, then scan again.
                </div>
              ) : (
                <div className="overflow-hidden rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Address</TableHead>
                        <TableHead>Looks like</TableHead>
                        <TableHead>Name / model</TableHead>
                        <TableHead>Ports</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">
                          <span className="sr-only">Add</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {done.found.map((f) => (
                        <TableRow key={f.host}>
                          <TableCell className="tabular font-medium">{f.host}</TableCell>
                          <TableCell>
                            {f.suggestion?.label ?? f.kind ?? 'Unknown'}
                            {(f.suggestion?.note ?? f.note) && (
                              <div className="text-xs text-muted-foreground">
                                {f.suggestion?.note ?? f.note}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            {[f.name, f.manufacturer, f.model].filter(Boolean).join(' · ') || (
                              <span className="text-muted-foreground">Not reported</span>
                            )}
                          </TableCell>
                          <TableCell className="tabular text-muted-foreground">
                            {f.ports.join(', ')}
                          </TableCell>
                          <TableCell>
                            {f.existing ? (
                              <Link href={orgPath(orgId, `/devices/${f.existing.id}`)}>
                                <Badge variant="secondary">Already in register</Badge>
                              </Link>
                            ) : (
                              <span className="text-muted-foreground">New</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {f.existing ? (
                              <div className="flex justify-end gap-1">
                                <Button variant="outline" size="sm" disabled>
                                  Add
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => setAdding(f)}>
                                  Add anyway
                                </Button>
                              </div>
                            ) : (
                              <Button variant="outline" size="sm" onClick={() => setAdding(f)}>
                                Add
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {adding && (
        <AddDeviceDialog
          sites={sites}
          rooms={rooms}
          defaults={defaultsFor(adding, gateway)}
          onClose={() => {
            setAdding(null);
            void qc.invalidateQueries({ queryKey: trpc.discovery.result.queryKey() });
          }}
        />
      )}
    </>
  );
}
