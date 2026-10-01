'use client';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Cpu, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import Link from 'next/link';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { STARTER, preview } from '@/lib/driver-example';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';

export function DriversView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const list = useQuery(trpc.driver.list.queryOptions({ orgId }));
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const one = useQuery({
    ...trpc.driver.get.queryOptions({
      orgId,
      driverId: selected && selected !== 'new' ? selected : '00000000-0000-4000-8000-000000000000',
    }),
    enabled: !!selected && selected !== 'new',
  });

  useEffect(() => {
    if (selected === 'new') setText(JSON.stringify(STARTER, null, 2));
    else if (one.data?.spec) setText(JSON.stringify(one.data.spec, null, 2));
    setProblems([]);
  }, [selected, one.data]);

  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(text) as unknown };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : 'Not valid JSON' };
    }
  }, [text]);
  const commands = useMemo(() => (parsed.ok ? preview(parsed.value) : []), [parsed]);

  const check = useMutation(
    trpc.driver.check.mutationOptions({ onSuccess: (r) => setProblems(r.problems) }),
  );
  const save = useMutation(
    trpc.driver.save.mutationOptions({
      onSuccess: async (res) => {
        toast.success(res.created ? 'Driver created' : `Saved as version ${res.version}`);
        await qc.invalidateQueries({ queryKey: trpc.driver.list.queryKey() });
        await qc.invalidateQueries({ queryKey: trpc.driver.options.queryKey() });
        setSelected(res.id);
        await qc.invalidateQueries({ queryKey: trpc.driver.get.queryKey() });
      },
      onError: (e) => setProblems([e.message]),
    }),
  );
  const del = useMutation(
    trpc.driver.delete.mutationOptions({
      onSuccess: async () => {
        setSelected(null);
        await qc.invalidateQueries({ queryKey: trpc.driver.list.queryKey() });
        toast.success('Driver deleted. Rooms already running keep their copy.');
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <PageContainer wide>
      <PageHeader
        title="Custom drivers"
        description="Teach Kestrel to talk to a device it doesn’t know. A driver is a description of the device’s commands, not code, so it can only ever talk to that device."
        actions={
          <>
            <Link
              href={orgPath(orgId, '/drivers/guide')}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <BookOpen data-icon="inline-start" /> How-to guide
            </Link>
            <Button size="sm" onClick={() => setSelected('new')}>
              <Plus data-icon="inline-start" /> New driver
            </Button>
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <div>
          {list.isPending ? (
            <Skeleton className="h-32 w-full" />
          ) : list.data?.length === 0 && selected !== 'new' ? (
            <EmptyState
              icon={Cpu}
              title="No drivers yet"
              description="Start from an example and change it."
            />
          ) : (
            <ul className="space-y-1">
              {list.data?.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(d.id)}
                    className={cn(
                      'flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-muted',
                      selected === d.id && 'bg-muted',
                    )}
                  >
                    <span>{d.name}</span>
                    <span className="text-xs text-muted-foreground">v{d.latestVersion}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {selected && (
          <div className="space-y-3">
            <Textarea
              aria-label="Driver definition"
              className="h-96 font-mono text-xs"
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {!parsed.ok && <p className="text-sm text-destructive">{parsed.error}</p>}
            {problems.length > 0 && (
              <ul className="space-y-1 rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            {commands.length > 0 && (
              <div className="rounded-lg border">
                <div className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium">
                  What it would send (sample values)
                </div>
                <ul className="divide-y font-mono text-xs">
                  {commands.map((c) => (
                    <li key={c.key} className="flex gap-3 px-3 py-1.5">
                      <span className="w-32 shrink-0 text-muted-foreground">{c.key}</span>
                      <span className="break-all">{c.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                disabled={!parsed.ok || check.isPending}
                onClick={() => parsed.ok && check.mutate({ orgId, spec: parsed.value })}
              >
                {check.isPending && <Spinner />}
                Check
              </Button>
              <Button
                disabled={!parsed.ok || save.isPending}
                onClick={() => parsed.ok && save.mutate({ orgId, spec: parsed.value })}
              >
                {save.isPending && <Spinner />}
                Save
              </Button>
              {check.data?.ok && problems.length === 0 && (
                <span className="text-sm text-success">Looks good</span>
              )}
              {selected !== 'new' && one.data && (
                <Button
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => setDeleting({ id: one.data!.id, name: one.data!.name })}
                >
                  <Trash2 data-icon="inline-start" /> Delete
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Every save is a new version. A room’s release keeps the version it was published with,
              so editing a driver never changes a room that is already running.
            </p>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        destructive
        title={`Delete “${deleting?.name}”?`}
        description="Rooms already running keep their copy. You won’t be able to publish rooms that use it."
        confirmLabel="Delete driver"
        onConfirm={() => deleting && del.mutate({ orgId, driverId: deleting.id })}
      />
    </PageContainer>
  );
}
