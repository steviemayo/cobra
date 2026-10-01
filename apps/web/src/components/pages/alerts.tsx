'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, MoreHorizontal, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { SEVERITY_LABEL, dateTime } from '@/components/common/health';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { useBilling } from '@/components/common/plan-gate';
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
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { RulesFields, draftFromRules, draftProblem, rulesFromDraft } from './alert-rules-fields';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Channel = RouterOutputs['alert']['channels'][number];
type Severity = 'info' | 'warning' | 'critical';
type ChannelType = 'email' | 'teams' | 'webhook' | 'itsm';

const TYPE_LABEL: Record<string, string> = {
  email: 'Email',
  teams: 'Microsoft Teams',
  webhook: 'Webhook',
  itsm: 'Service desk (ITSM)',
};
const DELIVERY_TONE: Record<string, string> = {
  sent: 'bg-success',
  failed: 'bg-destructive',
  suppressed: 'bg-warning',
  skipped: 'bg-muted-foreground/35',
};
const DELIVERY_LABEL: Record<string, string> = {
  sent: 'Sent',
  failed: 'Failed',
  suppressed: 'Held back',
  skipped: 'Not set up',
};

function DeliveryPill({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DELIVERY_TONE[status])} />
      {DELIVERY_LABEL[status] ?? status}
    </span>
  );
}

