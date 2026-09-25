'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Minus } from 'lucide-react';
import { toast } from 'sonner';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useInvalidateEstate } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';

const WHAT = {
  publish_and_deploy: (n: number) => `New release ${n}, then deploy`,
  deploy: (n: number) => `Deploy release ${n}`,
  up_to_date: (n: number) => `Release ${n} is already running`,
} as const;

/**
 * Deploy every room of a group, and its combined rooms, as one action. It shows what will happen
 * to each room first, and refuses (naming every problem) rather than deploy part of a group.
 */
export function GroupDeployDialog({
  groupId,
  open,
  onOpenChange,
}: {
  groupId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const invalidateEstate = useInvalidateEstate();
  const preview = useQuery({
    ...trpc.roomGroup.deployPreview.queryOptions({ orgId, groupId }),
    enabled: open,
    // The plan must reflect the designs as they are now.
    staleTime: 0,
    gcTime: 0,
  });
  const deploy = useMutation(
    trpc.roomGroup.deploy.mutationOptions({
      onSuccess: async ({ results }) => {
        await Promise.all([
          qc.invalidateQueries({ queryKey: trpc.deployment.overview.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.deployment.roomStatus.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.release.list.queryKey() }),
          invalidateEstate(),
        ]);
        onOpenChange(false);
        const sent = results.filter((r) => r.deployed).length;
        toast.success(
          sent === 0
            ? 'Everything in this group is already running'
            : `Deploying ${sent} room${sent === 1 ? '' : 's'}`,
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const plan = preview.data;
  const sends = plan?.steps.filter((s) => s.action !== 'up_to_date').length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Deploy this group</DialogTitle>
          <DialogDescription>
            Sends every room and combined room to the gateway together. Each gets a new release only
            if its design has changed.
          </DialogDescription>
        </DialogHeader>

        {preview.isPending && <Skeleton className="h-32 w-full" />}
        {preview.isError && <p className="text-sm text-destructive">{preview.error.message}</p>}

        {plan && plan.problems.length > 0 && (
          <div className="space-y-1 rounded-md border border-destructive/40 p-3 text-sm">
            <p className="flex items-center gap-1.5 font-medium text-destructive">
              <AlertTriangle className="size-4" /> Nothing will be deployed until this is fixed
            </p>
            <ul className="list-disc pl-5 text-muted-foreground">
              {plan.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}

        {plan && plan.steps.length > 0 && (
          <ul className="divide-y rounded-md border text-sm">
            {plan.steps.map((s) => (
              <li key={s.roomId} className="flex items-center justify-between gap-3 px-3 py-2">
                <span>
                  {s.name}
                  {s.kind === 'combined' && (
                    <span className="ml-2 text-xs text-muted-foreground">combined</span>
                  )}
                </span>
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  {s.action === 'up_to_date' ? (
                    <Minus className="size-3.5" />
                  ) : (
                    <Check className="size-3.5 text-success" />
                  )}
                  {WHAT[s.action](s.number)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!plan || plan.problems.length > 0 || sends === 0 || deploy.isPending}
            onClick={() => deploy.mutate({ orgId, groupId })}
          >
            {deploy.isPending && <Spinner />}
            {sends === 0 && plan && plan.problems.length === 0
              ? 'Nothing to deploy'
              : `Deploy ${sends || ''} room${sends === 1 ? '' : 's'}`.replace('  ', ' ')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
