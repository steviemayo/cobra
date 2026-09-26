'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, MoreHorizontal, Pencil, Plus, RefreshCw, Rocket, Router, Trash2 } from 'lucide-react';
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
import { plural, timeAgo } from '@/lib/format';
import { useSites } from '@/lib/use-estate';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Gateway = RouterOutputs['gateway']['list'][number];

const IMAGE = process.env.NEXT_PUBLIC_GATEWAY_IMAGE ?? 'ghcr.io/steviemayo/kestrel-gateway:stable';
// The self-contained Windows bundle (brings its own Node, no Docker needed), published by CI to the stable release.
const WINDOWS_BUNDLE =
  process.env.NEXT_PUBLIC_GATEWAY_WINDOWS_URL ??
  'https://github.com/steviemayo/cobra/releases/download/gateway-stable/kestrel-gateway-win-x64.zip';

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
  const gateways = useQuery({ ...trpc.gateway.list.queryOptions({ orgId }), refetchInterval: 15_000 });
  const [adding, setAdding] = useState(false);
  const [token, setToken] = useState<{ name: string; token: string; expiresAt: Date } | null>(null);
  const [renaming, setRenaming] = useState<Gateway | null>(null);
  const [reenrolling, setReenrolling] = useState<Gateway | null>(null);
  const [deleting, setDeleting] = useState<Gateway | null>(null);

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
            <a
              href={WINDOWS_BUNDLE}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              title="Self-contained gateway for Windows. No Docker needed"
            >
              <Download data-icon="inline-start" /> Windows bundle
            </a>
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
          action={canEdit ? <Button onClick={() => setAdding(true)}>Add a gateway</Button> : undefined}
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
                    {g.hostname && <div className="text-xs text-muted-foreground">{g.hostname}</div>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{g.site.name}</TableCell>
                  <TableCell>
                    <StatusPill status={g.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground" title={g.rooms.map((r) => r.name).join(', ')}>
                    {plural(g.rooms.length, 'room')}
                  </TableCell>
                  <TableCell className="tabular text-muted-foreground">
                    <span className="inline-flex items-center gap-2">
                      {g.version ?? '—'}
                      {g.channel === 'beta' && <Badge variant="outline">beta</Badge>}
                      {g.update.status === 'behind' && (
                        <Badge variant="secondary" title={`Version ${g.update.latest} is available on the ${g.channel} channel`}>
                          Update available
                        </Badge>
                      )}
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
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${g.name}`} />
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
                            {g.channel === 'beta' ? 'Follow the stable channel' : 'Follow the beta channel'}
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
      <TokenDialog token={token} onClose={() => setToken(null)} />
      <RenameDialog gateway={renaming} onClose={() => setRenaming(null)} onDone={refresh} />
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
            <DialogDescription>A gateway belongs to a site. Add one from the Sites page.</DialogDescription>
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
                The token works once and expires {timeAgo(token.expiresAt)}. It won’t be shown again. The gateway needs outbound HTTPS only; no ports need opening to the internet.
              </DialogDescription>
            </DialogHeader>
            <CopyBox label="Enrolment token" text={token.token} />
            <CopyBox label="Run on the gateway machine (Docker)" text={runCommand(token.token)} />
            <p className="text-xs text-muted-foreground">
              No Docker on the machine?{' '}
              <a className="underline underline-offset-4" href={WINDOWS_BUNDLE}>
                Download the Windows bundle
              </a>
              .
            </p>
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
