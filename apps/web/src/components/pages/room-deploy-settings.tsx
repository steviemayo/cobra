'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
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
        await Promise.all([invalidate(), qc.invalidateQueries({ queryKey: trpc.gateway.list.queryKey() })]);
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
        onValueChange={(v) =>
          assign.mutate({ orgId, roomId, gatewayId: v === NONE ? null : v })
        }
        disabled={assign.isPending}
        options={[
          { value: NONE, label: 'No gateway' },
          ...here.map((g) => ({ value: g.id, label: g.name })),
        ]}
      />
      {gateways.isSuccess && here.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No gateways at this site yet.{' '}
          <Link href={orgPath(orgId, '/gateways')} className="text-foreground underline-offset-4 hover:underline">
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
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [accent, setAccent] = useState('');
  const [logo, setLogo] = useState('');

  useEffect(() => {
    const p = current.data;
    if (!p) return;
    setMode(p.mode);
    setIps(p.trustedIps.join('\n'));
    setTheme(p.branding.mode);
    setAccent(p.branding.accent ?? '');
    setLogo(p.branding.logoUrl ?? '');
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
          branding: {
            mode: theme,
            language: 'en',
            ...(accent.trim() && { accent: accent.trim() }),
            ...(logo.trim() && { logoUrl: logo.trim() }),
          },
        });
      }}
    >
      <div>
        <h2 className="text-sm font-medium">Panel</h2>
        <p className="text-sm text-muted-foreground">
          Who can use this room’s touch panel on the local network, and how it looks. Applies from the
          next release.
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
              placeholder={current.data?.hasPin ? 'Leave blank to keep the current PIN' : 'e.g. 4821'}
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
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="panel-theme">Theme</Label>
          <SimpleSelect
            id="panel-theme"
            className="w-full"
            value={theme}
            onValueChange={setTheme}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="panel-accent">Accent colour</Label>
          <Input
            id="panel-accent"
            placeholder="#0f8a8c"
            value={accent}
            onChange={(e) => setAccent(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="panel-logo">Logo URL</Label>
          <Input
            id="panel-logo"
            type="url"
            placeholder="https://…/logo.svg"
            value={logo}
            onChange={(e) => setLogo(e.target.value)}
          />
        </div>
      </div>
      {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
      <Button type="submit" variant="outline" disabled={save.isPending}>
        {save.isPending && <Spinner />}
        Save panel settings
      </Button>
    </form>
  );
}
