'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, Copy, KeyRound, Link2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { dateTime } from '@/components/common/health';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { Section } from '@/components/common/section';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Connection = RouterOutputs['integration']['list']['integrations'][number];

/** What each vendor needs from the customer, and how they get it. Mirrors the server's credential schemas. */
const VENDORS: Record<
  string,
  {
    fields: {
      key: string;
      label: string;
      secret?: boolean;
      multiline?: boolean;
      optional?: boolean;
    }[];
    steps: string[];
    /** The vendor calls Kestrel, so there are no sign-in details to enter. */
    push?: boolean;
  }
> = {
  zoom: {
    fields: [
      { key: 'accountId', label: 'Account ID' },
      { key: 'clientId', label: 'Client ID' },
      { key: 'clientSecret', label: 'Client secret', secret: true },
    ],
    steps: [
      'In the Zoom App Marketplace, choose Develop, then Build App, then Server-to-Server OAuth.',
      'Add the scopes dashboard:read:list_zoomrooms:admin and room:read:list_rooms:admin.',
      'Activate the app, then copy its Account ID, Client ID and Client secret here.',
      'Zoom Rooms dashboard data needs a Zoom plan that includes the dashboard.',
    ],
  },
  teams: {
    push: true,
    fields: [],
    steps: [
      'Microsoft has no supported health API for Teams Rooms, so Teams sends Kestrel its alerts instead.',
      'After you connect, Kestrel shows a webhook address and a secret (shown once).',
      'In the Teams Rooms Pro Management portal, open Settings, then Integrations, then Create Incident Webhook. Paste the address and send the secret as a Bearer header, or add it to the address as ?secret=.',
      'Then pair each Teams room to a Kestrel device by its Pro Management device ID, or let Kestrel add rooms as they alert.',
    ],
  },
  logitech: {
    fields: [
      { key: 'orgId', label: 'Organization ID' },
      { key: 'certificate', label: 'Certificate (PEM)', multiline: true },
      { key: 'privateKey', label: 'Private key (PEM)', secret: true, multiline: true },
      {
        key: 'apiBase',
        label: 'API address (only if Logitech gave you a regional one)',
        optional: true,
      },
    ],
    steps: [
      'Sync Cloud API needs a Logitech Sync Plus, Essential or Select licence.',
      'In the Sync portal open Settings, then Sync Cloud API, and choose Generate new certificate.',
      'Download certificate.pem and privateKey.pem, and copy the Organization ID shown there (not the certificate name).',
      'Paste the contents of both files and the Organization ID here.',
    ],
  },
  reflect: {
    fields: [{ key: 'apiToken', label: 'API token', secret: true }],
    steps: [
      'Sign in to Q-SYS Reflect as an Organization Owner.',
      'Open the Organizations page and copy the API token.',
      'Paste it here. Kestrel will list your Cores and their status.',
    ],
  },
};

function CopyLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{value}</code>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Copy ${label}`}
          onClick={() =>
            void navigator.clipboard.writeText(value).then(() => toast.success('Copied'))
          }
        >
          <Copy />
        </Button>
      </div>
    </div>
  );
}

/** The address and secret a vendor sends events to. The secret is shown here once and never again. */
function WebhookDialog({
  id,
  name,
  secret,
  onClose,
}: {
  id: string;
  name: string;
  secret: string;
  onClose: () => void;
}) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{name}: webhook details</DialogTitle>
          <DialogDescription>Copy these now. The secret is shown only once.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <CopyLine
            label="Webhook address (POST, JSON)"
            value={`${origin}/api/integrations/${id}`}
          />
          <CopyLine label="Secret (Authorization: Bearer ...)" value={secret} />
          <p className="text-xs text-muted-foreground">
            If the sender can only set an address, add <code>?secret=</code> and the secret to the
            end of it. A header is safer, because addresses end up in logs.
          </p>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (r: { id: string; secret: string; name: string }) => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const providers = useQuery(trpc.integration.providers.queryOptions({ orgId }));
  const sites = useQuery(trpc.site.list.queryOptions({ orgId }));
  const [provider, setProvider] = useState('');
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [defaultSiteId, setDefaultSiteId] = useState('');
  const [autoCreate, setAutoCreate] = useState(false);
  const vendor = VENDORS[provider];
  const siteOptions = (sites.data ?? []).map((s) => ({ value: s.id, label: s.name }));
  const defaults = siteIds.length
    ? siteOptions.filter((s) => siteIds.includes(s.value))
    : siteOptions;

  const connect = useMutation(
    trpc.integration.connect.mutationOptions({
      onSuccess: async (r) => {
        toast.success('Connected');
        await qc.invalidateQueries({ queryKey: trpc.integration.list.queryKey() });
        if (r.secret) onCreated({ id: r.id, secret: r.secret, name: name.trim() });
        else onClose();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const ready =
    !!vendor &&
    name.trim().length > 0 &&
    vendor.fields.every((f) => f.optional || (values[f.key] ?? '').trim()) &&
    (!autoCreate || !!defaultSiteId);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect a cloud service</DialogTitle>
          <DialogDescription>
            Kestrel signs in once to check the details, then keeps the rooms it can see up to date.
            No gateway is needed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Service</Label>
            <SimpleSelect
              value={provider}
              onValueChange={(v) => {
                setProvider(v);
                setValues({});
                if (!name) setName((providers.data ?? []).find((p) => p.id === v)?.label ?? '');
              }}
              options={(providers.data ?? [])
                .filter((p) => VENDORS[p.id])
                .map((p) => ({ value: p.id, label: p.label }))}
              placeholder="Choose a service"
            />
          </div>
          {vendor && (
            <>
              <ol className="ml-5 list-decimal space-y-1 text-sm text-muted-foreground">
                {vendor.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              <div className="space-y-1.5">
                <Label htmlFor="conn-name">Name</Label>
                <Input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              {vendor.fields.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={`conn-${f.key}`}>{f.label}</Label>
                  {f.multiline ? (
                    <Textarea
                      id={`conn-${f.key}`}
                      rows={4}
                      spellCheck={false}
                      autoComplete="off"
                      className="font-mono text-xs"
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    />
                  ) : (
                    <Input
                      id={`conn-${f.key}`}
                      type={f.secret ? 'password' : 'text'}
                      autoComplete="off"
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    />
                  )}
                </div>
              ))}
              <div className="space-y-1.5">
                <Label>Limit to sites</Label>
                <p className="text-xs text-muted-foreground">
                  Leave all unticked to allow every site.
                </p>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {siteOptions.map((s) => (
                    <label key={s.value} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={siteIds.includes(s.value)}
                        onCheckedChange={(on) =>
                          setSiteIds(
                            on ? [...siteIds, s.value] : siteIds.filter((x) => x !== s.value),
                          )
                        }
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
              </div>
              <label className="flex items-start gap-3 text-sm">
                <Switch checked={autoCreate} onCheckedChange={setAutoCreate} />
                <span>
                  Create rooms automatically
                  <span className="block text-xs text-muted-foreground">
                    Off: only devices you pair by hand are updated. On: every room found is added as
                    a monitored room.
                  </span>
                </span>
              </label>
              {autoCreate && (
                <div className="space-y-1.5">
                  <Label>Put new rooms in</Label>
                  <SimpleSelect
                    value={defaultSiteId}
                    onValueChange={setDefaultSiteId}
                    options={defaults}
                    placeholder="Choose a site"
                  />
                </div>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!ready || connect.isPending}
            onClick={() =>
              connect.mutate({
                orgId,
                provider,
                name: name.trim(),
                credentials: Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())),
                siteIds,
                defaultSiteId: autoCreate ? defaultSiteId : null,
                autoCreate,
              })
            }
          >
            {connect.isPending ? 'Checking…' : 'Connect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PairDialog({ connection, onClose }: { connection: Connection; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const found = useQuery(
    trpc.integration.discover.queryOptions({ orgId, id: connection.id }, { retry: false }),
  );
  const [manualId, setManualId] = useState('');
  const [manualDevice, setManualDevice] = useState('');
  const devices = useQuery(trpc.device.list.queryOptions({ orgId }));
  const [picked, setPicked] = useState<Record<string, string>>({});
  const free = (devices.data ?? []).filter(
    (d) =>
      !d.control &&
      !('integrationId' in d && d.integrationId) &&
      (connection.siteIds.length === 0 || connection.siteIds.includes(d.siteId)),
  );
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: trpc.integration.discover.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.integration.list.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.device.list.queryKey() }),
    ]);
  };
  const pair = useMutation(
    trpc.integration.pair.mutationOptions({
      onSuccess: async () => {
        toast.success('Paired');
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const unpair = useMutation(
    trpc.integration.unpair.mutationOptions({
      onSuccess: async () => {
        toast.success('Unpaired');
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Pair rooms from {connection.name}</DialogTitle>
          <DialogDescription>
            Link a room system the service can see to a device you already track. Its status then
            comes from the service, with no gateway.
          </DialogDescription>
        </DialogHeader>
        {connection.push ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Enter the room's device ID from the Pro Management portal (or its room account
              address) and choose the Kestrel device it is. Rooms that alert before they are paired
              are added automatically only if this connection is set to create rooms.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="pair-id">Device ID</Label>
              <Input id="pair-id" value={manualId} onChange={(e) => setManualId(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Kestrel device</Label>
              <SimpleSelect
                value={manualDevice}
                onValueChange={setManualDevice}
                options={free.map((x) => ({ value: x.id, label: x.name }))}
                placeholder="Choose a device"
              />
            </div>
            <Button
              disabled={!manualId.trim() || !manualDevice || pair.isPending}
              onClick={() =>
                pair.mutate(
                  {
                    orgId,
                    id: connection.id,
                    deviceId: manualDevice,
                    externalId: manualId.trim(),
                  },
                  {
                    onSuccess: () => {
                      setManualId('');
                      setManualDevice('');
                    },
                  },
                )
              }
            >
              Pair
            </Button>
          </div>
        ) : found.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : found.isError ? (
          <p className="text-sm text-destructive">{found.error.message}</p>
        ) : found.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">The service did not list anything.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {found.data.map((d) => (
              <li key={d.externalId} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{d.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {d.online === null ? 'Status unknown' : d.online ? 'Online' : 'Offline'}
                    {d.model ? ` · ${d.model}` : ''}
                  </div>
                </div>
                {d.pairedDeviceId ? (
                  <>
                    <Badge variant="secondary">Paired to {d.pairedDeviceName}</Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={unpair.isPending}
                      onClick={() => unpair.mutate({ orgId, deviceId: d.pairedDeviceId! })}
                    >
                      Unpair
                    </Button>
                  </>
                ) : (
                  <>
                    <SimpleSelect
                      className="w-48"
                      value={picked[d.externalId] ?? ''}
                      onValueChange={(v) => setPicked({ ...picked, [d.externalId]: v })}
                      options={free.map((x) => ({ value: x.id, label: x.name }))}
                      placeholder="Choose a device"
                    />
                    <Button
                      size="sm"
                      disabled={!picked[d.externalId] || pair.isPending}
                      onClick={() =>
                        pair.mutate({
                          orgId,
                          id: connection.id,
                          deviceId: picked[d.externalId]!,
                          externalId: d.externalId,
                        })
                      }
                    >
                      Pair
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  c,
  onPair,
  onSecret,
}: {
  c: Connection;
  onPair: () => void;
  onSecret: (r: { id: string; secret: string; name: string }) => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, isOwner } = useOrg();
  const [removing, setRemoving] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.integration.list.queryKey() });
  const update = useMutation(
    trpc.integration.update.mutationOptions({
      onSuccess: refresh,
      onError: (e) => toast.error(e.message),
    }),
  );
  const sync = useMutation(
    trpc.integration.syncNow.mutationOptions({
      onSuccess: async (r) => {
        if (r.ok)
          toast.success(
            `Read ${r.seen} rooms: ${r.updated} updated, ${r.created} added, ${r.skipped} not paired`,
          );
        else toast.error(r.error ?? 'The sync failed');
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const rotate = useMutation(
    trpc.integration.rotateSecret.mutationOptions({
      onSuccess: (r) => onSecret({ id: c.id, secret: r.secret, name: c.name }),
      onError: (e) => toast.error(e.message),
    }),
  );
  const remove = useMutation(
    trpc.integration.remove.mutationOptions({
      onSuccess: async () => {
        toast.success('Removed');
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <li className="flex flex-wrap items-center gap-3 p-4">
      <Cloud className="size-5 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{c.name}</span>
          <Badge variant="secondary">{c.label}</Badge>
          {c.lastError ? (
            <Badge variant="destructive">Needs attention</Badge>
          ) : c.lastOkAt ? (
            <Badge variant="outline">Working</Badge>
          ) : (
            <Badge variant="outline">Not read yet</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {c.devices} {c.devices === 1 ? 'device' : 'devices'} ·{' '}
          {c.siteIds.length ? `${c.siteIds.length} sites` : 'all sites'} ·{' '}
          {c.autoCreate ? 'adds rooms automatically' : 'paired devices only'}
          {c.lastOkAt ? ` · last read ${dateTime(c.lastOkAt)}` : ''}
        </p>
        {c.lastError && <p className="text-xs text-destructive">{c.lastError}</p>}
      </div>
      <Switch
        aria-label="Enabled"
        checked={c.enabled}
        disabled={!isOwner}
        onCheckedChange={(enabled) => update.mutate({ orgId, id: c.id, enabled })}
      />
      <Button size="sm" variant="outline" onClick={onPair}>
        <Link2 className="size-4" /> Pair
      </Button>
      {c.push ? (
        isOwner && (
          <Button
            size="sm"
            variant="outline"
            disabled={rotate.isPending}
            onClick={() => rotate.mutate({ orgId, id: c.id })}
          >
            <KeyRound className="size-4" /> New secret
          </Button>
        )
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={sync.isPending}
          onClick={() => sync.mutate({ orgId, id: c.id })}
        >
          <RefreshCw className="size-4" /> Read now
        </Button>
      )}
      {isOwner && (
        <Button size="icon" variant="ghost" aria-label="Remove" onClick={() => setRemoving(true)}>
          <Trash2 className="size-4" />
        </Button>
      )}
      {removing && (
        <ConfirmDialog
          open
          title={`Remove ${c.name}?`}
          description="Paired devices keep what they last read but stop updating. You can connect again later."
          confirmLabel="Remove"
          destructive
          onConfirm={() => remove.mutate({ orgId, id: c.id })}
          onOpenChange={setRemoving}
        />
      )}
    </li>
  );
}

export function ConnectionsView() {
  const trpc = useTRPC();
  const { orgId, isOwner } = useOrg();
  const list = useQuery(trpc.integration.list.queryOptions({ orgId }));
  const [connecting, setConnecting] = useState(false);
  const [pairing, setPairing] = useState<Connection | null>(null);
  const [secret, setSecret] = useState<{ id: string; secret: string; name: string } | null>(null);

  return (
    <PageContainer>
      <PageHeader
        title="Cloud connections"
        description="Read room health straight from a vendor's cloud, with no gateway on site."
        actions={
          isOwner && (
            <Button onClick={() => setConnecting(true)} disabled={list.data?.available === false}>
              <Plus className="size-4" /> Connect
            </Button>
          )
        }
      />
      {list.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : list.isError ? (
        <p className="text-sm text-destructive">{list.error.message}</p>
      ) : (
        <>
          {!list.data.available && (
            <p className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
              This Kestrel server has no secrets key set, so connections cannot be saved yet.
            </p>
          )}
          {list.data.integrations.length === 0 ? (
            <EmptyState
              icon={Cloud}
              title="No connections yet"
              description="Connect Zoom Rooms, Q-SYS Reflect or Teams Rooms to monitor rooms that have no gateway."
            />
          ) : (
            <Section title="Connections">
              <ul className="divide-y">
                {list.data.integrations.map((c) => (
                  <Row key={c.id} c={c} onPair={() => setPairing(c)} onSecret={setSecret} />
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
      {connecting && (
        <ConnectDialog
          onClose={() => setConnecting(false)}
          onCreated={(r) => {
            setConnecting(false);
            setSecret(r);
          }}
        />
      )}
      {secret && (
        <WebhookDialog
          id={secret.id}
          name={secret.name}
          secret={secret.secret}
          onClose={() => setSecret(null)}
        />
      )}
      {pairing && <PairDialog connection={pairing} onClose={() => setPairing(null)} />}
    </PageContainer>
  );
}
