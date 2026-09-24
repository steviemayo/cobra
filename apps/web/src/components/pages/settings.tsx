'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ActivityFeed } from '@/components/common/activity-feed';
import {
  BrandingFields,
  brandingToDraft,
  draftToBranding,
  type BrandingDraft,
} from '@/components/common/branding-fields';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
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
    </PageContainer>
  );
}

/** The default look of every room's panel and the customer pages. Rooms follow it unless they set their own. */
function OrgBrandingForm() {
  const trpc = useTRPC();
  const qc = useQueryClient();
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
        toast.success('Panel theme saved. Rooms pick it up on their next release.');
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
  const log = useQuery(trpc.audit.list.queryOptions({ orgId, limit: 100 }));
  return (
    <PageContainer className="max-w-3xl">
      <PageHeader
        title="Activity log"
        description="Changes to sites, rooms, members and invitations."
      />
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
