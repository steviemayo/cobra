'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Play, RotateCcw } from 'lucide-react';
import { validateRoomModel } from '@kestrel/engine';
import { DEVICE_CATALOG } from '@kestrel/model';
import { PanelApp, darkTheme, lightTheme } from '@kestrel/panel-ui';
import '@kestrel/panel-ui/panel.css';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { useRoom } from '@/components/pages/room-shell';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button, buttonVariants } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useTRPC } from '@/trpc/client';
import { SimGraph } from './SimGraph';
import { SPEEDS, useSimulation } from './use-simulation';

type Fault = 'ok' | 'offline' | 'reject';
const FAULT_OPTIONS = [
  { value: 'ok' as const, label: 'Working' },
  { value: 'offline' as const, label: 'Offline' },
  { value: 'reject' as const, label: 'Not responding' },
];

const time = (t: number) => new Date(t).toLocaleTimeString('en-AU', { hour12: false });

export function SimulatorView({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const { room } = useRoom(roomId);
  const draft = useQuery({ ...trpc.draft.get.queryOptions({ orgId, roomId }), staleTime: 0 });
  const model = draft.data?.model;

  const [speed, setSpeed] = useState<string>('0.25');
  const [panels, setPanels] = useState<'1' | '2'>('1');
  const [panelTheme, setPanelTheme] = useState<'dark' | 'light'>('dark');
  const [demoTimers, setDemoTimers] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [faults, setFaults] = useState<Record<string, Fault>>({});

  const errors = useMemo(
    () => (model ? validateRoomModel(model).issues.filter((i) => i.severity === 'error') : []),
    [model],
  );
  const runnable = !!model && errors.length === 0;
  const scale = SPEEDS.find((s) => s.value === speed)?.scale ?? 1;

  // Only build a simulation for a valid model; the hook is a no-op until then.
  const { instance, version, log } = useSimulation({
    model: runnable ? model : null,
    roomName: room?.name ?? 'Room',
    speed: scale,
    demoTimers,
    resetKey,
  });

  if (!room || draft.isPending)
    return (
      <PageContainer wide className="pt-5">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-96 w-full" />
      </PageContainer>
    );

  const designHref = orgPath(orgId, `/rooms/${roomId}/design`);
  if (!model)
    return (
      <PageContainer className="pt-5">
        <EmptyState
          icon={Play}
          title="Design the room first"
          description="The simulator runs your room model. Add devices and connections in the designer, then come back."
          action={
            <Link href={designHref} className={buttonVariants()}>
              Open designer
            </Link>
          }
        />
      </PageContainer>
    );
  if (!runnable)
    return (
      <PageContainer className="max-w-3xl pt-5">
        <EmptyState
          icon={Play}
          title="Fix the design before simulating"
          description={
            <>
              {errors.length} problem{errors.length === 1 ? '' : 's'} would stop this room from
              running, for example: {errors[0]!.message}
            </>
          }
          action={
            <Link href={designHref} className={buttonVariants()}>
              Open designer
            </Link>
          }
        />
      </PageContainer>
    );

  const panelTheme_ = panelTheme === 'dark' ? darkTheme : lightTheme;
  const faultable = model.devices.filter(
    (d) => DEVICE_CATALOG[d.category].controllable || d.category === 'video_source',
  );

  return (
    <PageContainer wide className="pt-5">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="sim-speed">Device speed</Label>
          <SimpleSelect
            id="sim-speed"
            value={speed}
            onValueChange={setSpeed}
            options={SPEEDS.map((s) => ({ value: s.value, label: s.label }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sim-panels">Panels</Label>
          <SimpleSelect
            id="sim-panels"
            value={panels}
            onValueChange={setPanels}
            options={[
              { value: '1', label: 'One panel' },
              { value: '2', label: 'Two panels (they follow each other)' },
            ]}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sim-theme">Panel theme</Label>
          <SimpleSelect
            id="sim-theme"
            value={panelTheme}
            onValueChange={setPanelTheme}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
          />
        </div>
        <label className="flex items-center gap-2 pb-1.5 text-sm">
          <Switch checked={demoTimers} onCheckedChange={setDemoTimers} />
          Short auto-off timers (20s + 10s)
        </label>
        <Button
          variant="outline"
          size="sm"
          className="mb-0.5 ml-auto"
          onClick={() => {
            setFaults({});
            setResetKey((k) => k + 1);
          }}
        >
          <RotateCcw data-icon="inline-start" /> Reset room
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        This runs the same engine the on-site gateway will, against simulated equipment. Plug a
        laptop cable in on the right and the room starts itself.
      </p>

      {instance && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div
            className={cn(
              'grid gap-4',
              panels === '2' && 'md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2',
            )}
          >
            {(panels === '2' ? ['Panel A', 'Panel B'] : ['Panel']).map((label) => (
              <div key={label} className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">{label}</div>
                <div className="h-[560px] overflow-auto rounded-2xl border-[5px] border-foreground/85 bg-black">
                  <PanelApp client={instance.runtime} theme={panelTheme_} />
                </div>
              </div>
            ))}
          </div>

          <div className="min-w-0 space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              Signal flow and device state
            </div>
            <SimGraph model={model} sim={instance.sim} version={version} />
          </div>
        </div>
      )}

      {instance && (
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="space-y-3">
            <h2 className="text-sm font-medium">Inject faults</h2>
            <div className="divide-y rounded-lg border">
              {faultable.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{d.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {DEVICE_CATALOG[d.category].label}
                    </div>
                  </div>
                  <SimpleSelect
                    size="sm"
                    value={faults[d.id] ?? 'ok'}
                    options={FAULT_OPTIONS}
                    onValueChange={(f) => {
                      setFaults((prev) => ({ ...prev, [d.id]: f }));
                      instance.sim.setFault(
                        d.id,
                        f === 'ok'
                          ? null
                          : f === 'offline'
                            ? { offline: true }
                            : { rejectCommands: true },
                      );
                    }}
                  />
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium">What just happened</h2>
            <div className="h-72 overflow-y-auto rounded-lg border">
              {log.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  Nothing yet. Tap something on the panel, or plug in a cable.
                </p>
              ) : (
                <ol className="divide-y">
                  {log.map((e) => (
                    <li key={e.id} className="flex gap-3 px-3 py-1.5 text-sm">
                      <span className="tabular shrink-0 text-xs text-muted-foreground">
                        {time(e.at)}
                      </span>
                      <span className={cn(e.kind === 'panel' && 'text-brand')}>{e.text}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>
        </div>
      )}
    </PageContainer>
  );
}
