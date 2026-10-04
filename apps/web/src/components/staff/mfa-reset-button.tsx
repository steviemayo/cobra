'use client';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { hasStaffRole } from '@kestrel/model';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useTRPC } from '@/trpc/client';

/**
 * Clears someone's authenticator apps so they can set up a new one (a lost phone). Needs the support
 * role and a reason; it is recorded in the organisation's activity and the staff audit trail.
 */
export function MfaResetButton({ orgId, userId }: { orgId: string; userId: string }) {
  const trpc = useTRPC();
  const me = useQuery(trpc.staff.me.queryOptions());
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const reset = useMutation(
    trpc.staff.mfa.reset.mutationOptions({
      onSuccess: (res) => {
        setOpen(false);
        setReason('');
        toast.success(
          res.removed
            ? 'Cleared. They can set up a new authenticator app at their next sign-in.'
            : 'They had no authenticator app set up.',
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (!hasStaffRole(me.data?.roles ?? [], 'support')) return null;

  if (!open)
    return (
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Reset two-step
      </Button>
    );
  return (
    <span className="flex items-center gap-1.5">
      <Input
        className="h-7 w-44 text-xs"
        aria-label="Reason"
        placeholder="Reason (lost phone)"
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button
        size="xs"
        variant="destructive"
        disabled={reset.isPending || reason.trim().length < 5}
        onClick={() => reset.mutate({ orgId, userId, reason: reason.trim() })}
      >
        {reset.isPending && <Spinner />}
        Reset
      </Button>
      <Button size="xs" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </span>
  );
}
