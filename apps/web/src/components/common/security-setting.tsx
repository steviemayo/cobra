'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { createSupabaseBrowser } from '@/lib/supabase/client';
import { useTRPC } from '@/trpc/client';

/**
 * Two-step sign-in (LR-15). Anyone can set up an authenticator app for their own sign-in. An owner
 * can require it for the organisation's owners and developers, and sees who has not set it up yet.
 */
export function SecuritySetting() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, role, isOwner } = useOrg();
  const [supabase] = useState(() => createSupabaseBrowser());
  // Whether this person has an authenticator app: null until it has been looked up.
  const [factorId, setFactorId] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const security = useQuery(trpc.org.getSecurity.queryOptions({ orgId }));
  const required = security.data?.requireMfa ?? false;
  const mustKeep = required && (role === 'owner' || role === 'dev');

  useEffect(() => {
    let cancelled = false;
    void supabase.auth.mfa.listFactors().then(({ data }) => {
      if (!cancelled) setFactorId(data?.totp[0]?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const save = useMutation(
    trpc.org.setRequireMfa.mutationOptions({
      onSuccess: async (res) => {
        await Promise.all([
          qc.invalidateQueries({ queryKey: trpc.org.getSecurity.queryKey({ orgId }) }),
          qc.invalidateQueries({ queryKey: trpc.audit.list.queryKey() }),
        ]);
        toast.success(
          res.requireMfa
            ? 'Owners and developers now need an authenticator app.'
            : 'An authenticator app is optional again.',
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const remove = async () => {
    if (!factorId) return;
    setBusy(true);
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    setBusy(false);
    if (error) {
      toast.error(
        error.message.toLowerCase().includes('aal2')
          ? 'Sign in again with your code first, then remove it.'
          : error.message,
      );
      return;
    }
    setFactorId(null);
    toast.success('Authenticator app removed.');
  };

  const setupHref = `/auth/mfa?next=${encodeURIComponent(orgPath(orgId, '/settings'))}`;
  const missing = (security.data?.members ?? []).filter((m) => !m.enrolled);

  return (
    <section className="space-y-4 border-t pt-6">
      <div>
        <h2 className="text-sm font-medium">Two-step sign-in</h2>
        <p className="text-sm text-muted-foreground">
          Use an authenticator app on your phone to give a 6-digit code when you sign in, so a
          stolen password is not enough.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>Your sign-in:</span>
        {factorId === undefined ? (
          <span className="text-muted-foreground">Checking</span>
        ) : factorId ? (
          <>
            <Badge>On</Badge>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || mustKeep}
              onClick={() => void remove()}
            >
              Turn off
            </Button>
            {mustKeep && (
              <span className="text-xs text-muted-foreground">
                Your organisation requires it for owners and developers.
              </span>
            )}
          </>
        ) : (
          <>
            <Badge variant="secondary">Off</Badge>
            <Button size="sm" render={<Link href={setupHref} />}>
              Set up
            </Button>
          </>
        )}
      </div>

      {isOwner && (
        <div className="space-y-2 rounded-lg border p-4">
          <label className="flex items-start gap-3 text-sm">
            <Switch
              checked={required}
              disabled={security.isPending || save.isPending || (!required && !factorId)}
              onCheckedChange={(on) => save.mutate({ orgId, on: !!on })}
            />
            <span>
              Require an authenticator app for owners and developers
              <span className="block text-muted-foreground">
                They are asked to set one up the next time they open the portal, and cannot use it
                until they have. Other people can still choose to set one up.
                {!required && !factorId && ' Set up your own first.'}
              </span>
            </span>
          </label>
          {security.data && security.data.members.length > 0 && (
            <ul className="divide-y rounded-md border text-sm">
              {security.data.members.map((m) => (
                <li key={m.userId} className="flex items-center justify-between gap-2 px-3 py-2">
                  <span>
                    {m.email ?? m.userId}{' '}
                    <span className="text-muted-foreground">
                      ({m.role === 'owner' ? 'owner' : 'developer'})
                    </span>
                  </span>
                  {m.enrolled ? <Badge>On</Badge> : <Badge variant="secondary">Not set up</Badge>}
                </li>
              ))}
            </ul>
          )}
          {!required && missing.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {missing.length === 1 ? 'One person has' : `${missing.length} people have`} not set
              one up yet. They will be asked to when you switch this on.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
