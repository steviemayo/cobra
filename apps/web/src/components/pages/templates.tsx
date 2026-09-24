'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, LayoutTemplate, Share2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { DEVICE_CATALOG } from '@kestrel/model';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { useBilling } from '@/components/common/plan-gate';
import { useOrg } from '@/components/shell/org-context';
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ROOM_TYPE_LABEL, formatDate } from '@/lib/format';
import { useTRPC } from '@/trpc/client';
import { PublishDialog } from './marketplace';

interface Row {
  id: string;
  name: string;
  description: string;
  roomType: 'meeting' | 'training';
  source: 'kestrel' | 'org';
  createdAt?: Date;
}

export function TemplatesView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canEdit } = useOrg();
  const list = useQuery(trpc.template.list.queryOptions({ orgId }));
  const [preview, setPreview] = useState<Row | null>(null);
  const [cloning, setCloning] = useState<Row | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [publishing, setPublishing] = useState<Row | null>(null);
  const canPublish = !!useBilling().data?.entitlements.marketplacePublish;

  const del = useMutation(
    trpc.template.delete.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: trpc.template.list.queryKey() });
        toast.success('Template deleted');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const rows: Row[] = [
    ...(list.data?.starters ?? []).map((t) => ({ ...t, source: 'kestrel' as const })),
    ...(list.data?.org ?? []).map((t) => ({ ...t, source: 'org' as const })),
  ];

  return (
    <PageContainer>
      <PageHeader
        title="Templates"
        description="Starting points for new rooms. Save any room’s design as a template from the designer."
      />
      {list.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={LayoutTemplate} title="No templates" />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Template</TableHead>
                <TableHead>Room type</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Created</TableHead>
                <TableHead className="w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <div className="font-medium">{t.name}</div>
                    {t.description && (
                      <div className="text-xs text-muted-foreground">{t.description}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {ROOM_TYPE_LABEL[t.roomType]}
                  </TableCell>
                  <TableCell>
                    <Badge variant={t.source === 'kestrel' ? 'secondary' : 'outline'}>
                      {t.source === 'kestrel' ? 'Kestrel' : 'Your organisation'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {t.createdAt ? formatDate(t.createdAt) : '—'}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Preview ${t.name}`}
                        onClick={() => setPreview(t)}
                      >
                        <Eye />
                      </Button>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Clone ${t.name}`}
                          onClick={() => setCloning(t)}
                        >
                          <Copy />
                        </Button>
                      )}
                      {canEdit && canPublish && t.source === 'org' && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Publish ${t.name} to the marketplace`}
                          onClick={() => setPublishing(t)}
                        >
                          <Share2 />
                        </Button>
                      )}
                      {canEdit && t.source === 'org' && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${t.name}`}
                          onClick={() => setDeleting(t)}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <PreviewSheet template={preview} onClose={() => setPreview(null)} />
      <CloneDialog template={cloning} onClose={() => setCloning(null)} />
      <PublishDialog template={publishing} onClose={() => setPublishing(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        destructive
        title={`Delete “${deleting?.name}”?`}
        description="Rooms already created from it are not affected."
        confirmLabel="Delete template"
        onConfirm={() => deleting && del.mutate({ orgId, templateId: deleting.id })}
      />
    </PageContainer>
  );
}

function PreviewSheet({ template, onClose }: { template: Row | null; onClose: () => void }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const model = useQuery({
    ...trpc.template.get.queryOptions({ orgId, templateId: template?.id ?? '' }),
    enabled: !!template,
  });
  return (
    <Sheet open={!!template} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{template?.name}</SheetTitle>
          <SheetDescription>{template?.description || 'Template contents'}</SheetDescription>
        </SheetHeader>
        <div className="space-y-5 overflow-y-auto px-4 pb-4 text-sm">
          {model.isPending ? (
            <Skeleton className="h-32 w-full" />
          ) : model.data ? (
            <>
              <section className="space-y-2">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Devices ({model.data.devices.length})
                </h3>
                {model.data.devices.length === 0 ? (
                  <p className="text-muted-foreground">Empty. You’ll add devices yourself.</p>
                ) : (
                  <ul className="divide-y rounded-md border">
                    {model.data.devices.map((d) => (
                      <li key={d.id} className="flex justify-between gap-3 px-3 py-2">
                        <span>{d.name}</span>
                        <span className="text-muted-foreground">
                          {DEVICE_CATALOG[d.category].label}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="space-y-2">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Activities ({model.data.activities.length})
                </h3>
                <p>
                  {model.data.activities.length
                    ? model.data.activities.map((a) => a.name).join(', ')
                    : 'None yet'}
                </p>
              </section>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function CloneDialog({ template, onClose }: { template: Row | null; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const [name, setName] = useState('');
  const clone = useMutation(
    trpc.template.clone.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: trpc.template.list.queryKey() });
        toast.success('Template cloned to your organisation');
        onClose();
      },
    }),
  );
  return (
    <Dialog
      open={!!template}
      onOpenChange={(o) => {
        if (o) setName(`${template?.name ?? ''} (copy)`);
        else onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (template)
              clone.mutate({
                orgId,
                templateId: template.id,
                name,
                description: template.description,
              });
          }}
        >
          <DialogHeader>
            <DialogTitle>Clone template</DialogTitle>
            <DialogDescription>
              Creates an editable copy in your organisation’s templates.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="clone-name">Name</Label>
            <Input
              id="clone-name"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {clone.error && <p className="text-sm text-destructive">{clone.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={clone.isPending || !name.trim()}>
              {clone.isPending && <Spinner />}
              Clone
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
