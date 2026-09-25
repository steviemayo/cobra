'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Cable, Play, RotateCcw } from 'lucide-react';
import { PanelApp, darkTheme, lightTheme } from '@kestrel/panel-ui';
import '@kestrel/panel-ui/panel.css';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button, buttonVariants } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useTRPC } from '@/trpc/client';
import { useGroupSimulation } from './use-group-simulation';
import { SPEEDS } from './use-simulation';

/**
 * Try a room group in the browser: pick which room the panel stands in, link and separate rooms
 * from its "Link rooms" menu, and watch which room is really running. Each room runs against its
 * own simulated equipment, with the same controller the gateway uses.
 */
export function GroupSimulator({ groupId }: { groupId: string }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const sim = useQuery({
    ...trpc.roomGroup.simulation.queryOptions({ orgId, groupId }),
    staleTime: 0,
  });
  const [speed, setSpeed] = useState<string>('0.25');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [resetKey, setResetKey] = useState(0);
  const [panelRoom, setPanelRoom] = useState<string>('');

  const scale = SPEEDS.find((s) => s.value === speed)?.scale ?? 1;
  const { built, version, panelFor } = useGroupSimulation({
    data: sim.data,
    speed: scale,
    resetKey,
  });

  const back = orgPath(orgId, `/groups/${groupId}`);
  const standing = built
    ? ([...built.rooms.values()].find((r) => r.id === panelRoom && r.kind === 'standard') ??
      [...built.rooms.values()].find((r) => r.kind === 'standard'))
    : undefined;
  const panel = useMemo(
    () => (standing ? panelFor(standing.id) : null),
    [standing?.id, panelFor],
  );

  if (sim.isPending)
    return (
      <PageContainer wide className="pt-5">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-96 w-full" />
      </PageContainer>
    );
  if (sim.isError || !sim.data)
    return (
      <PageContainer className="pt-5">
        <EmptyState
          icon={Play}
          title="Could not load this group"
          description={sim.error?.message}
        />
      </PageContainer>
    );

  const skipped = sim.data.rooms.filter((r) => !r.model);
  const ordinary = sim.data.rooms.filter((r) => r.kind === 'standard');
  if (!built || !standing || !panel)
    return (
      <PageContainer className="max-w-3xl pt-5">
        <EmptyState
          icon={Play}
          title="Nothing to simulate yet"
          description={
            skipped.length
              ? `${skipped[0]!.name}: ${skipped[0]!.problem}`
              : ordinary.length
                ? 'Give the rooms a design first.'
                : 'This group has no rooms.'
          }
          action={
            <Link href={back} className={buttonVariants()}>
              Back to the group
            </Link>
          }
        />
      </PageContainer>
    );

  // What each room is doing, and whether it is the one running its space or is parked.
  const rows = [...built.rooms.values()].map((r) => {
    const runningId =
      r.kind === 'combined'
        ? r.runtime.isSuspended
          ? null
          : r.id
        : built.controller.activeRoomId(r.id);
    return {
      room: r,
      suspended: r.runtime.isSuspended,
      by: runningId && runningId !== r.id ? built.rooms.get(runningId)?.name : null,
      status: r.runtime.getSnapshot().status,
    };
  });
  const runningNow = built.rooms.get(built.controller.activeRoomId(standing.id)) ?? standing;
  const cables = runningNow.model.devices.filter((d) => d.category === 'video_source');
  void version;

  return (
    <PageContainer wide className="pt-5">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Button size="sm" variant="ghost" render={<Link href={back} />}>
          <ArrowLeft data-icon="inline-start" /> {sim.data.name}
        </Button>
        <div className="space-y-1.5">
          <Label htmlFor="gsim-room">Panel in</Label>
          <SimpleSelect
            id="gsim-room"
            value={standing.id}
            onValueChange={setPanelRoom}
            options={ordinary
              .filter((r) => built.rooms.has(r.id))
              .map((r) => ({ value: r.id, label: r.name }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="gsim-speed">Device speed</Label>
          <SimpleSelect
            id="gsim-speed"
            value={speed}
            onValueChange={setSpeed}
            options={SPEEDS.map((s) => ({ value: s.value, label: s.label }))}
          />
        </div>
        <label className="flex items-center gap-2 pb-1.5 text-sm">
          <Switch
            checked={theme === 'light'}
            onCheckedChange={(on) => setTheme(on ? 'light' : 'dark')}
          />
          Light panel
        </label>
        <Button
          variant="outline"
          size="sm"
          className="mb-0.5 ml-auto"
          onClick={() => setResetKey((k) => k + 1)}
        >
          <RotateCcw data-icon="inline-start" /> Reset rooms
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Use <strong>Link rooms</strong> on the panel to combine rooms. The room that is really
        running the space changes, and the panel follows it. Each room has its own simulated
        equipment.
      </p>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Panel in {standing.name}</div>
          <div className="h-[560px] overflow-auto rounded-2xl border-[5px] border-foreground/85 bg-black">
            <PanelApp client={panel} theme={theme === 'dark' ? darkTheme : lightTheme} />
          </div>
        </div>

        <div className="min-w-0 space-y-5">
          <section className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Rooms</div>
            <ul className="divide-y rounded-md border text-sm">
              {rows.map((r) => (
                <li key={r.room.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span>
                    {r.room.name}
                    {r.room.kind === 'combined' && (
                      <span className="ml-2 text-xs text-muted-foreground">combined</span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {r.suspended
                      ? r.by
                        ? `Handed over to ${r.by}`
                        : 'Waiting'
                      : `Running · ${r.status}`}
                  </span>
                </li>
              ))}
            </ul>
            {skipped.length > 0 && (
              <ul className="space-y-1 text-xs text-warning">
                {skipped.map((r) => (
                  <li key={r.id}>
                    {r.name} is not simulated. {r.problem}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              Cables in {runningNow.name}
            </div>
            {cables.length === 0 && (
              <p className="text-sm text-muted-foreground">No laptop inputs.</p>
            )}
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {cables.map((d) => (
                <label key={d.id} className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={runningNow.sim.isPlugged(d.id)}
                    onCheckedChange={(on) => runningNow.sim.plug(d.id, on)}
                  />
                  <Cable className="size-4 text-muted-foreground" /> {d.name}
                </label>
              ))}
            </div>
          </section>
        </div>
      </div>
    </PageContainer>
  );
}
