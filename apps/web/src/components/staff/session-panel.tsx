'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { hasStaffRole } from '@kestrel/model';
import { SimpleSelect } from '@/components/common/simple-select';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useTRPC } from '@/trpc/client';

const MINUTES = [
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
  { value: '120', label: '2 hours' },
];

/**
 * Work inside this organisation as it sees itself. Needs a reason and an end time; the
 * organisation is told, and every change made in an "act" session is logged.
 */
export function SessionPanel({ orgId, blocked }: { orgId: string; blocked: boolean }) {
  const trpc = useTRPC();
  const router = useRouter();
  const me = useQuery(trpc.staff.me.queryOptions());
  const tickets = useQuery(trpc.staff.session.tickets.queryOptions({ orgId }));
  const canAct = hasStaffRole(me.data?.roles ?? [], 'support');

  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('30');
  const [ticketId, setTicketId] = useState('');
  const [act, setAct] = useState(false);
  const [understood, setUnderstood] = useState(false);

  const start = useMutation(
    trpc.staff.session.start.mutationOptions({
      onSuccess: (res) => router.push(`/o/${res.orgId}`),
      onError: (e) => toast.error(e.message),
    }),
  );

  const ready =
    reason.trim().length >= 5 && (!blocked || ticketId) && (!act || understood) && !start.isPending;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Open this organisation as its users see it</h2>
      <form
        className="space-y-3 rounded-lg border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          start.mutate({
            orgId,
            mode: act ? 'act' : 'read',
            reason,
            minutes: Number(minutes),
            ticketId: ticketId || null,
          });
        }}
      >
        {blocked && (
          <p className="text-sm text-warning">
            This organisation requires a linked open support ticket before staff can open a session.
          </p>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="sess-reason">Reason (the organisation is shown this)</Label>
          <Textarea
            id="sess-reason"
            rows={2}
            maxLength={500}
            placeholder="e.g. Looking into why Room 2 will not start (ticket from Sam)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sess-minutes">Length</Label>
            <SimpleSelect
              id="sess-minutes"
              className="w-full"
              value={minutes}
              onValueChange={setMinutes}
              options={MINUTES}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sess-ticket">
              Support ticket{blocked ? ' (required)' : ' (optional)'}
            </Label>
            <SimpleSelect
              id="sess-ticket"
              className="w-full"
              value={ticketId}
              placeholder={tickets.data?.length ? 'Choose a ticket' : 'No open tickets'}
              onValueChange={setTicketId}
              options={[
                ...(blocked ? [] : [{ value: '', label: 'None' }]),
                ...(tickets.data ?? []).map((t) => ({ value: t.id, label: t.title })),
              ]}
            />
          </div>
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={act}
              disabled={!canAct}
              onCheckedChange={(on) => {
                setAct(!!on);
                if (!on) setUnderstood(false);
              }}
            />
            Let me make changes (default is view only)
            {!canAct && (
              <span className="text-xs text-muted-foreground">needs the support role</span>
            )}
          </label>
          {act && (
            <label className="flex items-center gap-2 text-sm text-warning">
              <Checkbox checked={understood} onCheckedChange={(on) => setUnderstood(!!on)} />
              Every change is logged against my name and shown in the organisation’s activity log.
            </label>
          )}
        </div>
        <Button type="submit" disabled={!ready}>
          {start.isPending && <Spinner />} Open {act ? 'as support' : 'view only'}
        </Button>
      </form>
    </section>
  );
}
