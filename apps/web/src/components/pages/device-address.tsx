'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { toast } from 'sonner';
import { SimpleSelect } from '@/components/common/simple-select';
import { Section } from '@/components/common/section';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { timeAgo } from '@/lib/format';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Device = RouterOutputs['device']['get'];
type Mode = 'fixed' | 'tracked';

const MODE_OPTIONS = [
  { value: 'fixed', label: 'Fixed: the address never changes' },
  { value: 'tracked', label: 'Tracked: find it again if its address changes' },
];

const HOW: Record<string, string> = {
  hostname: 'by its name',
  mac: 'by its MAC address',
  identity: 'by what it reported about itself',
  manual: 'set by a person',
};

/**
 * The fields for how a monitored device's address is kept. Used when adding a device and on its
 * settings page. A device with a fixed address needs nothing; a tracked one is found again by its
 * gateway if a new lease gives it a new address.
 */
export function AddressTrackingFields({
  mode,
  hostname,
  mac,
  onChange,
}: {
  mode: Mode;
  hostname: string;
  mac: string;
  onChange: (next: { mode: Mode; hostname: string; mac: string }) => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="space-y-1.5">
        <Label>Address</Label>
        <SimpleSelect
          value={mode}
          onValueChange={(v) => onChange({ mode: v as Mode, hostname, mac })}
          options={MODE_OPTIONS}
        />
        {mode === 'fixed' && (
          <p className="text-xs text-muted-foreground">
            Best when the device has a static address or a DHCP reservation. Ask your network team
            to reserve its address, and an offline device always means a real fault.
          </p>
        )}
      </div>
      {mode === 'tracked' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>MAC address</Label>
            <Input
              value={mac}
              onChange={(e) => onChange({ mode, hostname, mac: e.target.value })}
              placeholder="aa:bb:cc:dd:ee:ff"
              maxLength={40}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Hostname (optional)</Label>
            <Input
              value={hostname}
              onChange={(e) => onChange({ mode, hostname: e.target.value, mac })}
              placeholder="projector-1.local"
              maxLength={253}
            />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            If the device goes quiet, its gateway looks for it by name, then by MAC address on its
            own network. Leave the MAC blank to have the gateway learn it while the device is
            healthy. Needs gateway 0.6.0 or newer.
          </p>
        </div>
      )}
    </div>
  );
}

function useAddressActions(deviceId: string) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.device.get.queryKey() });
  const fail = (e: { message: string }) => toast.error(e.message);
  const find = useMutation(
    trpc.device.findAgain.mutationOptions({
      onSuccess: () => {
        toast.success('The gateway will look for it within a minute.');
        return refresh();
      },
      onError: fail,
    }),
  );
  const use = useMutation(
    trpc.device.useAddress.mutationOptions({
      onSuccess: () => {
        toast.success('Address updated. The gateway picks it up within a minute.');
        return refresh();
      },
      onError: fail,
    }),
  );
  return {
    find: () => find.mutate({ orgId, deviceId }),
    use: (address: string) => use.mutate({ orgId, deviceId, address }),
    busy: find.isPending || use.isPending,
  };
}

interface Suggestion {
  issue?: 'identity_changed' | 'not_found';
  candidates?: { address: string; note: string }[];
  at?: string;
}

/**
 * Shown above a tracked device when its gateway could not settle where it is: nothing was found,
 * another device answers at its address, or several things might be it. Never changes anything on its own.
 */
export function AddressNotice({ device }: { device: Device }) {
  const { canSupport } = useOrg();
  const actions = useAddressActions(device.id);
  if (device.addressMode !== 'tracked') return null;
  const s = device.addressSuggestion as Suggestion | null;
  if (!s || (!s.issue && !s.candidates?.length)) return null;
  return (
    <div className="space-y-2 rounded-lg border border-warning/50 bg-warning/5 px-4 py-3 text-sm">
      <div className="flex items-start gap-2">
        <MapPin className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="space-y-1">
          <div className="font-medium">
            {s.issue === 'identity_changed'
              ? 'Something else is answering at this device’s address'
              : s.candidates?.length
                ? 'This device may have a new address'
                : 'The gateway could not find this device'}
          </div>
          <p className="text-muted-foreground">
            {s.issue === 'identity_changed'
              ? 'The MAC address at its address is not the one recorded, so it has probably been given a new lease. It is shown as offline until it is found.'
              : s.candidates?.length
                ? 'These answered where the device should be, but nothing could confirm which one it is. Pick the right one, or leave it.'
                : 'It is not at its address, its name did not resolve and its MAC address was not seen on the gateway’s network. It will keep looking, less often each time.'}
            {s.at ? ` Last looked ${timeAgo(s.at)}.` : ''}
          </p>
          {s.candidates?.map((c) => (
            <div key={c.address} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{c.address}</span>
              <span className="text-xs text-muted-foreground">{c.note}</span>
              {canSupport && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actions.busy}
                  onClick={() => actions.use(c.address)}
                >
                  Use this address
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
      {canSupport && (
        <Button size="sm" variant="outline" disabled={actions.busy} onClick={actions.find}>
          {actions.busy && <Spinner />}
          Find again
        </Button>
      )}
    </div>
  );
}

interface HistoryEntry {
  at: string;
  from: string;
  to: string;
  how: string;
}

/** The device's address settings (on its Settings tab) and where it has been. */
export function DeviceAddress({ device }: { device: Device }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const actions = useAddressActions(device.id);
  const [draft, setDraft] = useState({
    mode: (device.addressMode === 'tracked' ? 'tracked' : 'fixed') as Mode,
    hostname: device.hostname ?? '',
    mac: device.mac ?? '',
  });
  const save = useMutation(
    trpc.device.update.mutationOptions({
      onSuccess: async () => {
        toast.success('Address settings saved');
        await qc.invalidateQueries({ queryKey: trpc.device.get.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const history = (
    Array.isArray(device.addressHistory) ? device.addressHistory : []
  ) as HistoryEntry[];
  const dirty =
    draft.mode !== device.addressMode ||
    (draft.mode === 'tracked' &&
      (draft.hostname.trim() !== (device.hostname ?? '') ||
        draft.mac.trim() !== (device.mac ?? '')));
  return (
    <Section title="Address">
      <div className="space-y-4 p-4">
        <AddressTrackingFields {...draft} onChange={setDraft} />
        {canSupport && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!dirty || save.isPending}
              onClick={() =>
                save.mutate({
                  orgId,
                  deviceId: device.id,
                  addressMode: draft.mode,
                  ...(draft.mode === 'tracked'
                    ? { hostname: draft.hostname.trim() || null, mac: draft.mac.trim() || null }
                    : {}),
                })
              }
            >
              {save.isPending && <Spinner />}
              Save
            </Button>
            {device.addressMode === 'tracked' && (
              <Button size="sm" variant="outline" disabled={actions.busy} onClick={actions.find}>
                Find again
              </Button>
            )}
          </div>
        )}
        {history.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">Where it has been</div>
            <ul className="space-y-0.5 text-sm">
              {history.map((h) => (
                <li key={h.at}>
                  <span className="font-mono text-xs">{h.from || 'unknown'}</span> to{' '}
                  <span className="font-mono text-xs">{h.to}</span>
                  <span className="text-xs text-muted-foreground">
                    {' '}
                    · {HOW[h.how] ?? h.how} · {timeAgo(h.at)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}
