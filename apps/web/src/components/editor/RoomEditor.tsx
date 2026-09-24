'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RoomModel } from '@kestrel/model';
import { useTRPC } from '@/trpc/client';
import { ActivitiesPanel } from './ActivitiesPanel';
import { ConnectionsPanel } from './ConnectionsPanel';
import { DevicesPanel } from './DevicesPanel';
import { GraphPanel } from './GraphPanel';
import { GroupsPanel } from './GroupsPanel';
import { SettingsPanel } from './SettingsPanel';
import { StatesPanel } from './StatesPanel';
import { TemplatePicker } from './TemplatePicker';
import { Toolbar, SaveStatusBadge } from './Toolbar';
import { TriggersPanel } from './TriggersPanel';
import { ValidationPanel, tabForRef, type TabId } from './ValidationPanel';
import { useRoomEditor } from './use-room-editor';

const TABS: { id: TabId; label: string }[] = [
  { id: 'graph', label: 'Graph' },
  { id: 'devices', label: 'Devices' },
  { id: 'connections', label: 'Connections' },
  { id: 'groups', label: 'Groups' },
  { id: 'states', label: 'States' },
  { id: 'activities', label: 'Activities' },
  { id: 'triggers', label: 'Triggers' },
  { id: 'settings', label: 'Settings' },
];

export function RoomEditorLoader({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const orgs = useQuery(trpc.org.mine.queryOptions());
  const orgId = orgs.data?.[0]?.id ?? '';
  const rooms = useQuery({ ...trpc.room.list.queryOptions({ orgId }), enabled: !!orgId });
  // Always load the draft fresh: the editor owns it once mounted and saves against this revision.
  const draft = useQuery({
    ...trpc.draft.get.queryOptions({ orgId, roomId }),
    enabled: !!orgId,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const room = rooms.data?.find((r) => r.id === roomId);

  const header = (
    <header className="flex items-center gap-3">
      <Link href="/dashboard" className="text-sm text-slate-400 underline">
        ← Dashboard
      </Link>
      <h1 className="text-xl font-semibold">{room?.name ?? 'Room'}</h1>
      {room && <span className="text-sm text-slate-400">({room.type})</span>}
    </header>
  );

  if (orgs.isPending || (orgId && (rooms.isPending || draft.isPending)))
    return (
      <Shell>
        {header}
        <p className="text-slate-400">Loading…</p>
      </Shell>
    );
  if (!orgId)
    return (
      <Shell>
        {header}
        <p className="text-slate-400">No organisation found.</p>
      </Shell>
    );
  if (rooms.isSuccess && !room)
    return (
      <Shell>
        {header}
        <p className="text-red-300">Room not found.</p>
      </Shell>
    );
  if (draft.isError)
    return (
      <Shell>
        {header}
        <p className="text-red-300">{draft.error.message}</p>
      </Shell>
    );
  if (!room)
    return (
      <Shell>
        {header}
        <p className="text-slate-400">Loading…</p>
      </Shell>
    );

  if (!draft.data)
    return (
      <Shell>
        {header}
        <TemplatePicker
          orgId={orgId}
          roomId={roomId}
          roomType={room.type}
          onCreated={() => void qc.invalidateQueries({ queryKey: trpc.draft.get.queryKey() })}
        />
      </Shell>
    );

  return (
    <Shell wide>
      {header}
      <RoomEditor
        orgId={orgId}
        roomId={roomId}
        initialModel={draft.data.model}
        initialRevision={draft.data.revision}
      />
    </Shell>
  );
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className={`mx-auto space-y-5 p-6 ${wide ? 'max-w-7xl' : 'max-w-3xl'}`}>{children}</main>
  );
}

function RoomEditor(props: {
  orgId: string;
  roomId: string;
  initialModel: RoomModel;
  initialRevision: number;
}) {
  const { model, update, status, flush, replace, validation } = useRoomEditor(props);
  const [tab, setTab] = useState<TabId>('graph');

  const count = (id: TabId, severity: 'error' | 'warning') =>
    validation.issues.filter((i) => i.severity === severity && tabForRef(i.ref) === id).length;
  const panel = { model, update, issues: validation.issues };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Toolbar
          orgId={props.orgId}
          roomId={props.roomId}
          status={status}
          flush={flush}
          onRestore={replace}
        />
        <SaveStatusBadge status={status} onRetry={() => void flush()} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-4">
          <nav className="flex flex-wrap gap-1 border-b border-slate-800">
            {TABS.map((t) => {
              const errors = count(t.id, 'error');
              const warnings = count(t.id, 'warning');
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
                    tab === t.id
                      ? 'border-sky-500 text-slate-100'
                      : 'border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t.label}
                  {errors > 0 && (
                    <span className="rounded-full bg-red-900 px-1.5 text-xs text-red-200">
                      {errors}
                    </span>
                  )}
                  {errors === 0 && warnings > 0 && (
                    <span className="rounded-full bg-amber-900 px-1.5 text-xs text-amber-200">
                      {warnings}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
          {tab === 'graph' && <GraphPanel {...panel} />}
          {tab === 'devices' && <DevicesPanel {...panel} />}
          {tab === 'connections' && <ConnectionsPanel {...panel} />}
          {tab === 'groups' && <GroupsPanel {...panel} />}
          {tab === 'states' && <StatesPanel {...panel} />}
          {tab === 'activities' && <ActivitiesPanel {...panel} />}
          {tab === 'triggers' && <TriggersPanel {...panel} />}
          {tab === 'settings' && <SettingsPanel {...panel} />}
        </div>
        <ValidationPanel result={validation} onSelect={setTab} />
      </div>
    </div>
  );
}
