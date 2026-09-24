'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { DiffView } from '@/components/common/deploy-status';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useInvalidateEstate } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';

function useRefreshDeploys() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const invalidateEstate = useInvalidateEstate();
  return async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: trpc.release.list.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.deployment.roomStatus.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.deployment.overview.queryKey() }),
      qc.invalidateQueries({ queryKey: trpc.deployment.list.queryKey() }),
      invalidateEstate(),
    ]);
  };
}

/** Freeze the current design as a release, showing what has changed since the last one. */
export function PublishDialog({
  roomId,
  hasGateway,
  open,
  onOpenChange,
}: {
  roomId: string;
  hasGateway: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const refresh = useRefreshDeploys();
  const [deploy, setDeploy] = useState(true);
  const publish = useMutation(
    trpc.release.publish.mutationOptions({
      onSuccess: async (r) => {
        await refresh();
        onOpenChange(false);
        toast.success(r.deploymentId ? `Release ${r.number} published and on its way` : `Release ${r.number} published`);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish a release</DialogTitle>
          <DialogDescription>
            Freezes the current design as a signed release that can be deployed and rolled back to.
          </DialogDescription>
        </DialogHeader>
        {open && <DiffView roomId={roomId} />}
        <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-sm">
          <span>
            Deploy to the gateway right away
            {!hasGateway && <span className="block text-xs text-muted-foreground">Assign a gateway to this room first.</span>}
          </span>
          <Switch checked={deploy && hasGateway} disabled={!hasGateway} onCheckedChange={setDeploy} />
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={publish.isPending}
            onClick={() => publish.mutate({ orgId, roomId, deploy: deploy && hasGateway })}
          >
            {publish.isPending && <Spinner />}
            Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "2026-09-24T14:30" in the browser's own time zone, as datetime-local inputs expect. */
function localInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Send a release to the gateway now or at a chosen time. An older release than the running one is a rollback. */
export function DeployDialog({
  roomId,
  release,
  running,
  open,
  onOpenChange,
}: {
  roomId: string;
  release: { id: string; number: number };
  /** The release the room is currently set to run, to compare against. */
  running: { id: string; number: number } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const refresh = useRefreshDeploys();
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState(() => localInput(new Date(Date.now() + 3_600_000)));
  const rollback = !!running && release.number < running.number;
  const time = new Date(when);
  const timeOk = !later || (!Number.isNaN(time.getTime()) && time.getTime() > Date.now());

  const create = useMutation(
    trpc.deployment.create.mutationOptions({
      onSuccess: async (d) => {
        await refresh();
        onOpenChange(false);
        toast.success(
          d.status === 'scheduled'
            ? `Release ${release.number} scheduled`
            : rollback
              ? `Rolling back to release ${release.number}`
              : `Deploying release ${release.number}`,
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {rollback ? `Roll back to release ${release.number}` : `Deploy release ${release.number}`}
          </DialogTitle>
          <DialogDescription>
            The gateway checks the release and its devices first. If anything fails, the current release keeps running.
          </DialogDescription>
        </DialogHeader>
        {open && <DiffView roomId={roomId} toReleaseId={release.id} fromReleaseId={running?.id ?? null} />}
        <div className="space-y-3">
          <label className="flex items-center justify-between gap-3 text-sm">
            Schedule for later
            <Switch checked={later} onCheckedChange={setLater} />
          </label>
          {later && (
            <div className="space-y-1.5">
              <Label htmlFor="deploy-when">Start at</Label>
              <Input
                id="deploy-when"
                type="datetime-local"
                value={when}
                min={localInput(new Date())}
                onChange={(e) => setWhen(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                In your time zone. It starts within a minute of this time, once the gateway checks in.
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={rollback ? 'destructive' : 'default'}
            disabled={create.isPending || !timeOk}
            onClick={() =>
              create.mutate({
                orgId,
                roomId,
                releaseId: release.id,
                ...(later && { scheduledFor: time.toISOString() }),
              })
            }
          >
            {create.isPending && <Spinner />}
            {later ? 'Schedule' : rollback ? 'Roll back' : 'Deploy'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
