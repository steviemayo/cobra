'use client';
import { useEffect, useMemo } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTheme } from 'next-themes';
import type { Simulation } from '@kestrel/drivers';
import { DEVICE_CATALOG, type Device, type DeviceState, type RoomModel } from '@kestrel/model';
import { Switch } from '@/components/ui/switch';
import { autoLayout } from '@/lib/editor/layout';
import { cn } from '@/lib/utils';

interface SimNodeData extends Record<string, unknown> {
  device: Device;
  state: DeviceState | undefined;
  pluggable: boolean;
  plugged: boolean;
  faulted: boolean;
  onPlug: (present: boolean) => void;
}
type SimNode = Node<SimNodeData, 'sim'>;

const POWER_TONE: Record<string, string> = {
  on: 'bg-success',
  warming: 'bg-warning',
  cooling: 'bg-warning',
  off: 'bg-muted-foreground/40',
};

function Chip({ children, tone }: { children: React.ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] font-medium',
        tone === 'ok' && 'bg-success/15 text-emerald-700 dark:text-emerald-300',
        tone === 'warn' && 'bg-warning/20 text-amber-800 dark:text-amber-200',
        tone === 'bad' && 'bg-destructive/15 text-destructive',
        !tone && 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

function Summary({ device, state }: { device: Device; state: DeviceState }) {
  const portName = (id: string | null | undefined) =>
    id ? (device.ports.find((p) => p.id === id)?.name ?? id) : '—';
  switch (device.category) {
    case 'video_destination':
      return (
        <div className="flex flex-wrap gap-1">
          <Chip tone={state.power === 'on' ? 'ok' : state.power === 'off' ? undefined : 'warn'}>
            {state.power}
          </Chip>
          {state.selectedInput && <Chip>showing {portName(state.selectedInput)}</Chip>}
        </div>
      );
    case 'video_matrix':
    case 'audio_matrix':
      return (
        <div className="space-y-1">
          <div className="flex flex-wrap gap-1">
            {state.volume !== undefined && <Chip>vol {Math.round(state.volume)}</Chip>}
            {state.muted !== undefined && (
              <Chip tone={state.muted ? 'warn' : 'ok'}>{state.muted ? 'muted' : 'live'}</Chip>
            )}
            {state.preset && <Chip>{state.preset}</Chip>}
          </div>
          {Object.entries(state.routes).map(([out, from]) => (
            <div key={out} className="text-[10px] text-muted-foreground">
              {portName(out)} ← {portName(from)}
            </div>
          ))}
        </div>
      );
    case 'recorder':
      return (
        <Chip tone={state.recording ? 'bad' : undefined}>
          {state.recording ? '● recording' : 'idle'}
        </Chip>
      );
    default:
      return state.preset ? <Chip>preset “{state.preset}”</Chip> : null;
  }
}

function SimNodeView({ data }: NodeProps<SimNode>) {
  const { device, state, pluggable, plugged, faulted, onPlug } = data;
  const ins = device.ports.filter((p) => p.direction === 'in');
  const outs = device.ports.filter((p) => p.direction === 'out');
  const online = state?.online !== false;
  return (
    <div
      className={cn(
        'min-w-48 rounded-lg border bg-card text-foreground shadow-sm transition-colors',
        !online || faulted ? 'border-destructive' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <span
          className={cn(
            'size-2 rounded-full transition-colors',
            !online ? 'bg-destructive' : POWER_TONE[state?.power ?? 'on'],
          )}
        />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{device.name}</div>
          <div className="text-[10px] text-muted-foreground">
            {DEVICE_CATALOG[device.category].label}
          </div>
        </div>
      </div>
      <div className="flex justify-between gap-6 py-1.5">
        <div>
          {ins.map((p) => (
            <div key={p.id} className="relative flex items-center gap-1.5 py-0.5 pl-3 pr-1 text-xs">
              <Handle type="target" position={Position.Left} id={p.id} isConnectable={false} />
              <span
                className={cn(
                  'size-1.5 rounded-full transition-colors',
                  state?.signal[p.id] ? 'bg-success' : 'bg-muted-foreground/30',
                )}
              />
              {p.name}
            </div>
          ))}
        </div>
        <div>
          {outs.map((p) => (
            <div
              key={p.id}
              className="relative flex items-center justify-end gap-1.5 py-0.5 pl-1 pr-3 text-xs"
            >
              {p.name}
              <Handle type="source" position={Position.Right} id={p.id} isConnectable={false} />
            </div>
          ))}
        </div>
      </div>
      {(state || pluggable) && (
        <div className="space-y-1.5 border-t px-3 py-2">
          {state && <Summary device={device} state={state} />}
          {pluggable && (
            <label className="nodrag flex cursor-pointer items-center justify-between gap-3 text-xs">
              Cable plugged in
              <Switch
                checked={plugged}
                onCheckedChange={onPlug}
                aria-label={`${device.name} cable`}
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}

const nodeTypes = { sim: SimNodeView };

export function SimGraph({
  model,
  sim,
  version,
}: {
  model: RoomModel;
  sim: Simulation;
  version: number;
}) {
  const { resolvedTheme } = useTheme();
  const layout = useMemo(() => autoLayout(model.devices, 270), [model.devices]);
  const [nodes, setNodes, onNodesChange] = useNodesState<SimNode>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);

  // Refresh node data on every simulation event, keeping any positions the user dragged to.
  useEffect(() => {
    setNodes((prev) =>
      model.devices.map((d) => {
        const existing = prev.find((n) => n.id === d.id);
        const pluggable = d.category === 'video_source';
        return {
          id: d.id,
          type: 'sim' as const,
          position: existing?.position ?? layout[d.id] ?? { x: 0, y: 0 },
          draggable: true,
          deletable: false,
          ...(existing?.measured ? { measured: existing.measured } : {}),
          data: {
            device: d,
            state: sim.getState(d.id),
            pluggable,
            plugged: pluggable && sim.isPlugged(d.id),
            faulted: !!sim.getFault(d.id),
            onPlug: (present: boolean) => sim.plug(d.id, present),
          },
        };
      }),
    );
    const flowing = sim.flow();
    setEdges(
      model.connections.map((c) => {
        const live = flowing.has(c.id);
        return {
          id: c.id,
          source: c.from.deviceId,
          sourceHandle: c.from.portId,
          target: c.to.deviceId,
          targetHandle: c.to.portId,
          animated: live,
          style: {
            stroke: live ? 'var(--brand)' : 'var(--border)',
            strokeWidth: live ? 3 : 1.5,
            transition: 'stroke 200ms, stroke-width 200ms',
          },
        };
      }),
    );
  }, [model, sim, version, layout, setNodes, setEdges]);

  return (
    <div className="h-[680px] overflow-hidden rounded-lg border">
      <ReactFlow
        colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        nodesConnectable={false}
        edgesFocusable={false}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
