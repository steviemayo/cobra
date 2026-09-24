'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ActivityFeed } from '@/components/common/activity-feed';
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
    </PageContainer>
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
