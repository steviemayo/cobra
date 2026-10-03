'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOrg } from '@/components/shell/org-context';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useTRPC } from '@/trpc/client';

/** Each person's own choice: show the "since you were last here" recap when they come back. */
export function RecapSetting() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const pref = useQuery(trpc.recap.preference.queryOptions({ orgId }));
  const save = useMutation(
    trpc.recap.setSilenced.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.recap.preference.queryKey() }),
    }),
  );
  // Provider staff and support sessions have no membership here, so there is nothing to switch.
  if (!pref.data?.available) return null;
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border px-4 py-3">
      <div>
        <Label htmlFor="recap-on">Login recap</Label>
        <p className="text-sm text-muted-foreground">
          When you come back after a while, summarise the incidents, tickets and changes you missed.
          This is your own setting.
        </p>
      </div>
      <Switch
        id="recap-on"
        checked={!pref.data.silenced}
        disabled={save.isPending}
        onCheckedChange={(on) => save.mutate({ orgId, silenced: !on })}
      />
    </div>
  );
}
