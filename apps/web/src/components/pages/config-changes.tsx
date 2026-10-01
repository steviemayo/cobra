'use client';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Rocket, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { CONFIG_FIELDS } from '@kestrel/model';
import { dateTime } from '@/components/common/health';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { Section } from '@/components/common/section';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { plural } from '@/lib/format';
import { useTRPC } from '@/trpc/client';

const STAGE: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  canary: { label: 'Waiting for a go-ahead', variant: 'default' },
  done: { label: 'Deployed', variant: 'secondary' },
  rolled_back: { label: 'Rolled back', variant: 'outline' },
};

const EVENT_TEXT: Record<string, string> = {
  config_drift: 'changed from what it should be',
  config_corrected: 'was put back',
  config_restored: 'came right again',
  config_pushed: 'settings were sent',
  config_rolled_back: 'was rolled back',
  config_changed: 'own settings changed',
  profile_assigned: 'profile changed',
  snapshot_taken: 'snapshot taken',
};

/** Deploys (with the go-ahead and rollback) and every settings change across the estate. */
export function ConfigChangesView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const deploys = useQuery(trpc.config.deploys.queryOptions({ orgId }));
  const changes = useQuery({
    ...trpc.config.changes.queryOptions({ orgId }),
    refetchInterval: 30_000,
  });
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: trpc.config.deploys.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.config.changes.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.config.overview.queryKey() }),
    ]);
  };
  const cont = useMutation(
    trpc.config.continueDeploy.mutationOptions({
      onSuccess: async () => {
        toast.success('Applied to the rest');
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const back = useMutation(
    trpc.config.rollbackDeploy.mutationOptions({
      onSuccess: async () => {
        toast.success('Rolled back. Earlier settings are being sent back.');
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <PageContainer>
      <PageHeader
        title="Changes"
        description="Profile deploys, and every change to what devices are held to."
      />
      <Section title="Deploys">
        {deploys.isPending ? (
          <Skeleton className="m-4 h-16" />
        ) : (deploys.data ?? []).length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            Nothing has been deployed yet. Deploy a profile from Profiles.
          </p>
        ) : (
          <ul className="divide-y">
            {deploys.data!.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Rocket className="size-3.5 text-muted-foreground" />
                    {d.profileName}
                    <span className="text-xs font-normal text-muted-foreground">
                      version {d.profileVersion}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {plural(d.deviceIds.length, 'device')} · {dateTime(d.createdAt)}
                    {d.canaryIds.length > 0 &&
                      ` · ${plural(d.canaryIds.length, 'canary', 'canaries')}`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={STAGE[d.stage]?.variant ?? 'secondary'}>
                    {STAGE[d.stage]?.label ?? d.stage}
                  </Badge>
                  {canSupport && d.stage === 'canary' && (
                    <Button
                      size="xs"
                      disabled={cont.isPending}
                      onClick={() => cont.mutate({ orgId, deployId: d.id })}
                    >
                      Apply to the rest
                    </Button>
                  )}
                  {canSupport && d.stage !== 'rolled_back' && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={back.isPending}
                      onClick={() => back.mutate({ orgId, deployId: d.id })}
                    >
                      <Undo2 data-icon="inline-start" /> Roll back
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Settings changes">
        {changes.isPending ? (
          <Skeleton className="m-4 h-16" />
        ) : (changes.data ?? []).length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">No changes yet.</p>
        ) : (
          <ul className="divide-y">
            {changes.data!.map((e) => (
              <li key={e.id} className="px-4 py-2.5 text-sm">
                <Link
                  href={orgPath(orgId, `/devices/${e.deviceId}`)}
                  className="font-medium hover:underline"
                >
                  {e.deviceName}
                </Link>{' '}
                {e.field ? `${CONFIG_FIELDS[e.field]?.label ?? e.field} ` : ''}
                {EVENT_TEXT[e.type] ?? e.type}
                {e.type === 'config_drift' && e.oldValue !== null && (
                  <span className="text-muted-foreground">
                    {' '}
                    (should be {e.oldValue}, reads {e.newValue})
                  </span>
                )}
                <span className="ml-2 text-xs text-muted-foreground">{dateTime(e.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </PageContainer>
  );
}
