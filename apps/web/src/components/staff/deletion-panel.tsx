'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { hasStaffRole } from '@kestrel/model';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { formatDate } from '@/lib/format';
import { useTRPC } from '@/trpc/client';

/**
 * Deleting an organisation (admin only). Scheduling switches it off at once and deletes it for good
 * after 30 days; until then it can be restored. The name has to be typed to confirm.
 */
export function DeletionPanel({
  orgId,
  name,
  deletedAt,
  deleteAfter,
  deleteReason,
}: {
  orgId: string;
  name: string;
  deletedAt: Date | null;
  deleteAfter: Date | null;
  deleteReason: string | null;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const me = useQuery(trpc.staff.me.queryOptions());
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const isAdmin = hasStaffRole(me.data?.roles ?? [], 'admin');
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.staff.orgs.get.queryKey({ orgId }) });

  const schedule = useMutation(
    trpc.staff.deletion.schedule.mutationOptions({
      onSuccess: async (r) => {
        setTyped('');
        setReason('');
        setOpen(false);
        await refresh();
        toast.success(
          `Scheduled. ${r.gatewaysReleased} gateway${r.gatewaysReleased === 1 ? '' : 's'} released.`,
        );
        for (const w of r.warnings) toast.warning(w, { duration: 15_000 });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const restore = useMutation(
    trpc.staff.deletion.restore.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success(
          'Restored. Its gateways must be enrolled again, its subscription started again, and its alert channels switched back on.',
          { duration: 15_000 },
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (!isAdmin && !deletedAt) return null;

  return (
    <section className="space-y-3 rounded-lg border border-destructive/30 p-4">
      <div>
        <h2 className="text-sm font-medium text-destructive">Delete this organisation</h2>
        <p className="text-sm text-muted-foreground">
          Switches it off now (nobody can sign in to it, its gateways are let go, its subscription
          is cancelled) and deletes everything in it for good after 30 days. The staff audit trail
          and which trials were used are kept.
        </p>
      </div>

      {deletedAt ? (
        <div className="space-y-2 text-sm">
          <p>
            <b>Scheduled for deletion</b> on {deleteAfter ? formatDate(deleteAfter) : 'a set day'}{' '}
            (switched off {formatDate(deletedAt)}).
            {deleteReason ? ` Reason: ${deleteReason}` : ''}
          </p>
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              disabled={restore.isPending}
              onClick={() => restore.mutate({ orgId })}
            >
              {restore.isPending && <Spinner />}
              Restore the organisation
            </Button>
          )}
        </div>
      ) : open ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            schedule.mutate({ orgId, confirmName: typed, reason });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="del-reason">Why (kept in the staff audit trail)</Label>
            <Textarea
              id="del-reason"
              required
              rows={2}
              maxLength={300}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="del-name">
              Type <b>{name}</b> to confirm
            </Label>
            <Input
              id="del-name"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="destructive"
              size="sm"
              disabled={schedule.isPending || typed !== name || !reason.trim()}
            >
              {schedule.isPending && <Spinner />}
              Schedule deletion
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
          Delete organisation
        </Button>
      )}
    </section>
  );
}
