'use client';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Rocket, SlidersHorizontal, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { CONFIG_FIELDS, assetCategoryLabel, type ConfigParam } from '@kestrel/model';
import { ConfigParamEditor } from '@/components/common/config-param-editor';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Textarea } from '@/components/ui/textarea';
import { PushToCustomersDialog } from './push-to-customers-dialog';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Profile = RouterOutputs['config']['profiles'][number];

const ALL_FIELDS = Object.entries(CONFIG_FIELDS).map(([field, f]) => ({ field, label: f.label }));

function ProfileDialog({ profile, onClose }: { profile: Profile | null; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const [name, setName] = useState(profile?.name ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [params, setParams] = useState<ConfigParam[]>((profile?.params as ConfigParam[]) ?? []);
  const done = async () => {
    await qc.invalidateQueries({ queryKey: trpc.config.profiles.queryKey() });
    onClose();
  };
  const create = useMutation(
    trpc.config.createProfile.mutationOptions({
      onSuccess: async () => {
        toast.success('Profile created');
        await done();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const update = useMutation(
    trpc.config.updateProfile.mutationOptions({
      onSuccess: async () => {
        toast.success('Profile saved');
        await done();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const busy = create.isPending || update.isPending;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{profile ? `Edit ${profile.name}` : 'New profile'}</DialogTitle>
          <DialogDescription>
            A profile is a set of settings devices are held to. A setting only applies to a device
            that reports it, so one profile can cover a mixed set of devices.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Meeting room display"
              maxLength={80}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={500}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Settings</Label>
            <ConfigParamEditor value={params} onChange={setParams} available={ALL_FIELDS} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || busy}
            onClick={() =>
              profile
                ? update.mutate({
                    orgId,
                    profileId: profile.id,
                    name: name.trim(),
                    description: description || null,
                    params,
                  })
                : create.mutate({
                    orgId,
                    name: name.trim(),
                    description: description || null,
                    params,
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

function DeployDialog({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const devices = useQuery(trpc.device.list.queryOptions({ orgId }));
  const monitored = useMemo(
    () => (devices.data ?? []).filter((d) => d.kind === 'active'),
    [devices.data],
  );
  const [picked, setPicked] = useState<string[]>([]);
  const [canary, setCanary] = useState(0);
  const plan = useQuery({
    ...trpc.config.deployPlan.queryOptions({ orgId, profileId: profile.id, deviceIds: picked }),
    enabled: picked.length > 0,
  });
  const deploy = useMutation(
    trpc.config.deploy.mutationOptions({
      onSuccess: async (r) => {
        toast.success(
          r.stage === 'canary'
            ? 'Applied to the canary. Continue from Changes when it looks right.'
            : 'Deployed',
        );
        await Promise.all([
          qc.invalidateQueries({ queryKey: trpc.config.profiles.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.config.deploys.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.config.overview.queryKey() }),
        ]);
        onClose();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Deploy {profile.name}</DialogTitle>
          <DialogDescription>
            Pick the devices. A snapshot of each is taken first so this can be rolled back. Settings
            a device does not report are left out for that device.
          </DialogDescription>
        </DialogHeader>
        {devices.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : monitored.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            There are no monitored devices to deploy to yet.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="max-h-48 divide-y overflow-y-auto rounded-md border">
              {monitored.map((d) => (
                <label
                  key={d.id}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/40"
                >
                  <Checkbox checked={picked.includes(d.id)} onCheckedChange={() => toggle(d.id)} />
                  <span className="flex-1">
                    {d.name}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {assetCategoryLabel(d.category)}
                      {d.roomName ? ` · ${d.roomName}` : ''}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {picked.length > 1 && (
              <div className="flex items-center gap-2 text-sm">
                <Label className="text-xs">Try it on first</Label>
                <Input
                  type="number"
                  min={0}
                  max={Math.min(20, picked.length - 1)}
                  value={canary}
                  onChange={(e) => setCanary(Number(e.target.value))}
                  className="h-8 w-20"
                />
                <span className="text-xs text-muted-foreground">
                  device{canary === 1 ? '' : 's'}, then wait for a go-ahead for the rest (0 for all
                  at once)
                </span>
              </div>
            )}
            {picked.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium">What would change</div>
                {plan.isPending ? (
                  <Skeleton className="h-16 w-full" />
                ) : (
                  <ul className="divide-y rounded-md border text-sm">
                    {plan.data?.rows.map((r) => (
                      <li key={r.deviceId} className="px-3 py-2">
                        <div className="font-medium">{r.name}</div>
                        {r.applies.map((a) => (
                          <div key={a.field} className="text-xs text-muted-foreground">
                            {CONFIG_FIELDS[a.field]?.label ?? a.field}: {a.from ?? 'not reported'}{' '}
                            to {a.to}
                            {a.willSet ? '' : ' (already right)'}
                          </div>
                        ))}
                        {r.notApplicable.length > 0 && (
                          <div className="text-xs text-muted-foreground">
                            Not applicable:{' '}
                            {r.notApplicable.map((f) => CONFIG_FIELDS[f]?.label ?? f).join(', ')}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={picked.length === 0 || deploy.isPending}
            onClick={() =>
              deploy.mutate({
                orgId,
                profileId: profile.id,
                deviceIds: picked,
                canaryCount: picked.length > 1 ? canary : 0,
              })
            }
          >
            <Rocket data-icon="inline-start" /> Deploy to {picked.length || 'devices'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const MODE_LABEL: Record<string, string> = {
  watch: 'watch',
  enforce: 'enforce',
  once: 'apply once',
};

export function ConfigProfilesView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport, isOwner, role, org } = useOrg();
  const [pushing, setPushing] = useState<Profile | null>(null);
  const profiles = useQuery(trpc.config.profiles.queryOptions({ orgId }));
  const [editing, setEditing] = useState<Profile | 'new' | null>(null);
  const [deploying, setDeploying] = useState<Profile | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const del = useMutation(
    trpc.config.deleteProfile.mutationOptions({
      onSuccess: async () => {
        toast.success('Profile deleted. Its devices are no longer held to it.');
        await qc.invalidateQueries({ queryKey: trpc.config.profiles.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <PageContainer>
      <PageHeader
        title="Profiles"
        description="Settings devices are held to. Watch a setting to be told when it changes, enforce it to have it put back, or apply it once."
        actions={
          canSupport && (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus data-icon="inline-start" /> New profile
            </Button>
          )
        }
      />
      {profiles.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : profiles.isError ? (
        <p className="text-sm text-destructive">{profiles.error.message}</p>
      ) : profiles.data.length === 0 ? (
        <EmptyState
          icon={SlidersHorizontal}
          title="No profiles yet"
          description="Make one for a kind of device, for example a meeting room display that should be on and at a set volume."
          action={
            canSupport ? <Button onClick={() => setEditing('new')}>New profile</Button> : undefined
          }
        />
      ) : (
        <ul className="space-y-3">
          {profiles.data.map((p) => (
            <li key={p.id} className="space-y-2 rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">
                    {p.name}{' '}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      version {p.version}
                    </span>
                  </div>
                  {p.description && (
                    <div className="text-xs text-muted-foreground">{p.description}</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">
                    {p.devices} device{p.devices === 1 ? '' : 's'}
                  </Badge>
                  {p.drifted > 0 && <Badge variant="destructive">{p.drifted} drifted</Badge>}
                  {canSupport && (
                    <>
                      <Button size="xs" variant="outline" onClick={() => setDeploying(p)}>
                        <Rocket data-icon="inline-start" /> Deploy
                      </Button>
                      {org.kind === 'msp' && (
                        <Button size="xs" variant="outline" onClick={() => setPushing(p)}>
                          Copy to customers
                        </Button>
                      )}
                      <Button size="xs" variant="outline" onClick={() => setEditing(p)}>
                        Edit
                      </Button>
                    </>
                  )}
                  {(isOwner || role === 'dev') && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Delete ${p.name}`}
                      onClick={() => setDeleting(p)}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(p.params as ConfigParam[]).map((c) => (
                  <Badge key={c.field} variant="outline" className="font-normal">
                    {CONFIG_FIELDS[c.field]?.label ?? c.field}: {String(c.value)} (
                    {MODE_LABEL[c.mode]})
                  </Badge>
                ))}
                {(p.params as ConfigParam[]).length === 0 && (
                  <span className="text-xs text-muted-foreground">No settings yet.</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <ProfileDialog
          profile={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {pushing && (
        <PushToCustomersDialog
          kind="profile"
          sourceId={pushing.id}
          name={pushing.name}
          onClose={() => setPushing(null)}
        />
      )}
      {pushing && (
        <PushToCustomersDialog
          kind="profile"
          sourceId={pushing.id}
          name={pushing.name}
          onClose={() => setPushing(null)}
        />
      )}
      {deploying && <DeployDialog profile={deploying} onClose={() => setDeploying(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description="Devices using it are no longer held to these settings. Nothing on the devices is changed."
        confirmLabel="Delete"
        destructive
        onConfirm={() => deleting && del.mutate({ orgId, profileId: deleting.id })}
      />
    </PageContainer>
  );
}
