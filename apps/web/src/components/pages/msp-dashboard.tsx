'use client';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Handshake } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/common/empty-state';
import { ProviderBrandSetting } from '@/components/common/provider-brand-setting';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

const ROLE_WORDS: Record<string, string> = {
  manage: 'Manage',
  support: 'Support',
  view: 'View only',
};

/** A service provider's home: its customers at a glance, invitations, and how customers find it. */
export function MspDashboard() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, isOwner } = useOrg();
  const data = useQuery({
    ...trpc.msp.dashboard.queryOptions({ orgId }),
    refetchInterval: 30_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.msp.dashboard.queryKey({ orgId }) });
  const respond = useMutation(
    trpc.msp.respond.mutationOptions({
      onSuccess: async (_r, vars) => {
        await refresh();
        toast.success(vars.accept ? 'Connected' : 'Declined');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const end = useMutation(
    trpc.msp.endCustomer.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast.success('Connection ended');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success('Code copied');
    } catch {
      toast.error('Could not copy. Select the code and copy it by hand');
    }
  };

  if (data.isPending)
    return (
      <PageContainer>
        <Skeleton className="h-48 w-full" />
      </PageContainer>
    );
  if (data.error || !data.data)
    return (
      <PageContainer>
        <p className="text-sm text-destructive">{data.error?.message ?? 'Not available'}</p>
      </PageContainer>
    );
  const d = data.data;

  return (
    <PageContainer>
      <PageHeader
        title="Customers"
        description="The organisations that have connected to you. Open one to work in it with the access they gave you."
      />

      <section className="space-y-2 rounded-lg border p-4">
        <div className="text-sm font-medium">Your provider code</div>
        <p className="text-sm text-muted-foreground">
          Give this to a customer. Their owner enters it under Settings, Service providers, and you
          are asked to accept.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-muted px-2 py-1 text-sm break-all">{d.providerCode}</code>
          <Button size="sm" variant="outline" onClick={() => copy(d.providerCode)}>
            <Copy data-icon="inline-start" /> Copy
          </Button>
        </div>
      </section>

      <ProviderBrandSetting />

      {d.invites.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">Waiting for you</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {d.invites.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div>
                  <div className="font-medium">{i.customerName}</div>
                  <div className="text-xs text-muted-foreground">
                    Wants you to have {ROLE_WORDS[i.role]?.toLowerCase()} access to{' '}
                    {i.siteCount === 0
                      ? 'the whole organisation'
                      : `${i.siteCount} ${i.siteCount === 1 ? 'site' : 'sites'}`}
                    {i.invitedByEmail ? ` · invited by ${i.invitedByEmail}` : ''} ·{' '}
                    {timeAgo(i.createdAt)}
                  </div>
                </div>
                {isOwner ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={respond.isPending}
                      onClick={() => respond.mutate({ orgId, grantId: i.id, accept: true })}
                    >
                      <Check data-icon="inline-start" /> Accept
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={respond.isPending}
                      onClick={() => respond.mutate({ orgId, grantId: i.id, accept: false })}
                    >
                      Decline
                    </Button>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">An owner needs to answer</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.customers.length === 0 ? (
        <EmptyState
          icon={Handshake}
          title="No customers yet"
          description="When a customer invites you and you accept, they appear here."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Your access</th>
                <th className="px-3 py-2 text-right font-medium">Rooms</th>
                <th className="px-3 py-2 text-right font-medium">Gateways</th>
                <th className="px-3 py-2 text-right font-medium">Incidents</th>
                <th className="px-3 py-2 text-right font-medium">Tickets with you</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {d.customers.map((c) => (
                <tr key={c.grantId} className="hover:bg-muted/40">
                  <td className="px-3 py-2">
                    <Link href={orgPath(c.orgId)} className="font-medium hover:underline">
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {ROLE_WORDS[c.role]}
                    {c.limitedToSites > 0 &&
                      ` · ${c.limitedToSites} ${c.limitedToSites === 1 ? 'site' : 'sites'}`}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.rooms}</td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right tabular-nums',
                      c.gateways > c.gatewaysOnline && 'text-warning',
                    )}
                  >
                    {c.gatewaysOnline}/{c.gateways}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right tabular-nums',
                      c.openIncidents > 0 && 'font-medium text-destructive',
                    )}
                  >
                    {c.openIncidents}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.ticketsWithUs}</td>
                  <td className="px-3 py-2 text-right">
                    {isOwner && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={end.isPending}
                        onClick={() => {
                          if (window.confirm(`End your connection with ${c.name}?`))
                            end.mutate({ orgId, grantId: c.grantId });
                        }}
                      >
                        End
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageContainer>
  );
}
