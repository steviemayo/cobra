'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { StaffRole } from '@kestrel/model';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { formatDate } from '@/lib/format';
import { useTRPC } from '@/trpc/client';

const ROLE_HELP: Record<StaffRole, string> = {
  admin: 'Everything, including this page',
  support: 'Tickets, support sessions, notes',
  billing: 'Licences and trials',
  readonly: 'Look only',
};

/** Who can use the staff portal, and what they can do. Admin only. */
export function StaffTeam() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const team = useQuery(trpc.staff.team.list.queryOptions());
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<StaffRole[]>(['support']);
  const [removing, setRemoving] = useState<{ userId: string; email: string | null } | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: trpc.staff.team.list.queryKey() });
  const set = useMutation(
    trpc.staff.team.set.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Saved');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const add = useMutation(
    trpc.staff.team.set.mutationOptions({
      onSuccess: async () => {
        setEmail('');
        await refresh();
        toast.success('Added');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const remove = useMutation(
    trpc.staff.team.remove.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Removed');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const toggle = (current: StaffRole[], role: StaffRole, on: boolean) =>
    on ? [...new Set([...current, role])] : current.filter((r) => r !== role);

  return (
    <PageContainer>
      <PageHeader
        title="Staff team"
        description="Who can use the staff portal. Every change is written to the staff audit trail."
      />

      <form
        className="space-y-3 rounded-lg border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate({ email, roles });
        }}
      >
        <h2 className="text-sm font-medium">Add someone</h2>
        <p className="text-xs text-muted-foreground">
          They need a Kestrel account first (they sign up like anyone else).
        </p>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="staff-email">Email</Label>
            <Input
              id="staff-email"
              type="email"
              required
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={add.isPending || roles.length === 0 || !email.trim()}>
            {add.isPending && <Spinner />} Add
          </Button>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {StaffRole.options.map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm" title={ROLE_HELP[r]}>
              <Checkbox
                checked={roles.includes(r)}
                onCheckedChange={(on) => setRoles((cur) => toggle(cur, r, !!on))}
              />
              {r}
            </label>
          ))}
        </div>
      </form>

      {team.isPending && <Skeleton className="h-40 w-full" />}
      {team.error && <p className="text-sm text-destructive">{team.error.message}</p>}
      {team.data && (
        <ul className="divide-y rounded-lg border text-sm">
          {team.data.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-3">
              <div className="min-w-48 flex-1">
                <div className="font-medium">{m.email ?? 'No email'}</div>
                <div className="text-xs text-muted-foreground">Added {formatDate(m.createdAt)}</div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {StaffRole.options.map((r) => (
                  <label key={r} className="flex items-center gap-1.5" title={ROLE_HELP[r]}>
                    <Checkbox
                      checked={m.roles.includes(r)}
                      disabled={set.isPending}
                      onCheckedChange={(on) => {
                        const next = toggle(m.roles as StaffRole[], r, !!on);
                        if (next.length === 0)
                          return toast.error(
                            'Someone needs at least one role. Remove them instead.',
                          );
                        set.mutate({ email: m.email ?? '', roles: next });
                      }}
                    />
                    {r}
                  </label>
                ))}
              </div>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove ${m.email ?? 'this person'}`}
                onClick={() => setRemoving({ userId: m.userId, email: m.email })}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.email ?? 'this person'} from staff?`}
        description="They lose access to the staff portal straight away. Their account and anything they did stay."
        confirmLabel="Remove"
        destructive
        onConfirm={() => removing && remove.mutate({ userId: removing.userId })}
      />
    </PageContainer>
  );
}
