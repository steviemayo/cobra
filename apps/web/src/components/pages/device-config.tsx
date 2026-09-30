'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera } from 'lucide-react';
import { toast } from 'sonner';
import { CONFIG_FIELDS, type ConfigParam } from '@kestrel/model';
import { ConfigParamEditor } from '@/components/common/config-param-editor';
import { dateTime } from '@/components/common/health';
import { Section } from '@/components/common/section';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/trpc/client';

const NONE = '__none';

/** One device: what it is held to, whether it has drifted, its own settings, and its snapshots. */
export function DeviceConfig({ deviceId }: { deviceId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const cfg = useQuery({
    ...trpc.config.device.queryOptions({ orgId, deviceId }),
    refetchInterval: 20_000,
  });
  const profiles = useQuery(trpc.config.profiles.queryOptions({ orgId }));
  const snaps = useQuery(trpc.config.snapshots.queryOptions({ orgId, deviceId }));
  const [own, setOwn] = useState<ConfigParam[] | null>(null);
  const [compare, setCompare] = useState<string | null>(null);
  const diff = useQuery({
    ...trpc.config.compare.queryOptions({ orgId, deviceId, from: compare ?? '', to: 'live' }),
    enabled: !!compare,
  });
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: trpc.config.device.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.config.snapshots.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.config.overview.queryKey() }),
    ]);
  };
  const set = useMutation(
    trpc.config.setDevice.mutationOptions({
      onSuccess: async () => {
        toast.success('Saved');
        setOwn(null);
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const snap = useMutation(
    trpc.config.takeSnapshot.mutationOptions({
      onSuccess: async () => {
        toast.success('Snapshot taken');
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const baseline = useMutation(
    trpc.config.setBaseline.mutationOptions({
      onSuccess: async () => {
        toast.success('Baseline set');
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (cfg.isPending) return <Skeleton className="h-32 w-full" />;
  if (cfg.isError) return <p className="text-sm text-destructive">{cfg.error.message}</p>;
  const c = cfg.data;
  const editing = own ?? c.own;
  return (
    <div className="space-y-6">
      <Section title="Held to">
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Profile</span>
            <SimpleSelect
              size="sm"
              className="w-56"
              disabled={!canSupport}
              value={c.profile?.id ?? NONE}
              onValueChange={(v) =>
                set.mutate({ orgId, deviceId, profileId: v === NONE ? null : v })
              }
              options={[
                { value: NONE, label: 'No profile' },
                ...(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name })),
              ]}
            />
            {c.profile && (
              <span className="text-xs text-muted-foreground">version {c.profile.version}</span>
            )}
          </div>
          {c.applies.length === 0 && c.notApplicable.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing is held to a value on this device.
            </p>
          ) : (
            <ul className="divide-y rounded-md border text-sm">
              {c.applies.map((p) => (
                <li
                  key={p.field}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <span>
                    {CONFIG_FIELDS[p.field]?.label ?? p.field} should be <b>{String(p.value)}</b>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {p.mode === 'enforce'
                        ? 'enforced'
                        : p.mode === 'once'
                          ? 'applied once'
                          : 'watched'}
                    </span>
                  </span>
                  {p.drift ? (
                    <Badge variant="destructive">Reads {p.drift.actual}</Badge>
                  ) : p.mode === 'once' ? (
                    <span className="text-xs text-muted-foreground">
                      Reads {p.reading === null ? 'nothing' : String(p.reading)}
                    </span>
                  ) : (
                    <Badge variant="secondary">Matches</Badge>
                  )}
                </li>
              ))}
              {c.notApplicable.map((p) => (
                <li
                  key={p.field}
                  className="flex items-center justify-between px-3 py-2 text-muted-foreground"
                >
                  <span>{CONFIG_FIELDS[p.field]?.label ?? p.field}</span>
                  <span className="text-xs">Not applicable: this device does not report it</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section
        title="This device's own settings"
        action={
          canSupport &&
          (own ? (
            <div className="flex gap-2">
              <Button size="xs" variant="ghost" onClick={() => setOwn(null)}>
                Cancel
              </Button>
              <Button
                size="xs"
                disabled={set.isPending}
                onClick={() => set.mutate({ orgId, deviceId, params: own })}
              >
                Save
              </Button>
            </div>
          ) : (
            <Button size="xs" variant="outline" onClick={() => setOwn(c.own)}>
              Edit
            </Button>
          ))
        }
      >
        <div className="p-4">
          <ConfigParamEditor
            value={editing}
            onChange={setOwn}
            available={c.holdable}
            disabled={!own}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Only what this device reports can be held to a value. A setting here replaces the same
            setting from its profile.
          </p>
        </div>
      </Section>

      <Section
        title="Snapshots"
        action={
          canSupport && (
            <Button
              size="xs"
              variant="outline"
              disabled={snap.isPending}
              onClick={() => snap.mutate({ orgId, deviceId })}
            >
              <Camera data-icon="inline-start" /> Take a snapshot
            </Button>
          )
        }
      >
        <div className="space-y-3 p-4">
          {c.baseline && (
            <div className="rounded-md border px-3 py-2 text-sm">
              <div className="font-medium">
                Since the baseline ({dateTime(c.baseline.baselineAt)}):{' '}
                {c.baseline.changes.length === 0
                  ? 'nothing has changed'
                  : `${c.baseline.changes.length} change${c.baseline.changes.length === 1 ? '' : 's'}`}
              </div>
              {c.baseline.changes.map((ch) => (
                <div key={ch.key} className="text-xs text-muted-foreground">
                  {ch.key}: {ch.before ?? 'nothing'} to {ch.after ?? 'nothing'}
                </div>
              ))}
            </div>
          )}
          {snaps.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : (snaps.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No snapshots yet. One is taken every day.
            </p>
          ) : (
            <ul className="divide-y rounded-md border text-sm">
              {snaps.data!.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <span>
                    {dateTime(s.takenAt)}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {s.reason.replace(/_/g, ' ')}
                    </span>
                    {s.isBaseline && <Badge className="ml-2">Baseline</Badge>}
                  </span>
                  <span className="flex gap-2">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setCompare(compare === s.id ? null : s.id)}
                    >
                      {compare === s.id ? 'Hide' : 'Compare with now'}
                    </Button>
                    {canSupport && !s.isBaseline && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => baseline.mutate({ orgId, snapshotId: s.id })}
                      >
                        Make baseline
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {compare && (
            <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs">
              {diff.isPending
                ? 'Comparing…'
                : (diff.data?.changes ?? []).length === 0
                  ? 'The device is the same as that snapshot.'
                  : diff.data!.changes.map((ch) => (
                      <div key={ch.key}>
                        {ch.key}: {ch.before ?? 'nothing'} to {ch.after ?? 'nothing'}
                      </div>
                    ))}
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}
