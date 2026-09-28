'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Clock,
  Copy,
  Download,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Router,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { plural, timeAgo } from '@/lib/format';
import { useSites } from '@/lib/use-estate';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Gateway = RouterOutputs['gateway']['list'][number];

const IMAGE = process.env.NEXT_PUBLIC_GATEWAY_IMAGE ?? 'ghcr.io/steviemayo/kestrel-gateway:stable';
// The Windows installer (brings its own Node, no Docker needed; lets you pick service or tray at
// install time). Proxied through the portal by default since the release lives in a private repo.
const WINDOWS_SETUP_URL =
  process.env.NEXT_PUBLIC_GATEWAY_WINDOWS_URL ?? '/api/gateway/download?platform=windows';

function StatusPill({ status }: { status: Gateway['status'] }) {
  const tone = { online: 'bg-success', offline: 'bg-destructive', pending: 'bg-warning' }[status];
  const label = { online: 'Online', offline: 'Offline', pending: 'Waiting to enrol' }[status];
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span aria-hidden className={cn('size-2 rounded-full', tone)} />
      {label}
    </span>
  );
}

function runCommand(token: string) {
  return [
    'docker run -d --name kestrel-gateway --restart unless-stopped \\',
    '  -p 8080:8080 -v kestrel-data:/data \\',
    `  -e KESTREL_CLOUD_URL=${window.location.origin} \\`,
    `  -e KESTREL_ENROLL_TOKEN=${token} \\`,
    `  ${IMAGE}`,
  ].join('\n');
}

