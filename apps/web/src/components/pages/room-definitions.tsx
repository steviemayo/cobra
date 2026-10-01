'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { USAGE_KIND_LABEL, USAGE_KINDS, describeUsageRule, type UsageKind } from '@kestrel/model';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { Section } from '@/components/common/section';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/trpc/client';
import { UsageDefinitionDialog } from './usage-definition-dialog';

const DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

function WorkingHours() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, isOwner, role } = useOrg();
  const canEdit = isOwner || role === 'dev';
  const hours = useQuery(trpc.roomUsage.workingHours.queryOptions({ orgId }));
  const [draft, setDraft] = useState<{ days: number[]; start: string; end: string } | null>(null);
  const value = draft ?? hours.data;
  const save = useMutation(
    trpc.roomUsage.saveWorkingHours.mutationOptions({
      onSuccess: async () => {
        toast.success('Saved. Utilisation is recalculated.');
        setDraft(null);
        await qc.invalidateQueries({ queryKey: trpc.roomUsage.workingHours.queryKey() });
        await qc.invalidateQueries({ queryKey: trpc.roomUsage.room.queryKey() });
        await qc.invalidateQueries({ queryKey: trpc.roomUsage.estate.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (!value) return <Skeleton className="h-24 w-full" />;
  return (
    <Section title="Working hours">
      <div className="space-y-3 p-4">
        <p className="text-xs text-muted-foreground">
          Utilisation is the share of these hours a room was in use. Times are in each site&apos;s
          own time zone.
        </p>
        <div className="flex flex-wrap gap-3">
          {DAYS.map((d) => (
            <label key={d.value} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                disabled={!canEdit}
                checked={value.days.includes(d.value)}
                onCheckedChange={(c) =>
                  setDraft({
                    ...value,
                    days: c ? [...value.days, d.value] : value.days.filter((x) => x !== d.value),
                  })
                }
              />
              {d.label}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Input
            type="time"
            className="h-8 w-32"
            disabled={!canEdit}
            value={value.start}
            onChange={(e) => setDraft({ ...value, start: e.target.value })}
          />
          <span className="text-muted-foreground">to</span>
          <Input
            type="time"
            className="h-8 w-32"
            disabled={!canEdit}
            value={value.end}
            onChange={(e) => setDraft({ ...value, end: e.target.value })}
          />
          {canEdit && draft && (
            <>
              <Button
                size="sm"
                disabled={save.isPending}
                onClick={() => save.mutate({ orgId, ...draft })}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>
    </Section>
  );
}

function OrgRule({ kind }: { kind: UsageKind }) {
  const trpc = useTRPC();
  const { orgId, canSupport } = useOrg();
  const [editing, setEditing] = useState(false);
  const def = useQuery(trpc.roomUsage.definition.queryOptions({ orgId, roomId: null, kind }));
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{USAGE_KIND_LABEL[kind]}</div>
        <div className="text-xs text-muted-foreground">
          {def.data
            ? describeUsageRule(def.data.rule, (c) =>
                c.deviceId ? 'a device' : `any ${(c.category ?? '').replace(/_/g, ' ')}`,
              )
            : 'Loading…'}
        </div>
        {def.data && (
          <div className="mt-1 text-xs text-muted-foreground">
            {def.data.hasOwn ? 'Set for the organisation.' : "Kestrel's usual rule."}
          </div>
        )}
      </div>
      {canSupport && (
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          Edit
        </Button>
      )}
      {editing && (
        <UsageDefinitionDialog
          roomId={null}
          kind={kind}
          devices={[]}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

/** What counts as a room being in use, and the working hours utilisation is measured against. */
export function RoomDefinitionsView() {
  const { orgId } = useOrg();
  const trpc = useTRPC();
  const rooms = useQuery(trpc.room.overview.queryOptions({ orgId }));
  return (
    <PageContainer>
      <PageHeader
        title="Room definitions"
        description="What counts as a room being in use, for every room that has no rule of its own. Any reading can count: a display that is on, someone detected, a signal present. Changing a rule recalculates past use too."
      />
      <Section title="What counts as in use">
        <div className="divide-y">
          {USAGE_KINDS.map((k) => (
            <OrgRule key={k} kind={k} />
          ))}
        </div>
      </Section>
      <WorkingHours />
      <p className="text-xs text-muted-foreground">
        A single room can have its own rule from that room&apos;s{' '}
        {rooms.data?.[0] ? (
          <Link className="underline" href={orgPath(orgId, `/rooms/${rooms.data[0].id}/usage`)}>
            Usage tab
          </Link>
        ) : (
          'Usage tab'
        )}
        .
      </p>
    </PageContainer>
  );
}
