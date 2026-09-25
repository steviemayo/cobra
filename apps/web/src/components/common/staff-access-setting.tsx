'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useOrg } from '@/components/shell/org-context';
import { Switch } from '@/components/ui/switch';
import { useTRPC } from '@/trpc/client';

/**
 * Owners decide whether Kestrel staff may open a support session here on their own. When it is
 * on, staff can only open one after you raise a support ticket and they link it.
 */
export function StaffAccessSetting() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const setting = useQuery(trpc.org.getStaffAccess.queryOptions({ orgId }));
  const save = useMutation(
    trpc.org.setStaffAccess.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          qc.invalidateQueries({ queryKey: trpc.org.getStaffAccess.queryKey({ orgId }) }),
          qc.invalidateQueries({ queryKey: trpc.audit.list.queryKey() }),
        ]);
        toast.success('Saved');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <section className="space-y-3 border-t pt-6">
      <div>
        <h2 className="text-sm font-medium">Kestrel staff access</h2>
        <p className="text-sm text-muted-foreground">
          Kestrel staff can open a support session here to help you. You always see when one starts,
          why, and every change they make. Turn this on to make them wait for a support ticket from
          you first.
        </p>
      </div>
      <label className="flex items-center gap-3 text-sm">
        <Switch
          checked={setting.data?.blocked ?? false}
          disabled={setting.isPending || save.isPending}
          onCheckedChange={(blocked) => save.mutate({ orgId, blocked: !!blocked })}
        />
        Only allow Kestrel staff in when I have raised a support ticket
      </label>
    </section>
  );
}
