'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BrandingFields,
  brandingToDraft,
  draftToBranding,
  type BrandingDraft,
} from '@/components/common/branding-fields';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
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

/** Who can use the panel on the LAN, and how it looks. Applies from the next release. */
export function PanelSettings({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const current = useQuery(trpc.room.getPanel.queryOptions({ orgId, roomId }));
  const [mode, setMode] = useState<'open' | 'pin'>('open');
  const [pin, setPin] = useState('');
  const [ips, setIps] = useState('');
  const [inherit, setInherit] = useState(true);
  const [look, setLook] = useState<BrandingDraft>({
    mode: 'dark',
    accent: '',
    logo: '',
    language: 'en',
  });

  useEffect(() => {
    const p = current.data;
    if (!p) return;
    setMode(p.mode);
    setIps(p.trustedIps.join('\n'));
    setInherit(p.inheritBranding);
    setLook(brandingToDraft(p.branding));
  }, [current.data]);

  const save = useMutation(
    trpc.room.setPanel.mutationOptions({
      onSuccess: async () => {
        setPin('');
        await qc.invalidateQueries({ queryKey: trpc.room.getPanel.queryKey() });
        toast.success('Panel settings saved. They apply from the next release.');
      },
    }),
  );

  if (current.isPending) return null;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          orgId,
          roomId,
          mode,
          pin: pin || undefined,
          trustedIps: ips
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          branding: draftToBranding(look),
          inheritBranding: inherit,
        });
      }}
    >
      <div>
        <h2 className="text-sm font-medium">Panel</h2>
        <p className="text-sm text-muted-foreground">
          Who can use this room’s touch panel on the local network, and how it looks. Applies from
          the next release.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="panel-mode">Access</Label>
          <SimpleSelect
            id="panel-mode"
            className="w-full"
            value={mode}
            onValueChange={setMode}
            options={[
              { value: 'open', label: 'Open to anyone on the LAN' },
              { value: 'pin', label: 'Require a PIN' },
            ]}
          />
        </div>
        {mode === 'pin' && (
          <div className="space-y-2">
            <Label htmlFor="panel-pin">PIN (4 to 8 digits)</Label>
            <Input
              id="panel-pin"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              placeholder={
                current.data?.hasPin ? 'Leave blank to keep the current PIN' : 'e.g. 4821'
              }
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            />
          </div>
        )}
      </div>
      {mode === 'pin' && (
        <div className="space-y-2">
          <Label htmlFor="panel-ips">Trusted devices (skip the PIN), one IP address per line</Label>
          <Textarea
            id="panel-ips"
            rows={3}
            className="font-mono text-xs"
            placeholder="10.0.4.21"
            value={ips}
            onChange={(e) => setIps(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Fixed wall panels can be trusted by address. Anything else has to enter the PIN.
          </p>
        </div>
      )}
      <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
        <div>
          <Label htmlFor="panel-inherit">Use the organisation’s theme</Label>
          <p className="text-xs text-muted-foreground">Turn off to give this room its own look.</p>
        </div>
        <Switch id="panel-inherit" checked={inherit} onCheckedChange={setInherit} />
      </div>
      <BrandingFields id="panel" value={look} onChange={setLook} disabled={inherit} />
      {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
      <Button type="submit" variant="outline" disabled={save.isPending}>
        {save.isPending && <Spinner />}
        Save panel settings
      </Button>
    </form>
  );
}

/** Lets outside systems (a booking tool, a building controller) run this room's webhook triggers. */
export function HookSettings({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const info = useQuery(trpc.room.hookInfo.queryOptions({ orgId, roomId }));
  const [secret, setSecret] = useState<string | null>(null);
  const rotate = useMutation(
    trpc.room.rotateHookSecret.mutationOptions({
      onSuccess: async (res) => {
        setSecret(res.secret);
        await qc.invalidateQueries({ queryKey: trpc.room.hookInfo.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (info.isPending || !info.data) return null;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const first = info.data.hooks[0] ?? 'hook_name';
  const curl = `curl -X POST ${origin}/api/hooks/${roomId}/${first} \\n  -H "Authorization: Bearer ${secret ?? '<secret>'}"`;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Webhook triggers</h2>
        <p className="text-sm text-muted-foreground">
          Let another system start an activity in this room. Add a webhook trigger in the designer,
          then call its address with this room’s secret. The room picks it up within about half a
          minute.
        </p>
      </div>
      {info.data.hooks.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Listening for: {info.data.hooks.map((h) => `“${h}”`).join(', ')}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">This design has no webhook triggers yet.</p>
      )}
      {secret && (
        <div className="space-y-1.5 rounded-lg border p-3">
          <p className="text-xs font-medium">Copy this now. It’s shown once.</p>
          <pre className="overflow-auto rounded bg-muted p-2 text-xs">{curl}</pre>
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={rotate.isPending}
        onClick={() => rotate.mutate({ orgId, roomId })}
      >
        {rotate.isPending && <Spinner />}
        {info.data.hasSecret ? 'Generate a new secret' : 'Generate a secret'}
      </Button>
      {info.data.hasSecret && !secret && (
        <p className="text-xs text-muted-foreground">
          A secret is set. A new one stops the old one working.
        </p>
      )}
    </section>
  );
}
