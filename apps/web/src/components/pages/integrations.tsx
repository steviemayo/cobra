'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Plug, Plus, Trash2, Workflow } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { INCIDENT_KIND_LABEL, dateTime } from '@/components/common/health';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { Section } from '@/components/common/section';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
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
import { Switch } from '@/components/ui/switch';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Rule = RouterOutputs['support']['rules'][number];
type Connector = RouterOutputs['support']['connectors'][number];

const PRIORITIES = ['low', 'normal', 'high', 'urgent'].map((p) => ({ value: p, label: p }));
const SEVERITIES = [
  { value: 'info', label: 'Info and above' },
  { value: 'warning', label: 'Warning and above' },
  { value: 'critical', label: 'Critical only' },
];
const KINDS = Object.entries(INCIDENT_KIND_LABEL).map(([value, label]) => ({ value, label }));
const TYPE_LABEL: Record<string, string> = {
  webhook: 'Webhook (any service desk)',
  demo: 'Demo desk',
  email_in: 'Email in',
};

function RuleDialog({ rule, onClose }: { rule: Rule | null; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const providers = useQuery(trpc.msp.providers.queryOptions({ orgId }));
  const [name, setName] = useState(rule?.name ?? '');
  const [kind, setKind] = useState(rule?.kinds[0] ?? '');
  const [minSeverity, setMinSeverity] = useState(rule?.minSeverity ?? 'warning');
  const [afterMinutes, setAfterMinutes] = useState(rule?.afterMinutes ?? 10);
  const [priority, setPriority] = useState(rule?.priority ?? 'normal');
  const [routeTo, setRouteTo] = useState(rule?.routeTo ?? 'org');
  const [escalateAfter, setEscalateAfter] = useState(rule?.escalateAfterMinutes ?? 0);
  const [escalatePriority, setEscalatePriority] = useState(rule?.escalatePriority ?? 'high');
  const [escalateTo, setEscalateTo] = useState(rule?.escalateTo ?? 'kestrel');
  const routes = [
    { value: 'org', label: 'Our own team' },
    { value: 'kestrel', label: 'Kestrel support' },
    ...(providers.data ?? [])
      .filter((p) => p.status === 'active')
      .map((p) => ({ value: `msp:${p.mspOrgId}`, label: p.mspName })),
  ];
  const done = async () => {
    await qc.invalidateQueries({ queryKey: trpc.support.rules.queryKey() });
    onClose();
  };
  const create = useMutation(
    trpc.support.createRule.mutationOptions({
      onSuccess: async () => {
        toast.success('Rule added');
        await done();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const update = useMutation(
    trpc.support.updateRule.mutationOptions({
      onSuccess: async () => {
        toast.success('Rule saved');
        await done();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const body = {
    name: name.trim(),
    kinds: kind ? [kind] : [],
    minSeverity: minSeverity as 'info' | 'warning' | 'critical',
    afterMinutes,
    priority: priority as 'low' | 'normal' | 'high' | 'urgent',
    routeTo,
    escalateAfterMinutes: escalateAfter,
    escalatePriority: escalatePriority as 'low' | 'normal' | 'high' | 'urgent',
    escalateTo,
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{rule ? `Edit ${rule.name}` : 'New ticket rule'}</DialogTitle>
          <DialogDescription>
            Raise a ticket by itself when an incident matches and has been open long enough. The
            first matching rule wins. A fault behind an offline gateway is one ticket, not one per
            device, and a second fault in a room joins the open ticket.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="Offline devices"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Kind of incident</Label>
              <SimpleSelect
                value={kind || '__any'}
                onValueChange={(v) => setKind(v === '__any' ? '' : v)}
                options={[{ value: '__any', label: 'Any' }, ...KINDS]}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Severity</Label>
              <SimpleSelect
                value={minSeverity}
                onValueChange={setMinSeverity}
                options={SEVERITIES}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Open for at least (minutes)</Label>
              <Input
                type="number"
                min={0}
                max={1440}
                value={afterMinutes}
                onChange={(e) => setAfterMinutes(Number(e.target.value))}
                className="h-8"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Priority</Label>
              <SimpleSelect value={priority} onValueChange={setPriority} options={PRIORITIES} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs">Send it to</Label>
              <SimpleSelect value={routeTo} onValueChange={setRouteTo} options={routes} />
            </div>
          </div>
          <div className="space-y-2 rounded-md border p-3">
            <div className="text-xs font-medium">If nobody replies</div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label className="text-xs">After (minutes, 0 for never)</Label>
                <Input
                  type="number"
                  min={0}
                  max={10080}
                  value={escalateAfter}
                  onChange={(e) => setEscalateAfter(Number(e.target.value))}
                  className="h-8"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Raise priority to</Label>
                <SimpleSelect
                  value={escalatePriority}
                  onValueChange={setEscalatePriority}
                  options={PRIORITIES}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">And send it to</Label>
                <SimpleSelect value={escalateTo} onValueChange={setEscalateTo} options={routes} />
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || create.isPending || update.isPending}
            onClick={() =>
              rule
                ? update.mutate({ orgId, ruleId: rule.id, ...body })
                : create.mutate({ orgId, ...body })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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

function ConnectorDialog({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const [type, setType] = useState<'webhook' | 'demo' | 'email_in'>('demo');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [made, setMade] = useState<{ id: string; inboundSecret: string | null } | null>(null);
  const create = useMutation(
    trpc.support.createConnector.mutationOptions({
      onSuccess: async (r) => {
        setMade(r);
        await qc.invalidateQueries({ queryKey: trpc.support.connectors.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{made ? 'Connector added' : 'Add a service desk'}</DialogTitle>
          <DialogDescription>
            {made
              ? 'Copy these now: the secret is shown only once.'
              : 'Tickets are mirrored to the desk, and it can send status changes and comments back.'}
          </DialogDescription>
        </DialogHeader>
        {made ? (
          <div className="space-y-3">
            {type !== 'demo' && made.inboundSecret && (
              <>
                <CopyLine
                  label="Send updates to (POST, JSON)"
                  value={`${origin}/api/itsm/${made.id}${type === 'email_in' ? '/mail' : ''}`}
                />
                <CopyLine label="Secret (Authorization: Bearer ...)" value={made.inboundSecret} />
                <p className="text-xs text-muted-foreground">
                  {type === 'email_in'
                    ? 'Body: { "from": "person@example.com", "subject": "...", "text": "..." }. Point any mail service that can forward parsed mail as JSON here.'
                    : 'Body: { "ticketId" or "externalRef", "status", "comment" }. Include both ticketId and externalRef once to link the two tickets.'}
                </p>
              </>
            )}
            {type === 'demo' && (
              <p className="text-sm text-muted-foreground">
                The demo desk needs nothing more. New tickets are sent to it with a DEMO reference,
                and you can answer them from its page to see the round trip.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Kind</Label>
              <SimpleSelect
                value={type}
                onValueChange={(v) => setType(v as typeof type)}
                options={[
                  { value: 'demo', label: TYPE_LABEL.demo! },
                  { value: 'webhook', label: TYPE_LABEL.webhook! },
                  { value: 'email_in', label: TYPE_LABEL.email_in! },
                ]}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                placeholder="Service desk"
              />
            </div>
            {type === 'webhook' && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs">Address Kestrel posts tickets to (https)</Label>
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://desk.example.com/kestrel"
                    maxLength={2000}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Signing secret (optional, 8 or more characters)</Label>
                  <Input
                    type="password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    maxLength={200}
                  />
                </div>
              </>
            )}
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
                disabled={!name.trim() || (type === 'webhook' && !url.trim()) || create.isPending}
                onClick={() =>
                  create.mutate({
                    orgId,
                    name: name.trim(),
                    type,
                    url: url || null,
                    secret: secret || null,
                  })
                }
              >
                Add
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectorCard({ c }: { c: Connector }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const log = useQuery({
    ...trpc.support.log.queryOptions({ orgId, connectorId: c.id }),
    enabled: open,
  });
  const links = useQuery({
    ...trpc.support.links.queryOptions({ orgId, connectorId: c.id }),
    enabled: open && c.type === 'demo',
  });
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.support.connectors.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.support.log.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.support.links.queryKey() }),
    ]);
  const toggle = useMutation(
    trpc.support.setConnectorEnabled.mutationOptions({
      onSuccess: refresh,
      onError: (e) => toast.error(e.message),
    }),
  );
  const del = useMutation(
    trpc.support.deleteConnector.mutationOptions({
      onSuccess: async () => {
        toast.success('Connector removed');
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const rotate = useMutation(
    trpc.support.rotateSecret.mutationOptions({
      onSuccess: (r) => {
        void navigator.clipboard.writeText(r.inboundSecret);
        toast.success('New secret copied. The old one no longer works.');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const demo = useMutation(
    trpc.support.simulateDemo.mutationOptions({
      onSuccess: async () => {
        toast.success('The demo desk answered');
        await Promise.all([
          refresh(),
          qc.invalidateQueries({ queryKey: trpc.ticket.list.queryKey() }),
        ]);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <li className="space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            {c.name}
            <Badge variant="secondary">{TYPE_LABEL[c.type] ?? c.type}</Badge>
            {c.signed && <Badge variant="outline">Signed</Badge>}
          </div>
          <div className="text-xs text-muted-foreground">
            {c.url ??
              (c.type === 'demo' ? 'Built-in demo desk' : 'Receives mail forwarded as JSON')}{' '}
            · {c.linkedTickets} linked ticket{c.linkedTickets === 1 ? '' : 's'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={c.enabled}
            onCheckedChange={(v) => toggle.mutate({ orgId, connectorId: c.id, enabled: v })}
            aria-label="Enabled"
          />
          <Button size="xs" variant="outline" onClick={() => setOpen(!open)}>
            {open ? 'Hide activity' : 'Activity'}
          </Button>
          {c.type !== 'demo' && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => rotate.mutate({ orgId, connectorId: c.id })}
            >
              New secret
            </Button>
          )}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Remove ${c.name}`}
            onClick={() => setDeleting(true)}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      {open && (
        <div className="space-y-3 rounded-md border bg-muted/20 p-3">
          {c.type === 'demo' && (links.data ?? []).length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium">Answer as the desk</div>
              {links.data!.map((l) => (
                <div
                  key={l.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span>
                    <code className="text-xs">{l.externalRef}</code> {l.ticket?.title ?? 'A ticket'}
                    <span className="ml-2 text-xs text-muted-foreground">{l.ticket?.status}</span>
                  </span>
                  <span className="flex gap-1.5">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={demo.isPending}
                      onClick={() =>
                        demo.mutate({
                          orgId,
                          connectorId: c.id,
                          ticketId: l.ticketId,
                          action: 'work',
                        })
                      }
                    >
                      Start work
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={demo.isPending}
                      onClick={() =>
                        demo.mutate({
                          orgId,
                          connectorId: c.id,
                          ticketId: l.ticketId,
                          action: 'comment',
                        })
                      }
                    >
                      Ask a question
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={demo.isPending}
                      onClick={() =>
                        demo.mutate({
                          orgId,
                          connectorId: c.id,
                          ticketId: l.ticketId,
                          action: 'resolve',
                        })
                      }
                    >
                      Resolve
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          )}
          {log.isPending ? (
            <Skeleton className="h-10 w-full" />
          ) : (log.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing has passed between Kestrel and this desk yet.
            </p>
          ) : (
            <ul className="space-y-1 text-xs">
              {log.data!.map((e) => (
                <li key={e.id} className="flex gap-2">
                  <span className="w-10 text-muted-foreground">
                    {e.direction === 'out' ? 'Sent' : 'Got'}
                  </span>
                  <span className={e.ok ? '' : 'text-destructive'}>{e.summary}</span>
                  <span className="ml-auto text-muted-foreground">{dateTime(e.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Remove ${c.name}?`}
        description="Tickets stay in Kestrel. They are no longer sent to this desk, and its links are forgotten."
        confirmLabel="Remove"
        destructive
        onConfirm={() => del.mutate({ orgId, connectorId: c.id })}
      />
    </li>
  );
}

/** Ticket rules and service desk connectors. */
export function IntegrationsView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport, isOwner, role } = useOrg();
  const admin = isOwner || role === 'dev';
  const rules = useQuery(trpc.support.rules.queryOptions({ orgId }));
  const connectors = useQuery({
    ...trpc.support.connectors.queryOptions({ orgId }),
    enabled: admin,
    retry: false,
  });
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [addingConnector, setAddingConnector] = useState(false);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const del = useMutation(
    trpc.support.deleteRule.mutationOptions({
      onSuccess: async () => {
        toast.success('Rule removed');
        await qc.invalidateQueries({ queryKey: trpc.support.rules.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const toggle = useMutation(
    trpc.support.updateRule.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.support.rules.queryKey() }),
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <PageContainer>
      <PageHeader
        title="Integrations"
        description="Raise tickets from incidents by rule, and keep them in step with your own service desk."
      />
      <Section
        title="Ticket rules"
        action={
          admin && (
            <Button size="xs" variant="outline" onClick={() => setEditing('new')}>
              <Plus data-icon="inline-start" /> New rule
            </Button>
          )
        }
      >
        {rules.isPending ? (
          <Skeleton className="m-4 h-16" />
        ) : (rules.data ?? []).length === 0 ? (
          <div className="p-2">
            <EmptyState
              icon={Workflow}
              title="No ticket rules"
              description="Without a rule, tickets are raised by hand. Add one to raise them from incidents automatically."
              className="border-0 py-8"
            />
          </div>
        ) : (
          <ul className="divide-y">
            {rules.data!.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div>
                  <div className="text-sm font-medium">{r.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.kinds.length
                      ? r.kinds.map((k) => INCIDENT_KIND_LABEL[k] ?? k).join(', ')
                      : 'Any incident'}
                    , {r.minSeverity} and above, open {r.afterMinutes} min, {r.priority} priority,
                    to{' '}
                    {r.routeTo === 'org'
                      ? 'our team'
                      : r.routeTo === 'kestrel'
                        ? 'Kestrel'
                        : 'a provider'}
                    {r.escalateAfterMinutes > 0 &&
                      `; if unanswered after ${r.escalateAfterMinutes} min: ${r.escalatePriority}`}
                  </div>
                </div>
                {admin && (
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={r.enabled}
                      onCheckedChange={(v) => toggle.mutate({ orgId, ruleId: r.id, enabled: v })}
                      aria-label="Enabled"
                    />
                    <Button size="xs" variant="outline" onClick={() => setEditing(r)}>
                      Edit
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Remove ${r.name}`}
                      onClick={() => setDeleting(r)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Service desks"
        action={
          admin && (
            <Button size="xs" variant="outline" onClick={() => setAddingConnector(true)}>
              <Plus data-icon="inline-start" /> Add a desk
            </Button>
          )
        }
      >
        {!admin ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            Only owners and developers can manage service desk connections.
          </p>
        ) : connectors.isPending ? (
          <Skeleton className="m-4 h-16" />
        ) : (connectors.data ?? []).length === 0 ? (
          <div className="p-2">
            <EmptyState
              icon={Plug}
              title="No service desk connected"
              description="Add a webhook for your own desk, an email-in address, or the demo desk to see how it works."
              className="border-0 py-8"
            />
          </div>
        ) : (
          <ul className="divide-y">
            {connectors.data!.map((c) => (
              <ConnectorCard key={c.id} c={c} />
            ))}
          </ul>
        )}
      </Section>
      {!canSupport && null}
      {editing && (
        <RuleDialog rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
      {addingConnector && <ConnectorDialog onClose={() => setAddingConnector(false)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Remove ${deleting?.name}?`}
        description="Tickets already raised by it are kept."
        confirmLabel="Remove"
        destructive
        onConfirm={() => deleting && del.mutate({ orgId, ruleId: deleting.id })}
      />
    </PageContainer>
  );
}
