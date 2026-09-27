'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Search } from 'lucide-react';
import { toast } from 'sonner';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { plural } from '@/lib/format';
import { useTRPC } from '@/trpc/client';

interface Found {
  host: string;
  ports: number[];
  kind: string;
  name?: string;
  manufacturer?: string;
  model?: string;
  note?: string;
}
interface Scan {
  subnets: string[];
  hostsScanned: number;
  found: Found[];
  truncated: boolean;
}

/** The gateway's answer, checked, since it comes from outside the portal's own code. */
function readScan(output: unknown): Scan | null {
  const o = output as Partial<Scan> | null;
  if (!o || !Array.isArray(o.found) || !Array.isArray(o.subnets)) return null;
  const found = o.found.filter((f): f is Found => typeof f?.host === 'string' && Array.isArray(f.ports));
  return { subnets: o.subnets.map(String), hostsScanned: Number(o.hostsScanned) || 0, found, truncated: !!o.truncated };
}

/**
 * Asks the room's gateway to look at its own network for equipment, then lets an installer put an
 * address it found on one of the room's devices. It only reads; the person decides what is what.
 */
export function DiscoverDevicesDialog({ roomId, open, onOpenChange }: { roomId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canEdit } = useOrg();
  const [commandId, setCommandId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [used, setUsed] = useState<Record<string, string>>({});

  const scan = useMutation(
    trpc.command.request.mutationOptions({
      onSuccess: (r) => {
        setCommandId(r.id);
        setUsed({});
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const commands = useQuery({
    ...trpc.command.list.queryOptions({ orgId, roomId }),
    enabled: open && !!commandId,
    refetchInterval: (q) => {
      const c = q.state.data?.find((x) => x.id === commandId);
      return c && !['pending', 'sent'].includes(c.status) ? false : 2000;
    },
  });
  const bindings = useQuery({ ...trpc.binding.view.queryOptions({ orgId, roomId }), enabled: open });
  const save = useMutation(
    trpc.binding.saveDevice.mutationOptions({
      onSuccess: async (r, v) => {
        if ('error' in r && r.error) {
          toast.error(String(r.error));
          return;
        }
        await qc.invalidateQueries({ queryKey: trpc.binding.view.queryKey() });
        setUsed((u) => ({ ...u, [String(v.set?.host)]: v.deviceId }));
        toast.success('Address saved. It reaches the room on the next release, or when the gateway next syncs.');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const command = commands.data?.find((c) => c.id === commandId);
  const waiting = scan.isPending || (!!commandId && (!command || ['pending', 'sent'].includes(command.status)));
  const result = command?.status === 'succeeded' ? readScan(command.output) : null;
  const failed = command && command.status !== 'succeeded' && !waiting;
  const hostDevices = (bindings.data?.devices ?? []).filter((d) => !d.sharedFrom && d.slots.some((s) => s.key === 'host'));
  const options = hostDevices.map((d) => ({ value: d.deviceId, label: d.name }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Find devices on the network</DialogTitle>
          <DialogDescription>
            The room’s gateway looks at its own network for equipment that answers on common control ports. It only reads, and
            it can miss devices that use other ports. Check each one is what you think before using its address.
          </DialogDescription>
        </DialogHeader>

        {!commandId || failed ? (
          <div className="space-y-3">
            {failed && (
              <p className="text-sm text-destructive">
                {command.error ?? (command.status === 'expired' ? 'The gateway did not pick this up in time.' : 'The scan did not finish.')}
              </p>
            )}
            <Button onClick={() => scan.mutate({ orgId, roomId, type: 'discover_devices' })} disabled={scan.isPending}>
              {scan.isPending ? <Spinner /> : <Search />} {failed ? 'Try again' : 'Start looking'}
            </Button>
          </div>
        ) : waiting ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Looking. The gateway picks this up within about half a minute, then a scan takes a few seconds.
          </p>
        ) : result ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Looked at {result.hostsScanned} addresses on {result.subnets.map((s) => `${s}.x`).join(', ')} and found {plural(result.found.length, 'device')}.
              {result.truncated && ' The list was cut short.'}
            </p>
            {result.found.length > 0 && (
              <ul className="max-h-80 divide-y overflow-auto rounded-md border text-sm">
                {result.found.map((f) => (
                  <li key={f.host} className="space-y-1.5 px-3 py-2.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span>
                        <span className="font-mono font-medium">{f.host}</span>
                        <span className="text-muted-foreground"> · {f.name ?? f.kind}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {[f.manufacturer, f.model].filter(Boolean).join(' ') || `port ${f.ports.join(', ')}`}
                      </span>
                    </div>
                    {f.name && <p className="text-xs text-muted-foreground">{f.kind}</p>}
                    {f.note && <p className="text-xs text-warning">{f.note}</p>}
                    {canEdit &&
                      (used[f.host] ? (
                        <p className="flex items-center gap-1.5 text-xs text-success">
                          <Check className="size-3.5" /> Saved for {hostDevices.find((d) => d.deviceId === used[f.host])?.name}
                        </p>
                      ) : options.length > 0 ? (
                        <div className="flex items-center gap-2">
                          <SimpleSelect
                            size="sm"
                            className="w-56"
                            value={chosen[f.host] ?? ''}
                            onValueChange={(v) => setChosen((c) => ({ ...c, [f.host]: v }))}
                            options={options}
                            placeholder="Use as the address of…"
                          />
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={!chosen[f.host] || save.isPending}
                            onClick={() => save.mutate({ orgId, roomId, deviceId: chosen[f.host]!, set: { host: f.host } })}
                          >
                            Use this address
                          </Button>
                        </div>
                      ) : null)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-sm text-destructive">The gateway’s answer could not be read.</p>
        )}

        <DialogFooter>
          {result && (
            <Button variant="outline" onClick={() => scan.mutate({ orgId, roomId, type: 'discover_devices' })} disabled={scan.isPending}>
              Look again
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
