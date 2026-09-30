'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Handshake, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/common/empty-state';
import { HealthPill } from '@/components/common/health';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { ProviderBrandSetting } from '@/components/common/provider-brand-setting';
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
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Customer = RouterOutputs['msp']['portfolio']['customers'][number];

const ROLE_WORDS: Record<string, string> = {
  manage: 'Manage',
  support: 'Support',
  view: 'View only',
};

const HEALTH_LEVEL = {
  down: 'down',
  degraded: 'degraded',
  healthy: 'healthy',
  unknown: 'unknown',
} as const;
const HEALTH_RANK: Record<string, number> = { down: 0, degraded: 1, unknown: 2, healthy: 3 };

function NewCustomerDialog({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [made, setMade] = useState<{ id: string; inviteToken: string | null } | null>(null);
  const create = useMutation(
    trpc.msp.createCustomer.mutationOptions({
      onSuccess: async (r) => {
        setMade(r);
        await qc.invalidateQueries({ queryKey: trpc.msp.portfolio.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const link =
    made?.inviteToken && typeof window !== 'undefined'
      ? `${window.location.origin}/invite/${made.inviteToken}`
      : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{made ? 'Customer created' : 'New customer'}</DialogTitle>
          <DialogDescription>
            {made
              ? 'You can work in it now. Send the link to the customer’s owner to hand it over.'
              : 'Set up a customer on their behalf. You look after it straight away, and the owner you invite takes it over when they accept.'}
          </DialogDescription>
        </DialogHeader>
        {made ? (
          <div className="space-y-3 text-sm">
            <Link href={orgPath(made.id)} className="font-medium underline">
              Open the customer
            </Link>
            {link && (
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  Invitation link for the owner (shown once, valid for 14 days)
                </div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                    {link}
                  </code>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Copy link"
                    onClick={() =>
                      void navigator.clipboard.writeText(link).then(() => toast.success('Copied'))
                    }
                  >
                    <Copy />
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Customer name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Owner&apos;s email (optional)</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@customer.com"
              />
            </div>
          </div>
        )}
        <DialogFooter>
          {made ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                disabled={!name.trim() || create.isPending}
                onClick={() =>
                  create.mutate({ orgId, name: name.trim(), ownerEmail: email.trim() || null })
                }
              >
                Create
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CustomerNotesDialog({ c, onClose }: { c: Customer; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const [manager, setManager] = useState(c.accountManager ?? '');
  const [tags, setTags] = useState(c.tags.join(', '));
  const save = useMutation(
    trpc.msp.updateCustomer.mutationOptions({
      onSuccess: async () => {
        toast.success('Saved');
        await qc.invalidateQueries({ queryKey: trpc.msp.portfolio.queryKey() });
        onClose();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{c.name}</DialogTitle>
          <DialogDescription>Your own notes. The customer does not see these.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Account manager</Label>
            <Input value={manager} onChange={(e) => setManager(e.target.value)} maxLength={80} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Tags, separated by commas</Label>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="gold, victoria"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                orgId,
                grantId: c.grantId,
                accountManager: manager || null,
                tags: tags
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean),
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A service provider's home: every customer at a glance, invitations, and how customers find it. */
export function MspDashboard() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, isOwner } = useOrg();
  const data = useQuery({ ...trpc.msp.portfolio.queryOptions({ orgId }), refetchInterval: 30_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.msp.portfolio.queryKey({ orgId }) });
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [manager, setManager] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const respond = useMutation(
    trpc.msp.respond.mutationOptions({
      onSuccess: async (_r, vars) => {
        await refresh();
        toast.success(vars.accept ? 'Connected' : 'Declined');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const end = useMutation(
    trpc.msp.endCustomer.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Connection ended');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success('Code copied');
    } catch {
      toast.error('Could not copy. Select the code and copy it by hand');
    }
  };

  const customers = useMemo(() => data.data?.customers ?? [], [data.data]);
  const allTags = useMemo(() => [...new Set(customers.flatMap((c) => c.tags))].sort(), [customers]);
  const managers = useMemo(
    () =>
      [...new Set(customers.map((c) => c.accountManager).filter((m): m is string => !!m))].sort(),
    [customers],
  );
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customers
      .filter((c) => !tag || c.tags.includes(tag))
      .filter((c) => !manager || c.accountManager === manager)
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort(
        (a, b) => HEALTH_RANK[a.health]! - HEALTH_RANK[b.health]! || a.name.localeCompare(b.name),
      );
  }, [customers, search, tag, manager]);

  if (data.isPending)
    return (
      <PageContainer>
        <Skeleton className="h-48 w-full" />
      </PageContainer>
    );
  if (data.error || !data.data)
    return (
      <PageContainer>
        <p className="text-sm text-destructive">{data.error?.message ?? 'Not available'}</p>
      </PageContainer>
    );
  const d = data.data;
  const sum = (f: (c: Customer) => number) => customers.reduce((n, c) => n + f(c), 0);

  return (
    <PageContainer>
      <PageHeader
        title="Customers"
        description="Every organisation you look after, with what needs you. Open one to work in it with the access they gave you. Your own rooms are under Internal estate."
        actions={
          isOwner && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus data-icon="inline-start" /> New customer
            </Button>
          )
        }
      />

      {customers.length > 0 && (
        <div className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-lg border sm:grid-cols-4 sm:divide-y-0">
          {[
            ['Customers', customers.length, `${sum((c) => c.rooms)} rooms`],
            [
              'Live incidents',
              sum((c) => c.liveIncidents),
              `${sum((c) => c.criticalIncidents)} critical`,
            ],
            [
              'Rooms needing attention',
              sum((c) => c.roomsNeedingAttention),
              `${customers.filter((c) => c.health === 'down' || c.health === 'degraded').length} customers affected`,
            ],
            [
              'Tickets with you',
              sum((c) => c.ticketsWithUs),
              `${sum((c) => c.pmOverdue)} maintenance overdue`,
            ],
          ].map(([label, value, hint]) => (
            <div key={String(label)} className="px-4 py-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="tabular mt-1 text-2xl font-semibold tracking-tight">{value}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
            </div>
          ))}
        </div>
      )}

      {d.invites.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">Waiting for you</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {d.invites.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div>
                  <div className="font-medium">{i.customerName}</div>
                  <div className="text-xs text-muted-foreground">
                    Wants you to have {ROLE_WORDS[i.role]?.toLowerCase()} access to{' '}
                    {i.siteCount === 0
                      ? 'the whole organisation'
                      : `${i.siteCount} ${i.siteCount === 1 ? 'site' : 'sites'}`}
                    {i.invitedByEmail ? ` · invited by ${i.invitedByEmail}` : ''} ·{' '}
                    {timeAgo(i.createdAt)}
                  </div>
                </div>
                {isOwner ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={respond.isPending}
                      onClick={() => respond.mutate({ orgId, grantId: i.id, accept: true })}
                    >
                      <Check data-icon="inline-start" /> Accept
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={respond.isPending}
                      onClick={() => respond.mutate({ orgId, grantId: i.id, accept: false })}
                    >
                      Decline
                    </Button>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">An owner needs to answer</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {customers.length === 0 ? (
        <EmptyState
          icon={Handshake}
          title="No customers yet"
          description="When a customer invites you and you accept, they appear here. Or set one up yourself."
          action={
            isOwner ? <Button onClick={() => setCreating(true)}>New customer</Button> : undefined
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1 sm:max-w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search customers"
                className="h-8 pl-8"
                aria-label="Search customers"
              />
            </div>
            {allTags.length > 0 && (
              <SimpleSelect
                size="sm"
                className="w-36"
                value={tag}
                placeholder="Any tag"
                onValueChange={(v) => setTag(v === '__all' ? '' : v)}
                options={[
                  { value: '__all', label: 'Any tag' },
                  ...allTags.map((t) => ({ value: t, label: t })),
                ]}
              />
            )}
            {managers.length > 0 && (
              <SimpleSelect
                size="sm"
                className="w-44"
                value={manager}
                placeholder="Any account manager"
                onValueChange={(v) => setManager(v === '__all' ? '' : v)}
                options={[
                  { value: '__all', label: 'Any account manager' },
                  ...managers.map((m) => ({ value: m, label: m })),
                ]}
              />
            )}
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 text-right font-medium">Rooms online</th>
                  <th className="px-3 py-2 text-right font-medium">Devices online</th>
                  <th className="px-3 py-2 text-right font-medium">Incidents</th>
                  <th className="px-3 py-2 text-right font-medium">Gateways</th>
                  <th className="px-3 py-2 text-right font-medium">Drift</th>
                  <th className="px-3 py-2 text-right font-medium">PM overdue</th>
                  <th className="px-3 py-2 text-right font-medium">Tickets</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {shown.map((c) => (
                  <tr key={c.grantId} className="hover:bg-muted/40">
                    <td className="px-3 py-2">
                      <HealthPill level={HEALTH_LEVEL[c.health]} />
                    </td>
                    <td className="px-3 py-2">
                      <Link href={orgPath(c.orgId)} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {ROLE_WORDS[c.role]}
                        {c.limitedToSites > 0 &&
                          ` · ${c.limitedToSites} ${c.limitedToSites === 1 ? 'site' : 'sites'}`}
                        {c.accountManager && ` · ${c.accountManager}`}
                        {c.endsAt && ` · ends ${formatDate(c.endsAt)}`}
                        {c.tags.map((t) => (
                          <Badge key={t} variant="outline" className="font-normal">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="tabular px-3 py-2 text-right">
                      {c.roomsMonitored ? `${c.roomsOnline} of ${c.roomsMonitored}` : '–'}
                    </td>
                    <td className="tabular px-3 py-2 text-right">
                      {c.devicesActive ? `${c.devicesOnline} of ${c.devicesActive}` : '–'}
                    </td>
                    <td
                      className={cn(
                        'tabular px-3 py-2 text-right',
                        c.criticalIncidents > 0
                          ? 'font-medium text-destructive'
                          : c.liveIncidents > 0 && 'text-warning',
                      )}
                    >
                      {c.liveIncidents}
                    </td>
                    <td
                      className={cn(
                        'tabular px-3 py-2 text-right',
                        c.gateways > c.gatewaysOnline && 'text-warning',
                      )}
                    >
                      {c.gatewaysOnline}/{c.gateways}
                    </td>
                    <td
                      className={cn(
                        'tabular px-3 py-2 text-right',
                        c.driftCount > 0 && 'text-warning',
                      )}
                    >
                      {c.driftCount}
                    </td>
                    <td
                      className={cn(
                        'tabular px-3 py-2 text-right',
                        c.pmOverdue > 0 && 'text-warning',
                      )}
                    >
                      {c.pmOverdue}
                    </td>
                    <td className="tabular px-3 py-2 text-right">{c.ticketsWithUs}</td>
                    <td className="px-3 py-2 text-right">
                      <Button size="xs" variant="ghost" onClick={() => setEditing(c)}>
                        Notes
                      </Button>
                      {isOwner && (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={end.isPending}
                          onClick={() => {
                            if (window.confirm(`End your connection with ${c.name}?`))
                              end.mutate({ orgId, grantId: c.grantId });
                          }}
                        >
                          End
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <section className="space-y-2 rounded-lg border p-4">
        <div className="text-sm font-medium">Your provider code</div>
        <p className="text-sm text-muted-foreground">
          Give this to a customer. Their owner enters it under Settings, Service providers, and you
          are asked to accept.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-muted px-2 py-1 text-sm break-all">{d.providerCode}</code>
          <Button size="sm" variant="outline" onClick={() => copy(d.providerCode)}>
            <Copy data-icon="inline-start" /> Copy
          </Button>
        </div>
      </section>

      <ProviderBrandSetting />
      {creating && <NewCustomerDialog onClose={() => setCreating(false)} />}
      {editing && <CustomerNotesDialog c={editing} onClose={() => setEditing(null)} />}
    </PageContainer>
  );
}
