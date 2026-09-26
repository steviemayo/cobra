'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Clock, Minus } from 'lucide-react';
import { toast } from 'sonner';
import { useOrg } from '@/components/shell/org-context';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { plural } from '@/lib/format';
import { useInvalidateEstate } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';

const WHAT = {
  publish_and_deploy: (n: number) => `New release ${n}, then deploy`,
  deploy: (n: number) => `Deploy release ${n}`,
  rollback: (n: number) => `Go back to release ${n}`,
  up_to_date: (n: number) => `Release ${n} is already running`,
  in_progress: (n: number) => `Release ${n} is already on its way`,
} as const;

/**
 * Deploy or roll back the rooms chosen on the Deployments page. It shows what will happen to each
 * room first. A room that cannot go is named with the reason and left out; the others still go.
 * "Canary first" sends to one room only, so the rest can wait until it is running.
 */
export function BulkDeployDialog({
  roomIds,
  mode,
  open,
  onOpenChange,
}: {
  roomIds: string[];
  mode: 'deploy' | 'rollback';
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const invalidateEstate = useInvalidateEstate();
  const [canary, setCanary] = useState(false);
  const preview = useQuery({
    ...trpc.deployment.bulkPreview.queryOptions({ orgId, roomIds, mode }),
    enabled: open && roomIds.length > 0,
    // The plan must reflect the rooms as they are now.
    staleTime: 0,
    gcTime: 0,
  });
  const run = useMutation(
    trpc.deployment.bulkDeploy.mutationOptions({
      onSuccess: async ({ results, skipped, blocked }) => {
        await Promise.all([
          qc.invalidateQueries({ queryKey: trpc.deployment.overview.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.deployment.list.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.deployment.roomStatus.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.release.list.queryKey() }),
          invalidateEstate(),
        ]);
        close(false);
        const verb = mode === 'rollback' ? 'Rolling back' : 'Deploying to';
        const notes = [
          skipped.length > 0 && `${skipped.length} skipped`,
          blocked.length > 0 && `${blocked.length} could not go`,
        ].filter(Boolean);
        toast.success(
          `${verb} ${plural(results.length, 'room')}${notes.length ? ` (${notes.join(', ')})` : ''}`,
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const plan = preview.data;
  const sendable = plan?.steps.filter((s) => s.action !== 'up_to_date' && s.action !== 'in_progress') ?? [];
  const canCanary = mode === 'deploy' && sendable.length > 1;
  const useCanary = canary && canCanary;
  const sending = useCanary ? sendable.slice(0, 1) : sendable;
  const noun = mode === 'rollback' ? 'Roll back' : 'Deploy';
  const close = (o: boolean) => {
    if (!o) setCanary(false);
    onOpenChange(o);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === 'rollback' ? 'Roll back' : 'Deploy'} {plural(roomIds.length, 'room')}
          </DialogTitle>
          <DialogDescription>
            {mode === 'rollback'
              ? 'Sends each room its previous release. Rooms with nothing earlier are left as they are.'
              : 'Each room gets a new release only if its design has changed. A room that cannot go is left out and the rest are sent.'}
          </DialogDescription>
        </DialogHeader>

        {preview.isPending && <Skeleton className="h-32 w-full" />}
        {preview.isError && <p className="text-sm text-destructive">{preview.error.message}</p>}

        {plan && plan.blocked.length > 0 && (
          <div className="space-y-1 rounded-md border border-destructive/40 p-3 text-sm">
            <p className="flex items-center gap-1.5 font-medium text-destructive">
              <AlertTriangle className="size-4" /> {plural(plan.blocked.length, 'room')} cannot go
            </p>
            <ul className="list-disc pl-5 text-muted-foreground">
              {plan.blocked.map((b) => (
                <li key={b.roomId}>
                  <span className="text-foreground">{b.name}</span>: {b.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {plan && plan.steps.length > 0 && (
          <ul className="max-h-64 divide-y overflow-auto rounded-md border text-sm">
            {plan.steps.map((s) => {
              const later = useCanary && s !== sendable[0] && sendable.includes(s);
              return (
                <li key={s.roomId} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span>{s.name}</span>
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    {later ? (
                      <>
                        <Clock className="size-3.5" /> Waits for the canary
                      </>
                    ) : (
                      <>
                        {s.action === 'up_to_date' || s.action === 'in_progress' ? (
                          <Minus className="size-3.5" />
                        ) : (
                          <Check className="size-3.5 text-success" />
                        )}
                        {WHAT[s.action](s.number)}
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {canCanary && (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={canary} onCheckedChange={(on) => setCanary(!!on)} className="mt-0.5" />
            <span>
              Send to one room first ({sendable[0]!.name})
              <span className="block text-xs text-muted-foreground">
                Check it is working, then open this again to send the rest.
              </span>
            </span>
          </label>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            disabled={!plan || sending.length === 0 || run.isPending}
            onClick={() =>
              run.mutate({
                orgId,
                mode,
                roomIds: useCanary ? sending.map((s) => s.roomId) : roomIds,
              })
            }
          >
            {run.isPending && <Spinner />}
            {plan && sending.length === 0
              ? 'Nothing to send'
              : `${noun} ${plural(sending.length, 'room')}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
