'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { GRANT_ROLE_LABEL, GrantRole } from '@kestrel/model';
import { SimpleSelect } from '@/components/common/simple-select';
import { dateTime } from '@/components/common/health';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  // Whole organisation, or only the ticked sites.
  const [limited, setLimited] = useState(false);
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const sites = useQuery(trpc.site.list.queryOptions({ orgId }));
  const activity = useQuery({ ...trpc.msp.activity.queryOptions({ orgId }), retry: false });

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trpc.msp.providers.queryKey({ orgId }) }),
      qc.invalidateQueries({ queryKey: trpc.audit.list.queryKey() }),
    ]);
  const invite = useMutation(
    trpc.msp.invite.mutationOptions({
      onSuccess: async () => {
        setCode('');
        setLimited(false);
        setSiteIds([]);
        await refresh();
        toast.success('Invitation sent. They need to accept it');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const useBrand = useMutation(
    trpc.msp.useBrand.mutationOptions({
      onSuccess: async (_r, vars) => {
        await refresh();
        toast.success(vars.on ? 'Their branding is on' : 'Their branding is off');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setEnd = useMutation(
    trpc.msp.setEnd.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Saved');
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
          end it at any time. You can also show a connected provider’s name, logo and colour in your
          portal and, unless you set your own, on your room panels. You still pay Kestrel directly.
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
                {g.role === 'view' ? 'view only' : g.role} ·{' '}
                {g.siteNames.length === 0 ? 'whole organisation' : g.siteNames.join(', ')}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {g.status === 'active' && (
                <label
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                  title={g.hasBrand ? undefined : 'This provider has not set up its branding yet'}
                >
                  <Checkbox
                    checked={g.useBrand}
                    disabled={useBrand.isPending || (!g.hasBrand && !g.useBrand)}
                    onCheckedChange={(on) =>
                      useBrand.mutate({ orgId, grantId: g.id, on: on === true })
                    }
                  />
                  Show their name, logo and colour
                </label>
              )}
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Ends
                <Input
                  type="date"
                  className="h-7 w-36"
                  aria-label={`End date for ${g.mspName}`}
                  defaultValue={g.endsAt ? new Date(g.endsAt).toISOString().slice(0, 10) : ''}
                  onChange={(e) =>
                    setEnd.mutate({
                      orgId,
                      grantId: g.id,
                      endsAt: e.target.value ? new Date(`${e.target.value}T23:59:59`) : null,
                    })
                  }
                />
              </label>
              <Button
                size="sm"
                variant="ghost"
                disabled={end.isPending}
                onClick={() => end.mutate({ orgId, grantId: g.id })}
              >
                {g.status === 'pending' ? 'Withdraw' : 'End connection'}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <form
        className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          invite.mutate({ orgId, code, role, siteIds: limited ? siteIds : [] });
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
        <Button
          type="submit"
          disabled={
            invite.isPending || code.trim().length < 10 || (limited && siteIds.length === 0)
          }
        >
          {invite.isPending && <Spinner />} Invite
        </Button>
        <fieldset className="space-y-2 sm:col-span-3">
          <legend className="text-sm font-medium">Where</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" checked={!limited} onChange={() => setLimited(false)} />
            The whole organisation
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" checked={limited} onChange={() => setLimited(true)} />
            Only some sites
          </label>
          {limited && (
            <div className="ml-6 space-y-1">
              {sites.data?.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={siteIds.includes(s.id)}
                    onCheckedChange={(on) =>
                      setSiteIds((ids) => (on ? [...ids, s.id] : ids.filter((x) => x !== s.id)))
                    }
                  />
                  {s.name}
                </label>
              ))}
              <p className="text-xs text-muted-foreground">
                They see those sites’ rooms, gateways, monitoring and support requests, and nothing
                else. Design, deployment, team and settings stay with you.
              </p>
            </div>
          )}
        </fieldset>
      </form>

      {(activity.data ?? []).length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">What your providers did</h3>
          <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border text-sm">
            {activity.data!.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <span>
                  <span className="font-medium">{a.provider}</span> {a.action.replace(/[._]/g, ' ')}
                </span>
                <span className="text-xs text-muted-foreground">{dateTime(a.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
