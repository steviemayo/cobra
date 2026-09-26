'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RoomModel } from '@kestrel/model';
import { ValueTabs } from '@/components/common/nav-tabs';
import { PageContainer } from '@/components/common/page-header';
import { useRoom } from '@/components/pages/room-shell';
import { useOrg } from '@/components/shell/org-context';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/trpc/client';
import { ActivitiesPanel } from './ActivitiesPanel';
import { ConnectionsPanel } from './ConnectionsPanel';
import { DevicesPanel } from './DevicesPanel';
import { GraphPanel } from './GraphPanel';
import { GroupsPanel } from './GroupsPanel';
import { SettingsPanel } from './SettingsPanel';
import { SetupPanel } from './SetupPanel';
import { StatesPanel } from './StatesPanel';
import { TemplatePicker } from './TemplatePicker';
import { SaveStatusBadge, Toolbar } from './Toolbar';
import { TriggersPanel } from './TriggersPanel';
import { ValidationPanel, tabForRef, type TabId } from './ValidationPanel';
import { useRoomEditor } from './use-room-editor';

const TABS: { id: TabId; label: string }[] = [
  { id: 'graph', label: 'Graph' },
  { id: 'devices', label: 'Devices' },
  { id: 'setup', label: 'Setup' },
  { id: 'connections', label: 'Connections' },
  { id: 'groups', label: 'Groups' },
  { id: 'states', label: 'States' },
  { id: 'activities', label: 'Activities' },
  { id: 'triggers', label: 'Triggers' },
  { id: 'settings', label: 'Settings' },
];

// The Design tab of a room: template picker for a new room, otherwise the full editor.
export function RoomEditorWorkspace({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canEdit } = useOrg();
  const { room } = useRoom(roomId);
  // Always load the draft fresh: the editor owns it once mounted and saves against this revision.
  const draft = useQuery({
    ...trpc.draft.get.queryOptions({ orgId, roomId }),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  if (!room || draft.isPending)
    return (
      <PageContainer wide className="pt-5">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-96 w-full" />
      </PageContainer>
    );
  if (draft.isError)
    return (
      <PageContainer className="pt-5">
        <p className="text-sm text-destructive">{draft.error.message}</p>
      </PageContainer>
    );

  if (!draft.data)
    return (
      <PageContainer className="max-w-3xl pt-5">
        {canEdit ? (
          <TemplatePicker
            orgId={orgId}
            roomId={roomId}
            roomType={room.type}
            onCreated={() => {
              void qc.invalidateQueries({ queryKey: trpc.draft.get.queryKey() });
              void qc.invalidateQueries({ queryKey: trpc.room.overview.queryKey() });
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">This room hasn’t been designed yet.</p>
        )}
      </PageContainer>
    );

  return (
    <RoomEditor
      orgId={orgId}
      roomId={roomId}
      initialModel={draft.data.model}
      initialRevision={draft.data.revision}
      readOnly={!canEdit}
    />
  );
}

function RoomEditor(props: {
  orgId: string;
  roomId: string;
  initialModel: RoomModel;
  initialRevision: number;
  readOnly: boolean;
}) {
  const { model, update, status, flush, replace, validation } = useRoomEditor(props);
  const qc = useQueryClient();
  const trpc = useTRPC();
  const [tab, setTab] = useState<TabId>('graph');

  const count = (id: TabId, severity: 'error' | 'warning') =>
    validation.issues.filter((i) => i.severity === severity && tabForRef(i.ref) === id).length;
  const panel = { model, update, issues: validation.issues };
  const refreshSummaries = () => {
    void qc.invalidateQueries({ queryKey: trpc.room.overview.queryKey() });
  };

  return (
    <PageContainer wide className="pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Toolbar
          orgId={props.orgId}
          roomId={props.roomId}
          status={status}
          flush={async () => {
            await flush();
            refreshSummaries();
          }}
          onRestore={(m, r) => {
            replace(m, r);
            refreshSummaries();
          }}
        />
        <SaveStatusBadge status={status} onRetry={() => void flush()} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          <ValueTabs
            value={tab}
            onChange={setTab}
            tabs={TABS.map((t) => ({
              ...t,
              errors: count(t.id, 'error'),
              warnings: count(t.id, 'warning'),
            }))}
          />
          <fieldset disabled={props.readOnly} className="min-w-0">
            {tab === 'graph' && <GraphPanel {...panel} />}
            {tab === 'devices' && <DevicesPanel {...panel} roomId={props.roomId} />}
            {tab === 'setup' && <SetupPanel {...panel} roomId={props.roomId} />}
            {tab === 'connections' && <ConnectionsPanel {...panel} />}
            {tab === 'groups' && <GroupsPanel {...panel} />}
            {tab === 'states' && <StatesPanel {...panel} />}
            {tab === 'activities' && <ActivitiesPanel {...panel} />}
            {tab === 'triggers' && <TriggersPanel {...panel} />}
            {tab === 'settings' && <SettingsPanel {...panel} />}
          </fieldset>
        </div>
        <div className="lg:sticky lg:top-16 lg:self-start">
          <ValidationPanel result={validation} onSelect={setTab} />
        </div>
      </div>
    </PageContainer>
  );
}