export function GatewaysView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canEdit } = useOrg();
  const gateways = useQuery({
    ...trpc.gateway.list.queryOptions({ orgId }),
    refetchInterval: 15_000,
  });
  const [adding, setAdding] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [token, setToken] = useState<{ name: string; token: string; expiresAt: Date } | null>(null);
  const [renaming, setRenaming] = useState<Gateway | null>(null);
  const [reenrolling, setReenrolling] = useState<Gateway | null>(null);
  const [deleting, setDeleting] = useState<Gateway | null>(null);
  const [updating, setUpdating] = useState<Gateway | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);
  // Behind, able to take a portal update, and nothing already asked of it.
  const updatable = (gateways.data ?? []).filter(
    (g) => g.update.status === 'behind' && g.canSelfUpdate && !g.updateVersion,
  );

  const refresh = () => qc.invalidateQueries({ queryKey: trpc.gateway.list.queryKey() });
  const reenrol = useMutation(
    trpc.gateway.regenerateToken.mutationOptions({
      onSuccess: async (res, vars) => {
        await refresh();
        setToken({
          name: gateways.data?.find((g) => g.id === vars.gatewayId)?.name ?? 'Gateway',
          ...res,
        });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setChannel = useMutation(
    trpc.gateway.setChannel.mutationOptions({
      onSuccess: async (_res, vars) => {
        await refresh();
        toast.success(
          vars.channel === 'beta'
            ? 'Marked as following beta. Run the beta image on that machine to match.'
            : 'Marked as following stable. Run the stable image on that machine to match.',
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const requestUpdate = useMutation(
    trpc.gateway.requestUpdate.mutationOptions({
      onSuccess: async (_res, vars) => {
        await refresh();
        toast.success(
          vars.at
            ? 'Update scheduled. The gateway starts it at its first check-in after that time.'
            : 'Update requested. The gateway starts it at its next check-in.',
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const cancelUpdate = useMutation(
    trpc.gateway.cancelUpdate.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Update cancelled');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setAutoUpdate = useMutation(
    trpc.gateway.setAutoUpdate.mutationOptions({
      onSuccess: async (_res, vars) => {
        await refresh();
        toast.success(
          vars.on
            ? 'Automatic updates on. The portal asks it to update as soon as a newer version is published.'
            : 'Automatic updates off. It only updates when you ask.',
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const del = useMutation(
    trpc.gateway.delete.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Gateway deleted');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <PageContainer>
      <PageHeader
        title="Gateways"
        description="On-site machines that run your rooms, keep them working offline and report their status."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setInstallOpen(true)}>
              <Download data-icon="inline-start" /> Install a gateway
            </Button>
            {canEdit && updatable.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setUpdatingAll(true)}>
                <RefreshCw data-icon="inline-start" /> Update {updatable.length} that{' '}
                {updatable.length === 1 ? 'is' : 'are'} behind
              </Button>
            )}
            {canEdit && (
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus data-icon="inline-start" /> Add gateway
              </Button>
            )}
          </>
        }
      />
      {gateways.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : gateways.data?.length === 0 ? (
        <EmptyState
          icon={Router}
          title="No gateways yet"
          description="Add a gateway, run the container on a machine at the site, and it will connect itself. Then assign rooms to it."
          action={
            canEdit ? <Button onClick={() => setAdding(true)}>Add a gateway</Button> : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Gateway</TableHead>
                <TableHead>Site</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Rooms</TableHead>
                <TableHead>Version</TableHead>
                <TableHead className="text-right">Last seen</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {gateways.data?.map((g) => (
                <TableRow key={g.id}>
                  <TableCell>
                    <div className="font-medium">{g.name}</div>
                    {g.hostname && (
                      <div className="text-xs text-muted-foreground">{g.hostname}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{g.site.name}</TableCell>
                  <TableCell>
                    <StatusPill status={g.status} />
                  </TableCell>
                  <TableCell
                    className="text-muted-foreground"
                    title={g.rooms.map((r) => r.name).join(', ')}
                  >
                    {plural(g.rooms.length, 'room')}
                  </TableCell>
                  <TableCell className="tabular text-muted-foreground">
                    <span className="inline-flex items-center gap-2">
                      {g.version ?? '—'}
                      {g.channel === 'beta' && <Badge variant="outline">beta</Badge>}
                      {g.autoUpdate && (
                        <Badge
                          variant="outline"
                          title="Updates itself as soon as a newer version is published"
                        >
                          auto
                        </Badge>
                      )}
                      <UpdateChip g={g} />
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {g.lastSeenAt ? timeAgo(g.lastSeenAt) : 'Never'}
                  </TableCell>
                  <TableCell>
                    {canEdit && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Actions for ${g.name}`}
                            />
                          }
                        >
                          <MoreHorizontal />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setRenaming(g)}>
                            <Pencil className="size-4" /> Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              setChannel.mutate({
                                orgId,
                                gatewayId: g.id,
                                channel: g.channel === 'beta' ? 'stable' : 'beta',
                              })
                            }
                          >
                            <Rocket className="size-4" />{' '}
                            {g.channel === 'beta'
                              ? 'Follow the stable channel'
                              : 'Follow the beta channel'}
                          </DropdownMenuItem>
                          {g.updateVersion ? (
                            <DropdownMenuItem
                              onClick={() => cancelUpdate.mutate({ orgId, gatewayId: g.id })}
                            >
                              <Clock className="size-4" />{' '}
                              {g.updateState === 'failed' || g.updateState === 'unsupported'
                                ? 'Clear the update'
                                : 'Cancel the update'}
                            </DropdownMenuItem>
                          ) : null}
                          {g.update.status === 'behind' &&
                            (!g.updateVersion || g.updateState === 'failed') && (
                              <DropdownMenuItem onClick={() => setUpdating(g)}>
                                <RefreshCw className="size-4" /> Update to {g.update.latest}…
                              </DropdownMenuItem>
                            )}
                          <DropdownMenuItem
                            onClick={() =>
                              setAutoUpdate.mutate({ orgId, gatewayId: g.id, on: !g.autoUpdate })
                            }
                          >
                            <Clock className="size-4" />{' '}
                            {g.autoUpdate
                              ? 'Turn off automatic updates'
                              : 'Turn on automatic updates'}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setReenrolling(g)}>
                            <RefreshCw className="size-4" /> Re-enrol on a new machine
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(g)}>
                            <Trash2 className="size-4" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AddDialog
        open={adding}
        onOpenChange={setAdding}
        onCreated={async (t) => {
          await refresh();
          setToken(t);
        }}
      />
      <InstallDialog open={installOpen} onOpenChange={setInstallOpen} />
      <TokenDialog token={token} onClose={() => setToken(null)} />
      <RenameDialog gateway={renaming} onClose={() => setRenaming(null)} onDone={refresh} />
      {updating && (
        <UpdateDialog
          gateway={updating}
          busy={requestUpdate.isPending}
          onClose={() => setUpdating(null)}
          onSubmit={(at) =>
            requestUpdate.mutate(
              { orgId, gatewayId: updating.id, ...(at ? { at } : {}) },
              { onSuccess: () => setUpdating(null) },
            )
          }
        />
      )}
      <ConfirmDialog
        open={updatingAll}
        onOpenChange={setUpdatingAll}
        title={`Update ${plural(updatable.length, 'gateway')}?`}
        description="Each one is asked at its next check-in and restarts once it has the new version. Rooms keep running from their cached releases while it restarts."
        confirmLabel="Update them"
        onConfirm={async () => {
          for (const g of updatable) {
            try {
              await requestUpdate.mutateAsync({ orgId, gatewayId: g.id });
            } catch {
              // the toast says why; carry on with the rest
            }
          }
        }}
      />
      <ConfirmDialog
        open={!!reenrolling}
        onOpenChange={(o) => !o && setReenrolling(null)}
        destructive
        title={`Re-enrol “${reenrolling?.name}”?`}
        description="The current machine loses its connection right away. You'll get a new token to run on the replacement; rooms keep running on the old one until then."
        confirmLabel="Generate new token"
        onConfirm={() => reenrolling && reenrol.mutate({ orgId, gatewayId: reenrolling.id })}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        destructive
        title={`Delete “${deleting?.name}”?`}
        description="Its rooms become unassigned. The machine keeps running what it has, but can no longer sync."
        confirmLabel="Delete gateway"
        onConfirm={() => deleting && del.mutate({ orgId, gatewayId: deleting.id })}
      />
    </PageContainer>
  );
}

function AddDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (t: { name: string; token: string; expiresAt: Date }) => void | Promise<void>;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const sites = useSites();
  const [name, setName] = useState('');
  const [site, setSite] = useState('');
  const siteId = site || sites.data?.[0]?.id || '';
  const create = useMutation(
    trpc.gateway.create.mutationOptions({
      onSuccess: async (res) => {
        onOpenChange(false);
        setName('');
        await onCreated({ name: res.name, token: res.token, expiresAt: res.expiresAt });
      },
    }),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {sites.isSuccess && sites.data.length === 0 ? (
          <DialogHeader>
            <DialogTitle>Create a site first</DialogTitle>
            <DialogDescription>
              A gateway belongs to a site. Add one from the Sites page.
            </DialogDescription>
          </DialogHeader>
        ) : (
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate({ orgId, siteId, name });
            }}
          >
            <DialogHeader>
              <DialogTitle>Add a gateway</DialogTitle>
              <DialogDescription>
                You’ll get a one-time token to run the gateway container with.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="gw-name">Name</Label>
              <Input
                id="gw-name"
                autoFocus
                required
                placeholder="Sydney comms room"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gw-site">Site</Label>
              <SimpleSelect
                id="gw-site"
                className="w-full"
                value={siteId}
                onValueChange={setSite}
                options={(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
              />
              <p className="text-xs text-muted-foreground">It can run rooms at this site.</p>
            </div>
            {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || !name.trim() || !siteId}>
                {create.isPending && <Spinner />}
                Create gateway
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CopyBox({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button
          variant="ghost"
          size="xs"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          }}
        >
          {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
        {text}
      </pre>
    </div>
  );
}

function PlatformInstall({ token }: { token?: string }) {
  const dockerCommand = runCommand(token ?? '<enrolment token>');
  return (
    <Tabs defaultValue="windows">
      <TabsList>
        <TabsTrigger value="windows">Windows</TabsTrigger>
        <TabsTrigger value="linux">Linux</TabsTrigger>
        <TabsTrigger value="docker">Docker</TabsTrigger>
      </TabsList>
      <TabsContent value="windows" className="space-y-3 pt-3">
        <p className="text-sm text-muted-foreground">
          The installer lets you choose to run the gateway as a Windows service (starts at boot,
          before anyone logs in) or from the system tray (starts when you log in). Either way it
          restarts on its own and keeps running until stopped.
        </p>
        <a href={WINDOWS_SETUP_URL} className={buttonVariants({ size: 'sm' })}>
          <Download data-icon="inline-start" /> Download for Windows
        </a>
      </TabsContent>
      <TabsContent value="linux" className="space-y-3 pt-3">
        <CopyBox
          label="Install Docker, if it isn't already"
          text="curl -fsSL https://get.docker.com | sh"
        />
        <CopyBox label="Run the gateway" text={dockerCommand} />
      </TabsContent>
      <TabsContent value="docker" className="space-y-3 pt-3">
        <CopyBox label="Run the gateway" text={dockerCommand} />
      </TabsContent>
      {!token && (
        <p className="text-xs text-muted-foreground">
          Replace <code className="font-mono">&lt;enrolment token&gt;</code> with the one-time token
          from “Add gateway”, or from a gateway's ⋯ menu — this box will have it filled in there.
        </p>
      )}
    </Tabs>
  );
}

function InstallDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Install a gateway</DialogTitle>
          <DialogDescription>
            Pick a platform. You'll still need a one-time enrolment token — get one from “Add
            gateway” above, or from an existing gateway's ⋯ menu.
          </DialogDescription>
        </DialogHeader>
        <PlatformInstall />
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TokenDialog({
  token,
  onClose,
}: {
  token: { name: string; token: string; expiresAt: Date } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!token} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        {token && (
          <div className="space-y-5">
            <DialogHeader>
              <DialogTitle>Run “{token.name}” on site</DialogTitle>
              <DialogDescription>
                The token works once and expires {timeAgo(token.expiresAt)}. It won’t be shown
                again. The gateway needs outbound HTTPS only; no ports need opening to the internet.
              </DialogDescription>
            </DialogHeader>
            <CopyBox label="Enrolment token" text={token.token} />
            <PlatformInstall token={token.token} />
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  gateway,
  onClose,
  onDone,
}: {
  gateway: Gateway | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [name, setName] = useState('');
  const rename = useMutation(
    trpc.gateway.rename.mutationOptions({
      onSuccess: () => {
        onDone();
        onClose();
      },
    }),
  );
  return (
    <Dialog
      open={!!gateway}
      onOpenChange={(o) => {
        if (o) setName(gateway?.name ?? '');
        else onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (gateway) rename.mutate({ orgId, gatewayId: gateway.id, name });
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename gateway</DialogTitle>
          </DialogHeader>
          <Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          {rename.error && <p className="text-sm text-destructive">{rename.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={rename.isPending || !name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** What is happening with the update someone asked for on this gateway, or that one is available. */
function UpdateChip({ g }: { g: Gateway }) {
  if (g.updateVersion) {
    const state = g.updateState;
    if (state === 'failed')
      return (
        <Badge variant="destructive" title={g.updateError ?? 'The update did not complete'}>
          Update failed
        </Badge>
      );
    if (state === 'unsupported')
      return (
        <Badge variant="outline" title={g.updateError ?? undefined}>
          Can’t update itself
        </Badge>
      );
    if (state === 'downloading' || state === 'staged' || state === 'applying')
      return <Badge variant="secondary">Updating to {g.updateVersion}…</Badge>;
    const due = g.updateNotBefore && new Date(g.updateNotBefore).getTime() > Date.now();
    return (
      <Badge variant="secondary">
        {due
          ? `Update to ${g.updateVersion} at ${new Date(g.updateNotBefore!).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`
          : `Update to ${g.updateVersion} requested`}
      </Badge>
    );
  }
  if (g.update.status !== 'behind') return null;
  return (
    <Badge
      variant="secondary"
      title={
        g.canSelfUpdate
          ? `Version ${g.update.latest} is available on the ${g.channel} channel`
          : `Version ${g.update.latest} is available. This gateway needs one manual update before the portal can update it.`
      }
    >
      Update available
    </Badge>
  );
}

function UpdateDialog({
  gateway,
  busy,
  onClose,
  onSubmit,
}: {
  gateway: Gateway;
  busy: boolean;
  onClose: () => void;
  onSubmit: (at: Date | null) => void;
}) {
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [local, setLocal] = useState('');
  const at = when === 'later' && local ? new Date(local) : null;
  const invalid =
    when === 'later' && (!at || Number.isNaN(at.getTime()) || at.getTime() < Date.now());
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Update {gateway.name} to {gateway.update.latest}
          </DialogTitle>
          <DialogDescription>
            {gateway.canSelfUpdate
              ? 'The gateway picks this up at a check-in, downloads the new version, restarts, and puts the old one back if the new one does not start. Rooms keep running from their cached releases while it restarts.'
              : 'This gateway is too old for the portal to update it. Install the latest version on that machine once by hand; after that the portal can do it.'}
          </DialogDescription>
        </DialogHeader>
        {gateway.canSelfUpdate && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={when === 'now' ? 'default' : 'outline'}
                onClick={() => setWhen('now')}
              >
                At its next check-in
              </Button>
              <Button
                type="button"
                size="sm"
                variant={when === 'later' ? 'default' : 'outline'}
                onClick={() => setWhen('later')}
              >
                <Clock data-icon="inline-start" /> At a set time
              </Button>
            </div>
            {when === 'later' && (
              <div className="space-y-1.5">
                <Label htmlFor="update-at">Not before (your local time)</Label>
                <Input
                  id="update-at"
                  type="datetime-local"
                  value={local}
                  onChange={(e) => setLocal(e.target.value)}
                />
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!gateway.canSelfUpdate || busy || invalid} onClick={() => onSubmit(at)}>
            {busy && <Spinner />}
            {when === 'later' ? 'Schedule the update' : 'Update'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
