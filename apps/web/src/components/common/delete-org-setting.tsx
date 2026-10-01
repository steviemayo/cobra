'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useTRPC } from '@/trpc/client';

/**
 * An owner asks for the organisation to be deleted. Nothing is deleted here: it opens a ticket for
 * Kestrel, who confirm it with the owner and schedule it themselves (and it can be undone for 30
 * days after that).
 */
export function DeleteOrgSetting() {
  const trpc = useTRPC();
  const { orgId, role } = useOrg();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [ticketId, setTicketId] = useState<string | null>(null);
  const request = useMutation(
    trpc.org.requestDeletion.mutationOptions({
      onSuccess: (r) => {
        setTicketId(r.ticketId);
        setOpen(false);
        toast.success(
          r.alreadyRequested
            ? 'A request is already open. Kestrel will be in touch.'
            : 'Request sent. Nothing is deleted yet: Kestrel will confirm with you first.',
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (role !== 'owner') return null;

  return (
    <section className="space-y-3 rounded-lg border border-destructive/30 p-4">
      <div>
        <h2 className="text-sm font-medium text-destructive">Delete this organisation</h2>
        <p className="text-sm text-muted-foreground">
          Removes the organisation and everything in it: sites, rooms, devices, history, tickets and
          team. You can’t do this yourself. Ask Kestrel and they will confirm it with you, then
          switch the organisation off and delete it for good 30 days later. Until then it can be
          restored. Cancel any paid callouts first.
        </p>
      </div>
      {ticketId ? (
        <p className="text-sm">
          Requested.{' '}
          <Link href={orgPath(orgId, `/tickets/${ticketId}`)} className="underline">
            See the ticket
          </Link>
          .
        </p>
      ) : open ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            request.mutate({ orgId, reason });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="del-why">Why are you leaving? (optional)</Label>
            <Textarea
              id="del-why"
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="destructive" size="sm" disabled={request.isPending}>
              {request.isPending && <Spinner />}
              Ask Kestrel to delete it
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Request deletion
        </Button>
      )}
    </section>
  );
}
