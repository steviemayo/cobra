'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Router } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { timeAgo } from '@/lib/format';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Unclaimed = RouterOutputs['staff']['gateways']['unclaimed'][number];

/**
 * Gateways that are running somewhere but have no definition in any organisation. Nothing here
 * happens on its own: staff confirm with the customer first, then give the gateway to the right
 * organisation and site, and it enrols itself.
 */
export function StaffGateways() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const list = useQuery({
    ...trpc.staff.gateways.unclaimed.queryOptions(),
    refetchInterval: 30_000,
  });
  const [assigning, setAssigning] = useState<Unclaimed | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const refresh = () =>
    qc.invalidateQueries({ queryKey: trpc.staff.gateways.unclaimed.queryKey() });
  const done = (message: string) => async () => {
    await refresh();
    toast.success(message);
  };
  const fail = (e: { message: string }) => toast.error(e.message);
  const dismiss = useMutation(
    trpc.staff.gateways.dismiss.mutationOptions({ onSuccess: done('Dismissed'), onError: fail }),
  );
  const reopen = useMutation(
    trpc.staff.gateways.reopen.mutationOptions({
      onSuccess: done('Back on the list'),
      onError: fail,
    }),
  );
  const release = useMutation(
    trpc.staff.gateways.release.mutationOptions({
      onSuccess: done('Claim taken back'),
      onError: fail,
    }),
  );
  const remove = useMutation(
    trpc.staff.gateways.delete.mutationOptions({ onSuccess: done('Removed'), onError: fail }),
  );

  const rows = list.data ?? [];
  const waiting = rows.filter((r) => r.status === 'open');
  const claimed = rows.filter((r) => r.status === 'claimed');
  const dismissed = rows.filter((r) => r.status === 'dismissed');
  const shown = [...waiting, ...claimed, ...(showDismissed ? dismissed : [])];

  return (
    <PageContainer wide>
      <PageHeader
        title="Unclaimed gateways"
        description="Gateways that are running but are not set up in any organisation. Confirm with the customer, then assign one to the right organisation and site."
        actions={
          dismissed.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => setShowDismissed((v) => !v)}>
              {showDismissed ? 'Hide' : 'Show'} {dismissed.length} dismissed
            </Button>
          )
        }
      />
      {list.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : list.error ? (
        <p className="text-sm text-destructive">{list.error.message}</p>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Router}
          title="Nothing waiting"
          description="A gateway that is installed without a working enrolment token shows up here within a minute."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Gateway</th>
                <th className="px-3 py-2 font-medium">Where it is</th>
                <th className="px-3 py-2 font-medium">Version</th>
                <th className="px-3 py-2 font-medium">First seen</th>
                <th className="px-3 py-2 font-medium">Last seen</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {shown.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.hostname ?? 'Unnamed machine'}</div>
                    <div className="text-xs text-muted-foreground">{r.os ?? 'Unknown system'}</div>
                    <div className="font-mono text-[11px] text-muted-foreground" title="Install id">
                      {r.installId.slice(0, 12)}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div>{r.publicIp ?? 'Unknown address'}</div>
                    {r.localAddresses.length > 0 && (
                      <div className="text-xs text-muted-foreground">
                        {r.localAddresses.join(', ')}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">
                    {r.version ?? '–'}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{timeAgo(r.firstSeenAt)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{timeAgo(r.lastSeenAt)}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {r.status === 'open' && (
                        <>
                          <Button size="sm" onClick={() => setAssigning(r)}>
                            Assign…
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={dismiss.isPending}
                            onClick={() => dismiss.mutate({ id: r.id })}
                          >
                            Dismiss
                          </Button>
                        </>
                      )}
                      {r.status === 'claimed' && (
                        <>
                          {r.claimed?.enrolled ? (
                            <Badge variant="secondary">
                              Connected as{' '}
                              <Link href={`/staff/orgs/${r.claimed.orgId}`} className="underline">
                                {r.claimed.name}
                              </Link>
                            </Badge>
                          ) : (
                            <>
                              <Badge variant="outline">Waiting for it to connect</Badge>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={release.isPending}
                                onClick={() => release.mutate({ id: r.id })}
                              >
                                Take back
                              </Button>
                            </>
                          )}
                        </>
                      )}
                      {r.status === 'dismissed' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => reopen.mutate({ id: r.id })}
                        >
                          Put back on the list
                        </Button>
                      )}
                      {r.status !== 'claimed' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate({ id: r.id })}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {assigning && (
        <AssignDialog
          gateway={assigning}
          onClose={() => setAssigning(null)}
          onDone={async () => {
            setAssigning(null);
            await refresh();
            toast.success('Assigned. The gateway picks up its enrolment token within a minute.');
          }}
        />
      )}
    </PageContainer>
  );
}

function AssignDialog({
  gateway,
  onClose,
  onDone,
}: {
  gateway: Unclaimed;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const trpc = useTRPC();
  const orgs = useQuery(trpc.staff.gateways.orgs.queryOptions());
  const [orgId, setOrgId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [name, setName] = useState(gateway.hostname ?? 'Gateway');
  const sites = useQuery({
    ...trpc.staff.gateways.sites.queryOptions({ orgId }),
    enabled: !!orgId,
  });
  const claim = useMutation(
    trpc.staff.gateways.claim.mutationOptions({
      onSuccess: onDone,
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign {gateway.hostname ?? 'this gateway'}</DialogTitle>
          <DialogDescription>
            Only after the customer has confirmed it is theirs (it announced itself from{' '}
            {gateway.publicIp ?? 'an unknown address'}). It becomes an ordinary gateway of the
            organisation and site you pick, and they can then assign rooms to it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="claim-org">Organisation</Label>
            <SimpleSelect
              id="claim-org"
              className="w-full"
              value={orgId}
              onValueChange={(v) => {
                setOrgId(v);
                setSiteId('');
              }}
              placeholder="Choose an organisation"
              options={(orgs.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="claim-site">Site</Label>
            <SimpleSelect
              id="claim-site"
              className="w-full"
              value={siteId}
              onValueChange={setSiteId}
              disabled={!orgId}
              placeholder={orgId ? 'Choose a site' : 'Choose an organisation first'}
              options={(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="claim-name">Name</Label>
            <Input id="claim-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!orgId || !siteId || !name.trim() || claim.isPending}
            onClick={() => claim.mutate({ id: gateway.id, orgId, siteId, name })}
          >
            {claim.isPending && <Spinner />}
            Assign gateway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
