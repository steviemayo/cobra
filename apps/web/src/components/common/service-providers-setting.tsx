'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { GRANT_ROLE_LABEL, GrantRole } from '@kestrel/model';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { useTRPC } from '@/trpc/client';

const ROLE_OPTIONS = GrantRole.options.map((value) => ({
  value,
  label: GRANT_ROLE_LABEL[value],
}));

/**
 * Owners connect a managed service provider that looks after this organisation. The provider has
 * to accept, only ever gets the access chosen here (never billing, team or settings), and either
 * side can end it at any time.
 */
export function ServiceProvidersSetting() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const list = useQuery(trpc.msp.providers.queryOptions({ orgId }));
  const [code, setCode] = useState('');
  const [role, setRole] = useState<GrantRole>('manage');

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.msp.providers.queryKey({ orgId }) }),
      qc.invalidateQueries({ queryKey: trpc.audit.list.queryKey() }),
    ]);
  const invite = useMutation(
    trpc.msp.invite.mutationOptions({
      onSuccess: async () => {
        setCode('');
        await refresh();
        toast.success('Invitation sent. They need to accept it');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const end = useMutation(
    trpc.msp.end.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Done');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <section className="space-y-3 border-t pt-6">
      <div>
        <h2 className="text-sm font-medium">Service providers</h2>
        <p className="text-sm text-muted-foreground">
          Let a managed service provider look after this organisation. Ask them for their provider
          code. They only get the access you choose, never billing, team or settings, and you can
          end it at any time.
        </p>
      </div>

      <ul className="divide-y rounded-lg border text-sm">
        {list.data?.length === 0 && (
          <li className="px-3 py-2 text-muted-foreground">No service providers</li>
        )}
        {list.data?.map((g) => (
          <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <div>
              <span className="font-medium">{g.mspName}</span>{' '}
              <span className="text-xs text-muted-foreground">
                {g.status === 'pending' ? 'waiting for them to accept' : 'connected'} ·{' '}
                {g.role === 'view' ? 'view only' : g.role}
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={end.isPending}
              onClick={() => end.mutate({ orgId, grantId: g.id })}
            >
              {g.status === 'pending' ? 'Withdraw' : 'End connection'}
            </Button>
          </li>
        ))}
      </ul>

      <form
        className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          invite.mutate({ orgId, code, role });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="msp-code">Provider code</Label>
          <Input
            id="msp-code"
            placeholder="Paste the code they gave you"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="msp-role">Access</Label>
          <SimpleSelect
            id="msp-role"
            className="w-full"
            value={role}
            onValueChange={setRole}
            options={ROLE_OPTIONS}
          />
        </div>
        <Button type="submit" disabled={invite.isPending || code.trim().length < 10}>
          {invite.isPending && <Spinner />} Invite
        </Button>
      </form>
    </section>
  );
}
