'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useTRPC } from '@/trpc/client';

/**
 * Who can open a gateway's own page. People in the organisation sign in there with their Kestrel
 * account (owners and developers can change settings, everyone else can look). The admin code kept
 * on the gateway machine is a second way in, which an owner can switch off, and an owner can end
 * every sign-in made on those pages so far.
 */
export function GatewayAccessSetting() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, isOwner } = useOrg();
  const state = useQuery(trpc.org.getGatewayAccess.queryOptions({ orgId }));
  const on = state.data?.breakGlass ?? true;

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.org.getGatewayAccess.queryKey({ orgId }) }),
      qc.invalidateQueries({ queryKey: trpc.audit.list.queryKey() }),
    ]);
  const save = useMutation(
    trpc.org.setGatewayBreakGlass.mutationOptions({
      onSuccess: async (res) => {
        await refresh();
        toast.success(
          res.breakGlass
            ? 'The admin code on gateway machines works again.'
            : 'The admin code on gateway machines is switched off. Gateways pick this up at their next check-in.',
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const signOut = useMutation(
    trpc.org.signOutGatewayPages.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Everyone will be signed out of gateway pages at each gateway’s next check-in.');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <section className="space-y-4 border-t pt-6">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-medium">
          Gateway pages{' '}
          {state.data && (
            <Badge variant={on ? 'secondary' : 'default'}>
              {on ? 'Admin code allowed' : 'Kestrel sign-in only'}
            </Badge>
          )}
        </h2>
        <p className="text-sm text-muted-foreground">
          People in your organisation sign in to a gateway’s own page with their Kestrel account:
          owners and developers can change its settings, everyone else can only look. Every sign-in
          is recorded in the audit trail.
        </p>
      </div>
      {isOwner ? (
        <div className="space-y-3">
          <label className="flex items-start gap-3 rounded-lg border p-4 text-sm">
            <Switch
              checked={on}
              disabled={state.isPending || save.isPending}
              onCheckedChange={(next) => save.mutate({ orgId, on: !!next })}
            />
            <span>
              Allow the admin code kept on the gateway machine
              <span className="block text-muted-foreground">
                Anyone who can read the machine’s data folder can use it. Turn it off to require a
                Kestrel sign-in everywhere. A gateway that has not joined an organisation yet can
                always be set up from its own machine.
              </span>
            </span>
          </label>
          <div className="flex items-center justify-between gap-3 rounded-lg border p-4 text-sm">
            <span>
              Sign everyone out of gateway pages
              <span className="block text-muted-foreground">
                Ends every sign-in made so far, at each gateway’s next check-in (within a minute
                when it is online).
              </span>
            </span>
            <Button
              variant="outline"
              disabled={signOut.isPending}
              onClick={() => signOut.mutate({ orgId })}
            >
              Sign everyone out
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Only an owner can change this.</p>
      )}
    </section>
  );
}
