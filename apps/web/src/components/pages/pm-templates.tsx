'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PM_AUTO_LABEL, PM_AUTO_SOURCES, assetCategoryLabel, type PmItem } from '@kestrel/model';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
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
import { Skeleton } from '@/components/ui/skeleton';
import { PushToCustomersDialog } from './push-to-customers-dialog';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Template = RouterOutputs['pm']['templates'][number];

const TYPES = [
  { value: 'passfail', label: 'Pass or fail' },
  { value: 'number', label: 'A number' },
  { value: 'text', label: 'A note' },
  { value: 'photo', label: 'A photo' },
];

const slug = (label: string, taken: Set<string>) => {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30) || 'item';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  return id;
};

function TemplateDialog({ template, onClose }: { template: Template | null; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const [name, setName] = useState(template?.name ?? '');
  const [appliesTo, setAppliesTo] = useState<'room' | 'device'>(
    (template?.appliesTo as 'room' | 'device') ?? 'room',
  );
  const [items, setItems] = useState<PmItem[]>(
    template?.items ?? [{ id: 'check', label: '', type: 'passfail' }],
  );
  const done = async () => {
    await qc.invalidateQueries({ queryKey: trpc.pm.templates.queryKey() });
    onClose();
  };
  const create = useMutation(
    trpc.pm.createTemplate.mutationOptions({
      onSuccess: done,
      onError: (e) => toast.error(e.message),
    }),
  );
  const update = useMutation(
    trpc.pm.updateTemplate.mutationOptions({
      onSuccess: done,
      onError: (e) => toast.error(e.message),
    }),
  );
  const set = (i: number, patch: Partial<PmItem>) =>
    setItems(items.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  const clean = items.filter((i) => i.label.trim()).map((i) => ({ ...i, label: i.label.trim() }));
  // Give each new item a stable id from its label.
  const withIds = clean.map((i, n) => {
    const taken = new Set(clean.slice(0, n).map((x) => x.id));
    return taken.has(i.id) || i.id === 'check' ? { ...i, id: slug(i.label, taken) } : i;
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{template ? `Edit ${template.name}` : 'New checklist'}</DialogTitle>
          <DialogDescription>
            A checklist for a room or a kind of device. Pass or fail items can be filled in from
            live data, so the person on site only confirms what they can see.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">For</Label>
              <SimpleSelect
                value={appliesTo}
                disabled={!!template}
                onValueChange={(v) => setAppliesTo(v as 'room' | 'device')}
                options={[
                  { value: 'room', label: 'A room' },
                  { value: 'device', label: 'A device' },
                ]}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label className="text-xs">Items</Label>
            {items.map((it, i) => (
              <div key={i} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="h-8 min-w-48 flex-1"
                    value={it.label}
                    onChange={(e) => set(i, { label: e.target.value })}
                    placeholder="What to check"
                    maxLength={200}
                  />
                  <SimpleSelect
                    size="sm"
                    className="w-36"
                    value={it.type}
                    onValueChange={(v) =>
                      set(i, {
                        type: v as PmItem['type'],
                        auto: v === 'passfail' ? it.auto : undefined,
                      })
                    }
                    options={TYPES}
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Remove"
                    onClick={() => setItems(items.filter((_, n) => n !== i))}
                  >
                    <Trash2 />
                  </Button>
                </div>
                {it.type === 'number' && (
                  <div className="flex flex-wrap gap-2 text-xs">
                    <Input
                      className="h-8 w-24"
                      placeholder="Unit"
                      value={it.unit ?? ''}
                      onChange={(e) => set(i, { unit: e.target.value || undefined })}
                      maxLength={20}
                    />
                    <Input
                      className="h-8 w-24"
                      type="number"
                      placeholder="Min"
                      value={it.min ?? ''}
                      onChange={(e) =>
                        set(i, { min: e.target.value === '' ? undefined : Number(e.target.value) })
                      }
                    />
                    <Input
                      className="h-8 w-24"
                      type="number"
                      placeholder="Max"
                      value={it.max ?? ''}
                      onChange={(e) =>
                        set(i, { max: e.target.value === '' ? undefined : Number(e.target.value) })
                      }
                    />
                    <span className="self-center text-muted-foreground">
                      Outside the limits counts as a failure.
                    </span>
                  </div>
                )}
                {it.type === 'passfail' && (
                  <SimpleSelect
                    size="sm"
                    className="w-full sm:w-96"
                    value={it.auto ?? '__none'}
                    onValueChange={(v) =>
                      set(i, { auto: v === '__none' ? undefined : (v as PmItem['auto']) })
                    }
                    options={[
                      { value: '__none', label: 'Answered by the person on site' },
                      ...PM_AUTO_SOURCES.filter((s) =>
                        appliesTo === 'room'
                          ? !['device_online', 'firmware_known'].includes(s)
                          : s !== 'devices_online',
                      ).map((s) => ({ value: s, label: `Filled in: ${PM_AUTO_LABEL[s]}` })),
                    ]}
                  />
                )}
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setItems([...items, { id: 'check', label: '', type: 'passfail' }])}
            >
              <Plus data-icon="inline-start" /> Add an item
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || withIds.length === 0 || create.isPending || update.isPending}
            onClick={() =>
              template
                ? update.mutate({
                    orgId,
                    templateId: template.id,
                    name: name.trim(),
                    items: withIds,
                  })
                : create.mutate({ orgId, name: name.trim(), appliesTo, items: withIds })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PmTemplatesView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport, isOwner, role, org } = useOrg();
  const [pushing, setPushing] = useState<Template | null>(null);
  const templates = useQuery(trpc.pm.templates.queryOptions({ orgId }));
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);
  const starters = useMutation(
    trpc.pm.addStarters.mutationOptions({
      onSuccess: async (r) => {
        toast.success(
          r.added ? `Added ${r.added} starter checklists` : 'You already have them all',
        );
        await qc.invalidateQueries({ queryKey: trpc.pm.templates.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const del = useMutation(
    trpc.pm.deleteTemplate.mutationOptions({
      onSuccess: async () => {
        toast.success('Checklist deleted');
        await qc.invalidateQueries({ queryKey: trpc.pm.templates.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <PageContainer>
      <PageHeader
        title="PM templates"
        description="Checklists for maintenance visits. Kestrel fills in what monitoring can tell it, and the person on site confirms the rest."
        actions={
          canSupport && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={starters.isPending}
                onClick={() => starters.mutate({ orgId })}
              >
                Add starter checklists
              </Button>
              <Button size="sm" onClick={() => setEditing('new')}>
                <Plus data-icon="inline-start" /> New checklist
              </Button>
            </>
          )
        }
      />
      {templates.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : templates.isError ? (
        <p className="text-sm text-destructive">{templates.error.message}</p>
      ) : templates.data.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No checklists yet"
          description="Start from Kestrel's meeting room, training room, display and camera checklists, then change them to suit."
          action={
            canSupport ? (
              <Button onClick={() => starters.mutate({ orgId })}>Add starter checklists</Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {templates.data.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  {t.name}
                  <Badge variant="secondary">
                    {t.appliesTo === 'room'
                      ? 'Room'
                      : t.category
                        ? assetCategoryLabel(t.category)
                        : 'Device'}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  {t.items.length} items, {t.items.filter((i) => i.auto).length} filled in from live
                  data · version {t.version}
                </div>
              </div>
              {canSupport && (
                <div className="flex gap-2">
                  {org.kind === 'msp' && (
                    <Button size="xs" variant="outline" onClick={() => setPushing(t)}>
                      Copy to customers
                    </Button>
                  )}
                  {org.kind === 'msp' && (
                    <Button size="xs" variant="outline" onClick={() => setPushing(t)}>
                      Copy to customers
                    </Button>
                  )}
                  <Button size="xs" variant="outline" onClick={() => setEditing(t)}>
                    Edit
                  </Button>
                  {(isOwner || role === 'dev') && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Delete ${t.name}`}
                      onClick={() => setDeleting(t)}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {pushing && (
        <PushToCustomersDialog
          kind="pm_template"
          sourceId={pushing.id}
          name={pushing.name}
          onClose={() => setPushing(null)}
        />
      )}
      {editing && (
        <TemplateDialog
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description="Visits already signed off keep their record. A checklist with a schedule cannot be deleted."
        confirmLabel="Delete"
        destructive
        onConfirm={() => deleting && del.mutate({ orgId, templateId: deleting.id })}
      />
    </PageContainer>
  );
}
