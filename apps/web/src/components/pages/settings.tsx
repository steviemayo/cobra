'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ActivityFeed } from '@/components/common/activity-feed';
import { NetworkHealthSettings } from './network-health';
import { ApiKeysSetting } from '@/components/common/api-keys-setting';
import { DeleteOrgSetting } from '@/components/common/delete-org-setting';
import { AuditExportButtons } from '@/components/common/audit-export-buttons';
import {
  BrandingFields,
  brandingToDraft,
  draftToBranding,
  type BrandingDraft,
} from '@/components/common/branding-fields';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { ServiceProvidersSetting } from '@/components/common/service-providers-setting';
import { StaffAccessSetting } from '@/components/common/staff-access-setting';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SimpleSelect } from '@/components/common/simple-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ROLE_LABEL } from '@/lib/format';
import { useTRPC } from '@/trpc/client';

export function GeneralSettings() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const { orgId, org, isOwner } = useOrg();
  const [name, setName] = useState(org.name);

  const rename = useMutation(
    trpc.org.rename.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: trpc.audit.list.queryKey() });
        toast.success('Organisation renamed');
        router.refresh();
      },
    }),
  );

  useEffect(() => {
    if (!isOwner) router.replace(orgPath(orgId, '/settings/activity'));
  }, [isOwner, orgId, router]);
  if (!isOwner) return null;

  return (
    <PageContainer className="max-w-2xl">
      <PageHeader title="Settings" description="Organisation-wide settings." />
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          rename.mutate({ orgId, name });
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="org-name">Organisation name</Label>
          <Input id="org-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Your role</Label>
          <p className="text-sm text-muted-foreground">{ROLE_LABEL[org.role]}</p>
        </div>
        {rename.error && <p className="text-sm text-destructive">{rename.error.message}</p>}
        <Button
          type="submit"
          disabled={rename.isPending || !name.trim() || name.trim() === org.name}
        >
          {rename.isPending && <Spinner />}
          Save changes
        </Button>
      </form>
      <OrgBrandingForm />
      <CalendarSettings />
      <NetworkHealthSettings />
      <ApiKeysSetting />
      {org.kind !== 'msp' && <ServiceProvidersSetting />}
      <StaffAccessSetting />
      <DeleteOrgSetting />
    </PageContainer>
  );
}

/** The default look of every room's panel and the customer pages. Rooms follow it unless they set their own. */
function OrgBrandingForm() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const { orgId } = useOrg();
  const current = useQuery(trpc.org.getBranding.queryOptions({ orgId }));
  const [look, setLook] = useState<BrandingDraft>({
    mode: 'dark',
    accent: '',
    logo: '',
    language: 'en',
  });
  useEffect(() => {
    if (current.data) setLook(brandingToDraft(current.data));
  }, [current.data]);
  const save = useMutation(
    trpc.org.setBranding.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: trpc.org.getBranding.queryKey() });
        toast.success(
          'Theme saved. The portal updates now; rooms pick it up on their next release.',
        );
        // The portal's own accent colour comes from the page, so reload it.
        router.refresh();
      },
    }),
  );
  if (current.isPending) return null;
  return (
    <form
      className="space-y-4 border-t pt-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ orgId, branding: draftToBranding(look) });
      }}
    >
      <div>
        <h2 className="text-sm font-medium">Panel theme</h2>
        <p className="text-sm text-muted-foreground">
          Your colours, logo and language on every room’s touch panel. Rooms follow this unless they
          set their own, and pick up changes on their next release.
        </p>
      </div>
      <BrandingFields id="org-brand" value={look} onChange={setLook} />
      {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
      <Button type="submit" disabled={save.isPending}>
        {save.isPending && <Spinner />}
        Save theme
      </Button>
    </form>
  );
}

