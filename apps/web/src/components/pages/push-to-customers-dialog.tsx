'use client';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/trpc/client';

/**
 * A service provider copies one of its own profiles or checklists to customers. The customer gets
 * its own copy to change; later changes here do not reach it.
 */
export function PushToCustomersDialog({
  kind,
  sourceId,
  name,
  onClose,
}: {
  kind: 'profile' | 'pm_template';
  sourceId: string;
  name: string;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const portfolio = useQuery(trpc.msp.portfolio.queryOptions({ orgId }));
  const [picked, setPicked] = useState<string[]>([]);
  const push = useMutation(
    trpc.msp.pushToCustomers.mutationOptions({
      onSuccess: (r) => {
        toast.success(
          `Copied to ${r.copied.length} customer${r.copied.length === 1 ? '' : 's'}${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`,
        );
        onClose();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  // Only customers that let this provider manage them can be given a copy.
  const customers = (portfolio.data?.customers ?? []).filter((c) => c.role === 'manage');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Copy {name} to customers</DialogTitle>
          <DialogDescription>
            Each customer gets its own copy. Only customers that let you manage them are listed.
          </DialogDescription>
        </DialogHeader>
        {portfolio.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : customers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No customer has given you manage access yet.
          </p>
        ) : (
          <div className="max-h-64 divide-y overflow-y-auto rounded-md border">
            {customers.map((c) => (
              <label
                key={c.orgId}
                className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/40"
              >
                <Checkbox
                  checked={picked.includes(c.orgId)}
                  onCheckedChange={(on) =>
                    setPicked((p) => (on ? [...p, c.orgId] : p.filter((x) => x !== c.orgId)))
                  }
                />
                {c.name}
              </label>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={picked.length === 0 || push.isPending}
            onClick={() => push.mutate({ orgId, kind, sourceId, customerOrgIds: picked })}
          >
            Copy to {picked.length || ''} customer{picked.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
