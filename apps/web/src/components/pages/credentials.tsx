'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/trpc/client';

const FIELD_HINTS = ['username', 'password', 'token', 'apiKey', 'pin'];

interface Row {
  key: string;
  value: string;
}

// Logins shared by many devices. Change one and every device using it gets the new value with no
// new release. Values are write-only: they can be replaced but never read back.
export function CredentialsView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canEdit } = useOrg();
  const list = useQuery({
    ...trpc.binding.credentialSets.list.queryOptions({ orgId }),
    enabled: canEdit,
  });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const refresh = () =>
    qc.invalidateQueries({ queryKey: trpc.binding.credentialSets.list.queryKey() });

  const del = useMutation(
    trpc.binding.credentialSets.delete.mutationOptions({
      onSuccess: async () => {
        toast.success('Shared login deleted');
        await refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (!canEdit)
    return (
      <PageContainer>
        <PageHeader
          title="Shared logins"
          description="Only owners and developers can manage shared logins."
        />
      </PageContainer>
    );

  return (
    <PageContainer>
      <PageHeader
        title="Shared logins"
        description="A login used by many devices, for example one Q-SYS admin account for a whole site. Change it here and every room that uses it picks up the new value, with no new release."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus data-icon="inline-start" /> New shared login
          </Button>
        }
      />
      {creating && (
        <SetForm
          onDone={async () => {
            setCreating(false);
            await refresh();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {list.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : list.isError ? (
        <p className="text-sm text-destructive">{list.error.message}</p>
      ) : list.data.length === 0 && !creating ? (
        <EmptyState
          icon={KeyRound}
          title="No shared logins yet"
          description="Add one when several devices use the same username and password."
        />
      ) : (
        <ul className="space-y-3">
          {list.data.map((s) => (
            <li key={s.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">{s.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {s.fields.join(', ')} · used by {s.usedBy} room{s.usedBy === 1 ? '' : 's'}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDeleting({ id: s.id, name: s.name })}
                  aria-label={`Delete ${s.name}`}
                >
                  <Trash2 />
                </Button>
              </div>
              <SetForm existing={s} onDone={refresh} />
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        description="A shared login that rooms still use can’t be deleted. Remove it from them first."
        confirmLabel="Delete"
        destructive
        onConfirm={() => deleting && del.mutate({ orgId, id: deleting.id })}
      />
    </PageContainer>
  );
}

/** Create a set, or (with `existing`) replace some of its values. An empty value removes a field. */
function SetForm({
  existing,
  onDone,
  onCancel,
}: {
  existing?: { id: string; name: string; fields: string[] };
  onDone: () => void | Promise<unknown>;
  onCancel?: () => void;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [name, setName] = useState(existing?.name ?? '');
  const [rows, setRows] = useState<Row[]>(
    existing
      ? existing.fields.map((key) => ({ key, value: '' }))
      : [
          { key: 'username', value: '' },
          { key: 'password', value: '' },
        ],
  );
  const [touched, setTouched] = useState<Set<number>>(new Set());
  const set = (i: number, patch: Partial<Row>) => {
    setRows((r) => r.map((x, n) => (n === i ? { ...x, ...patch } : x)));
    setTouched((t) => new Set(t).add(i));
  };
  const isExisting = (key: string) => !!existing?.fields.includes(key);
  // When editing, only what was touched or added is sent: the rest keeps its stored value.
  const fields = () =>
    Object.fromEntries(
      rows
        .map((r, i) => [r, i] as const)
        .filter(([r, i]) => r.key.trim() && (!existing || touched.has(i) || !isExisting(r.key)))
        .map(([r]) => [r.key.trim(), r.value]),
    );
  const nothingToSave = existing
    ? touched.size === 0 && rows.every((r) => isExisting(r.key))
    : !name.trim();

  const create = useMutation(
    trpc.binding.credentialSets.create.mutationOptions({
      onSuccess: async () => {
        toast.success('Shared login saved');
        await onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const update = useMutation(
    trpc.binding.credentialSets.update.mutationOptions({
      onSuccess: async (r) => {
        toast.success(
          r.roomsUpdated
            ? `Saved. ${r.roomsUpdated} room${r.roomsUpdated === 1 ? '' : 's'} will pick it up.`
            : 'Saved',
        );
        setTouched(new Set());
        setRows((x) => x.map((row) => ({ ...row, value: '' })));
        await onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const busy = create.isPending || update.isPending;

  return (
    <div
      className={
        existing
          ? 'mt-3 space-y-2 border-t border-border pt-3'
          : 'mb-4 space-y-2 rounded-lg border border-border bg-card p-4'
      }
    >
      {!existing && (
        <Input
          placeholder="Name, for example Site A Q-SYS admin"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      )}
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <Input
            className="max-w-40"
            list="credential-fields"
            placeholder="Field"
            value={r.key}
            disabled={isExisting(r.key)}
            onChange={(e) => set(i, { key: e.target.value })}
          />
          <Input
            type="password"
            autoComplete="off"
            placeholder={
              isExisting(r.key) ? 'Set. Type to replace, or leave blank to keep' : 'Value'
            }
            value={r.value}
            onChange={(e) => set(i, { value: e.target.value })}
          />
        </div>
      ))}
      <datalist id="credential-fields">
        {FIELD_HINTS.map((h) => (
          <option key={h} value={h} />
        ))}
      </datalist>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setRows((r) => [...r, { key: '', value: '' }])}
        >
          <Plus data-icon="inline-start" /> Field
        </Button>
        <div className="ml-auto flex gap-2">
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            disabled={busy || nothingToSave}
            onClick={() =>
              existing
                ? update.mutate({ orgId, id: existing.id, fields: fields() })
                : create.mutate({ orgId, name, fields: fields() })
            }
          >
            {existing ? 'Update' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}
