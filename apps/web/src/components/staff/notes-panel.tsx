'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { hasStaffRole } from '@kestrel/model';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { timeAgo } from '@/lib/format';
import { useTRPC } from '@/trpc/client';

/** Private notes about an organisation. Staff only: the organisation never sees them. */
export function NotesPanel({ orgId }: { orgId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const me = useQuery(trpc.staff.me.queryOptions());
  const notes = useQuery(trpc.staff.notes.list.queryOptions({ orgId }));
  const [body, setBody] = useState('');
  const canWrite =
    hasStaffRole(me.data?.roles ?? [], 'support') || hasStaffRole(me.data?.roles ?? [], 'billing');

  const add = useMutation(
    trpc.staff.notes.add.mutationOptions({
      onSuccess: async () => {
        setBody('');
        await qc.invalidateQueries({ queryKey: trpc.staff.notes.list.queryKey({ orgId }) });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Notes (staff only)</h2>
      {canWrite && (
        <form
          className="flex flex-col items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate({ orgId, body });
          }}
        >
          <Textarea
            aria-label="New note"
            rows={2}
            maxLength={2000}
            placeholder="Add a note"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={add.isPending || !body.trim()}>
            {add.isPending && <Spinner />} Add note
          </Button>
        </form>
      )}
      <ul className="divide-y rounded-lg border text-sm">
        {notes.data?.length === 0 && <li className="px-3 py-2 text-muted-foreground">None yet</li>}
        {notes.data?.map((n) => (
          <li key={n.id} className="space-y-0.5 px-3 py-2">
            <div className="whitespace-pre-wrap">{n.body}</div>
            <div className="text-xs text-muted-foreground">
              {n.author ?? 'staff'} · {timeAgo(n.createdAt)}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