export function AlertsView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canEdit } = useOrg();
  const channels = useQuery({
    ...trpc.alert.channels.queryOptions({ orgId }),
    refetchInterval: 15_000,
  });
  const deliveries = useQuery({
    ...trpc.alert.deliveries.queryOptions({ orgId }),
    refetchInterval: 15_000,
  });
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  const [timing, setTiming] = useState<Channel | null>(null);
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.alert.channels.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.alert.deliveries.queryKey() }),
    ]);

  const toggle = useMutation(
    trpc.alert.update.mutationOptions({
      onSuccess: refresh,
      onError: (e) => toast.error(e.message),
    }),
  );
  const del = useMutation(
    trpc.alert.delete.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Channel removed');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const test = useMutation(
    trpc.alert.test.mutationOptions({
      onSuccess: async (res) => {
        await refresh();
        if (res.status === 'sent') toast.success('Test alert sent');
        else toast.error(res.error ?? 'The test alert could not be sent');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <PageContainer>
      <PageHeader
        title="Alerts"
        description="Where Kestrel tells you when something goes wrong, and when it’s fixed."
        actions={
          canEdit && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus data-icon="inline-start" /> Add channel
            </Button>
          )
        }
      />

      {channels.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : channels.data?.length === 0 ? (
        <EmptyState
          icon={BellRing}
          title="No alert channels yet"
          description="Add an email address, a Teams channel or a webhook and Kestrel will message it when a room, device or gateway has a problem."
          action={
            canEdit ? <Button onClick={() => setAdding(true)}>Add a channel</Button> : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Channel</TableHead>
                <TableHead>Sends to</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Last alert</TableHead>
                {canEdit && <TableHead className="w-24">On</TableHead>}
                {canEdit && <TableHead className="w-12" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {channels.data?.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {TYPE_LABEL[c.type] ?? c.type}
                      {c.locked && ' · paused, needs Pro'}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground">
                    {c.summary}
                    {c.hasSecret && <span className="ml-2 text-xs">(signed)</span>}
                    {c.rulesText && <div className="whitespace-normal text-xs">{c.rulesText}</div>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {SEVERITY_LABEL[c.minSeverity]} and up
                  </TableCell>
                  <TableCell>
                    {c.lastDelivery ? (
                      <div title={c.lastDelivery.error ?? undefined}>
                        <DeliveryPill status={c.lastDelivery.status} />
                        <div className="text-xs text-muted-foreground">
                          {dateTime(c.lastDelivery.at)}
                        </div>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">None yet</span>
                    )}
                  </TableCell>
                  {canEdit && (
                    <TableCell>
                      <Switch
                        size="sm"
                        aria-label={`${c.name} enabled`}
                        checked={c.enabled}
                        onCheckedChange={(enabled) =>
                          toggle.mutate({ orgId, channelId: c.id, enabled })
                        }
                      />
                    </TableCell>
                  )}
                  {canEdit && (
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Actions for ${c.name}`}
                            />
                          }
                        >
                          <MoreHorizontal />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => test.mutate({ orgId, channelId: c.id })}>
                            Send a test alert
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setTiming(c)}>
                            Timing and escalation…
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(c)}>
                            Remove channel
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Recent alerts</h2>
        {deliveries.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has been sent yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableBody>
                {deliveries.data?.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="w-44 text-muted-foreground">{dateTime(d.at)}</TableCell>
                    <TableCell>{d.channel}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {d.event === 'opened'
                        ? 'Problem'
                        : d.event === 'reminder'
                          ? 'Reminder'
                          : d.event === 'resolved'
                            ? 'Fixed'
                            : 'Test'}
                    </TableCell>
                    <TableCell title={d.error ?? undefined}>
                      <DeliveryPill status={d.status} />
                      {d.error && <div className="text-xs text-muted-foreground">{d.error}</div>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {adding && <AddChannelDialog open onOpenChange={setAdding} onDone={refresh} />}
      {timing && (
        <TimingDialog
          channel={timing}
          onOpenChange={(o) => !o && setTiming(null)}
          onDone={refresh}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        destructive
        title={`Remove “${deleting?.name}”?`}
        description="Alerts will stop going to it. Past deliveries are kept in the log."
        confirmLabel="Remove channel"
        onConfirm={() => deleting && del.mutate({ orgId, channelId: deleting.id })}
      />
    </PageContainer>
  );
}

function AddChannelDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => Promise<unknown>;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  // Basic keeps email only; the other channels need Pro.
  const allChannels = useBilling().data?.entitlements.allAlertChannels ?? true;
  const [type, setType] = useState<ChannelType>('email');
  const [name, setName] = useState('');
  const [minSeverity, setMinSeverity] = useState<Severity>('warning');
  const [emails, setEmails] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [system, setSystem] = useState<'generic' | 'servicenow' | 'jira'>('generic');
  const [rules, setRules] = useState(() => draftFromRules(null));

  const create = useMutation(
    trpc.alert.create.mutationOptions({
      onSuccess: async () => {
        await onDone();
        toast.success('Channel added. Send a test alert to check it works');
        onOpenChange(false);
      },
    }),
  );

  const timing = rulesFromDraft(rules);
  const config = () => {
    const extra = timing ? { rules: timing } : {};
    switch (type) {
      case 'email':
        return { type, to: emails.split(/[\s,;]+/).filter(Boolean), ...extra };
      case 'teams':
        return { type, url, ...extra };
      case 'webhook':
        return { type, url, ...(secret ? { secret } : {}), ...extra };
      case 'itsm':
        return { type, system, ...(url ? { url } : {}), ...extra };
    }
  };
  const ready =
    name.trim() &&
    (type === 'email' ? emails.trim() : type === 'itsm' || url.trim()) &&
    !draftProblem(rules);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ orgId, name, minSeverity, config: config() });
          }}
        >
          <DialogHeader>
            <DialogTitle>Add an alert channel</DialogTitle>
            <DialogDescription>Choose where alerts should go.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ch-type">Type</Label>
              <SimpleSelect
                id="ch-type"
                className="w-full"
                value={type}
                onValueChange={setType}
                options={Object.entries(TYPE_LABEL).map(([value, label]) => ({
                  value: value as ChannelType,
                  label: value === 'email' || allChannels ? label : `${label} (Pro)`,
                  disabled: value !== 'email' && !allChannels,
                }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ch-sev">Alert me from</Label>
              <SimpleSelect
                id="ch-sev"
                className="w-full"
                value={minSeverity}
                onValueChange={setMinSeverity}
                options={(['info', 'warning', 'critical'] as const).map((value) => ({
                  value,
                  label: `${SEVERITY_LABEL[value]} and up`,
                }))}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ch-name">Name</Label>
            <Input
              id="ch-name"
              autoFocus
              required
              placeholder="AV support team"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {type === 'email' && (
            <div className="space-y-2">
              <Label htmlFor="ch-emails">Email addresses</Label>
              <Input
                id="ch-emails"
                required
                placeholder="ops@example.com, oncall@example.com"
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Separate several with commas.</p>
            </div>
          )}
          {type !== 'email' && (
            <div className="space-y-2">
              <Label htmlFor="ch-url">
                {type === 'teams'
                  ? 'Teams webhook address'
                  : type === 'itsm'
                    ? 'Service desk address (optional for now)'
                    : 'Webhook address'}
              </Label>
              <Input
                id="ch-url"
                type="url"
                required={type !== 'itsm'}
                placeholder="https://"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Must be a public https address.</p>
            </div>
          )}
          {type === 'webhook' && (
            <div className="space-y-2">
              <Label htmlFor="ch-secret">Signing secret (optional)</Label>
              <Input
                id="ch-secret"
                type="password"
                autoComplete="off"
                minLength={8}
                placeholder="At least 8 characters"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Each request carries an HMAC-SHA256 signature in the X-Kestrel-Signature header so
                you can check it came from Kestrel.
              </p>
            </div>
          )}
          {type === 'itsm' && (
            <div className="space-y-2">
              <Label htmlFor="ch-system">Service desk</Label>
              <SimpleSelect
                id="ch-system"
                className="w-full"
                value={system}
                onValueChange={setSystem}
                options={[
                  { value: 'generic', label: 'Generic' },
                  { value: 'servicenow', label: 'ServiceNow' },
                  { value: 'jira', label: 'Jira Service Management' },
                ]}
              />
              <p className="text-xs text-muted-foreground">
                A placeholder for now: Kestrel sends a ticket-shaped webhook that your service desk
                can map.
              </p>
            </div>
          )}
          <details className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">
              Timing and escalation (optional)
            </summary>
            <div className="pt-3">
              <RulesFields value={rules} onChange={setRules} />
            </div>
          </details>
          {create.error && <p className="text-sm text-destructive">{create.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !ready}>
              {create.isPending && <Spinner />}
              Add channel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** When an existing channel may alert, and how it escalates. */
function TimingDialog({
  channel,
  onOpenChange,
  onDone,
}: {
  channel: Channel;
  onOpenChange: (o: boolean) => void;
  onDone: () => Promise<unknown>;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [draft, setDraft] = useState(() => draftFromRules(channel.rules));
  const save = useMutation(
    trpc.alert.setRules.mutationOptions({
      onSuccess: async () => {
        await onDone();
        toast.success('Timing saved');
        onOpenChange(false);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ orgId, channelId: channel.id, rules: rulesFromDraft(draft) });
          }}
        >
          <DialogHeader>
            <DialogTitle>Timing and escalation</DialogTitle>
            <DialogDescription>
              When “{channel.name}” may alert, and whether it waits or repeats. With nothing set it
              alerts straight away, at any time. For an on-call rota, add a channel for each person
              and give each their days and hours.
            </DialogDescription>
          </DialogHeader>
          <RulesFields value={draft} onChange={setDraft} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || !!draftProblem(draft)}>
              {save.isPending && <Spinner />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