export function ActivityLog() {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const { isOwner } = useOrg();
  const log = useQuery(trpc.audit.list.queryOptions({ orgId, limit: 100 }));
  const retention = useQuery(trpc.audit.retention.queryOptions({ orgId }));
  const exportLog = useMutation(trpc.audit.export.mutationOptions());
  const months = (days: number) => Math.round(days / 30.4);
  return (
    <PageContainer className="max-w-3xl">
      <PageHeader
        title="Activity log"
        description="Changes to sites, rooms, members and invitations."
        actions={
          isOwner ? (
            <AuditExportButtons run={(format) => exportLog.mutateAsync({ orgId, format })} />
          ) : undefined
        }
      />
      {retention.data && (
        <p className="text-sm text-muted-foreground">
          Kept for {months(retention.data.days)} months. Billing and access changes are kept for{' '}
          {months(retention.data.longKeptDays)} months.
          {isOwner ? ' Download the whole log with the buttons above.' : ''}
        </p>
      )}
      {log.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : log.error ? (
        <p className="text-sm text-destructive">{log.error.message}</p>
      ) : (
        <ActivityFeed rows={log.data ?? []} />
      )}
    </PageContainer>
  );
}

/** Calendar profiles: each room picks one and names its own calendar (Room > Settings). */
function CalendarSettings() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const info = useQuery(trpc.calendar.list.queryOptions({ orgId }));
  const [provider, setProvider] = useState<'graph' | 'google'>('graph');
  const [label, setLabel] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [email, setEmail] = useState('');
  const [key, setKey] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.calendar.list.queryKey() });
  const connect = useMutation(
    trpc.calendar.connect.mutationOptions({
      onSuccess: async () => {
        setSecret('');
        setKey('');
        await refresh();
        toast.success('Calendar profile added');
      },
    }),
  );
  const remove = useMutation(
    trpc.calendar.remove.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Calendar profile removed');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (info.isPending || !info.data) return null;
  const graph = { provider: 'graph' as const, tenantId, clientId, clientSecret: secret };
  const google = { provider: 'google' as const, clientEmail: email, privateKey: key };
  return (
    <section className="space-y-4 border-t pt-6">
      <div>
        <h2 className="text-sm font-medium">Calendars</h2>
        <p className="text-sm text-muted-foreground">
          Add a profile for each calendar service you use (for example Microsoft 365 and Google, or
          two Microsoft 365 tenants). Then open a room’s settings, choose a profile and enter the
          room’s own calendar address.
        </p>
        <p className="text-sm text-muted-foreground">
          Kestrel shows each room’s week, warns about meetings a fault may affect, and checks
          bookings when you plan maintenance. It only reads calendars. Meetings marked private or
          confidential show as “Busy”, with no title or organiser.
        </p>
      </div>
      {!info.data.available && (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          Calendars aren’t set up on this Kestrel server yet (it needs KESTREL_SECRETS_KEY).
        </p>
      )}
      {info.data.connections.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {info.data.connections.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span>
                {c.name}{' '}
                <span className="text-muted-foreground">
                  ({c.provider === 'graph' ? 'Microsoft 365' : 'Google'}, {c.rooms}{' '}
                  {c.rooms === 1 ? 'room' : 'rooms'})
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate({ orgId, connectionId: c.id })}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {info.data.available && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            connect.mutate({
              orgId,
              name: label,
              credentials: provider === 'graph' ? graph : google,
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="cal-provider">Calendar service</Label>
              <SimpleSelect
                id="cal-provider"
                className="w-full"
                value={provider}
                onValueChange={setProvider}
                options={[
                  { value: 'graph', label: 'Microsoft 365' },
                  { value: 'google', label: 'Google Workspace' },
                ]}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cal-name">Name</Label>
              <Input
                id="cal-name"
                required
                placeholder="Company calendar"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
          </div>
          {provider === 'graph' ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="cal-tenant">Tenant ID</Label>
                <Input
                  id="cal-tenant"
                  required
                  value={tenantId}
                  onChange={(e) => setTenantId(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cal-client">Application (client) ID</Label>
                <Input
                  id="cal-client"
                  required
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cal-secret">Client secret</Label>
                <Input
                  id="cal-secret"
                  type="password"
                  autoComplete="off"
                  required
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="cal-email">Service account email</Label>
                <Input
                  id="cal-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cal-key">Private key</Label>
                <Textarea
                  id="cal-key"
                  required
                  rows={4}
                  className="font-mono text-xs"
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
              </div>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Kestrel only reads meetings. Credentials are encrypted before they are stored and never
            shown again.
          </p>
          {connect.error && <p className="text-sm text-destructive">{connect.error.message}</p>}
          <Button type="submit" disabled={connect.isPending || !label.trim()}>
            {connect.isPending && <Spinner />}
            Add profile
          </Button>
        </form>
      )}
    </section>
  );
}
