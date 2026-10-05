'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cable } from 'lucide-react';
import { toast } from 'sonner';
import {
  DRIVER_REQUEST_PROTOCOL_LABEL,
  DRIVER_REQUEST_STATUS_LABEL,
  assetCategoryLabel,
  type DriverRequestStatus,
} from '@kestrel/model';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { timeAgo } from '@/lib/format';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Row = RouterOutputs['staff']['driverRequests']['list'][number];

const FILTERS = [
  { value: 'active', label: 'Waiting' },
  { value: 'built', label: 'Built' },
  { value: 'declined', label: 'Declined' },
  { value: 'all', label: 'All' },
];

/**
 * Customers asking for a driver for a device that has none. Building one saves it as a custom driver
 * inside the asking organisation, so it stays private to them until Kestrel promotes it.
 */
export function StaffDriverRequests() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'active' | 'built' | 'declined' | 'all'>('active');
  const list = useQuery(trpc.staff.driverRequests.list.queryOptions({ status: filter }));
  const [working, setWorking] = useState<Row | null>(null);
  const update = useMutation(
    trpc.staff.driverRequests.update.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: trpc.staff.driverRequests.list.queryKey() });
        toast.success('Saved');
        setWorking(null);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const rows = list.data ?? [];

  return (
    <PageContainer wide>
      <PageHeader
        title="Driver requests"
        description="Devices customers have no driver for. Several organisations asking for the same device is a good reason to build it once and promote it."
        actions={
          <SimpleSelect
            className="w-40"
            value={filter}
            onValueChange={(v) => setFilter(v as typeof filter)}
            options={FILTERS}
          />
        }
      />
      {list.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : list.error ? (
        <p className="text-sm text-destructive">{list.error.message}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Cable}
          title="No requests"
          description="Requests from the “Request a driver” button in the device driver list show up here."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Device</th>
                <th className="px-3 py-2 font-medium">Organisation</th>
                <th className="px-3 py-2 font-medium">Needs</th>
                <th className="px-3 py-2 font-medium">Asked</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium">
                      {r.make} {r.model}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {assetCategoryLabel(r.category)}
                      {r.orgsAsking > 1 && ` · ${r.orgsAsking} organisations asking`}
                    </div>
                  </td>
                  <td className="px-3 py-2">{r.orgName}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.need === 'control' ? 'Monitor and control' : 'Monitor'}
                    <div className="text-xs">
                      {
                        DRIVER_REQUEST_PROTOCOL_LABEL[
                          r.protocol as keyof typeof DRIVER_REQUEST_PROTOCOL_LABEL
                        ]
                      }
                    </div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{timeAgo(r.createdAt)}</td>
                  <td className="px-3 py-2">
                    <Badge variant={r.status === 'built' ? 'default' : 'secondary'}>
                      {DRIVER_REQUEST_STATUS_LABEL[r.status as DriverRequestStatus] ?? r.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => setWorking(r)}>
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {working && (
        <WorkDialog
          row={working}
          pending={update.isPending}
          onClose={() => setWorking(null)}
          onSave={(patch) => update.mutate({ id: working.id, ...patch })}
        />
      )}
    </PageContainer>
  );
}

function WorkDialog({
  row,
  pending,
  onClose,
  onSave,
}: {
  row: Row;
  pending: boolean;
  onClose: () => void;
  onSave: (patch: { status?: DriverRequestStatus; staffNote?: string; spec?: unknown }) => void;
}) {
  const [note, setNote] = useState(row.staffNote ?? '');
  const [spec, setSpec] = useState('');
  const [error, setError] = useState<string | null>(null);

  const saveSpec = () => {
    try {
      const parsed = JSON.parse(spec) as unknown;
      setError(null);
      onSave({ spec: parsed, staffNote: note });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Not valid JSON');
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {row.make} {row.model}
          </DialogTitle>
          <DialogDescription>
            {row.orgName} · {assetCategoryLabel(row.category)}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          {row.docsUrl && (
            <p>
              Documentation:{' '}
              <a className="underline" href={row.docsUrl} target="_blank" rel="noreferrer noopener">
                {row.docsUrl}
              </a>
            </p>
          )}
          {row.notes && <p className="whitespace-pre-wrap text-muted-foreground">{row.notes}</p>}
          {row.ticketId && (
            <Link className="underline" href={`/staff/tickets/${row.ticketId}`}>
              Open the ticket
            </Link>
          )}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Note to the customer or the team</p>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} />
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              Finished driver (Kestrel driver format, JSON). Saved into {row.orgName} only, and marks the
              request built.
            </p>
            <Textarea
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
              rows={8}
              className="font-mono text-xs"
              placeholder='{ "id": "...", "name": "...", "make": "...", "model": "...", "categories": ["..."], "transport": { "type": "tcp" }, ... }'
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </div>
        <DialogFooter className="flex-wrap gap-2">
          <Button
            variant="ghost"
            disabled={pending || row.status === 'declined'}
            onClick={() => onSave({ status: 'declined', staffNote: note })}
          >
            Decline
          </Button>
          <Button
            variant="outline"
            disabled={pending || row.status === 'in_progress'}
            onClick={() => onSave({ status: 'in_progress', staffNote: note })}
          >
            Mark in progress
          </Button>
          <Button disabled={pending || spec.trim() === ''} onClick={saveSpec}>
            Save driver and mark built
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
