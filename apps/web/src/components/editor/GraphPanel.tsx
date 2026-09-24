'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { DEVICE_CATALOG, type Device, type RoomModel } from '@kestrel/model';
import { addConnection, removeConnection } from '@/lib/editor/ops';
import { issuesForDevice, type PanelProps } from './ui';

type DeviceNodeData = { device: Device; hasError: boolean; hasWarning: boolean };
type DeviceNode = Node<DeviceNodeData, 'device'>;

const SIGNAL_DOT: Record<string, string> = {
  av: 'bg-sky-400',
  video: 'bg-violet-400',
  audio: 'bg-amber-400',
};

const COLUMN: Record<string, number> = {
  source: 0,
  camera: 0,
  mic: 0,
  conference: 1,
  matrix: 1,
  destination: 2,
  environment: 3,
};

function autoLayout(devices: Device[]): Record<string, { x: number; y: number }> {
  const rows: Record<number, number> = {};
  const out: Record<string, { x: number; y: number }> = {};
  for (const d of devices) {
    const col = COLUMN[DEVICE_CATALOG[d.category].section] ?? 0;
    const row = (rows[col] = (rows[col] ?? -1) + 1);
    out[d.id] = { x: col * 320, y: row * 180 };
  }
  return out;
}

function DeviceNodeView({ data }: NodeProps<DeviceNode>) {
  const { device, hasError, hasWarning } = data;
  const ins = device.ports.filter((p) => p.direction === 'in');
  const outs = device.ports.filter((p) => p.direction === 'out');
  return (
    <div
      className={`min-w-44 rounded-lg border bg-slate-900 text-slate-100 shadow ${
        hasError ? 'border-red-600' : hasWarning ? 'border-amber-600' : 'border-slate-700'
      }`}
    >
      <div className="border-b border-slate-800 px-3 py-1.5">
        <div className="text-sm font-medium">{device.name}</div>
        <div className="text-[10px] text-slate-400">{DEVICE_CATALOG[device.category].label}</div>
      </div>
      <div className="flex justify-between gap-6 py-1.5">
        <div>
          {ins.map((p) => (
            <div key={p.id} className="relative flex items-center gap-1.5 py-0.5 pl-3 pr-1 text-xs">
              <Handle type="target" position={Position.Left} id={p.id} />
              <span className={`h-1.5 w-1.5 rounded-full ${SIGNAL_DOT[p.signal]}`} />
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
              <span className={`h-1.5 w-1.5 rounded-full ${SIGNAL_DOT[p.signal]}`} />
              <Handle type="source" position={Position.Right} id={p.id} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const nodeTypes = { device: DeviceNodeView };

function toNodeData(model: RoomModel, issues: PanelProps['issues'], d: Device): DeviceNodeData {
  const list = issuesForDevice(issues, d.id);
  return {
    device: d,
    hasError: list.some((i) => i.severity === 'error'),
    hasWarning: list.some((i) => i.severity === 'warning'),
  };
}

export function GraphPanel({ model, update, issues }: PanelProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<DeviceNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [message, setMessage] = useState('');

  const layout = useMemo(() => autoLayout(model.devices), [model.devices]);

  useEffect(() => {
    setNodes((prev) =>
      model.devices.map((d) => {
        const existing = prev.find((n) => n.id === d.id);
        return {
          id: d.id,
          type: 'device' as const,
          position: existing?.position ?? layout[d.id] ?? { x: 0, y: 0 },
          deletable: false,
          ...(existing?.measured ? { measured: existing.measured } : {}),
          data: toNodeData(model, issues, d),
        };
      }),
    );
  }, [model, issues, layout, setNodes]);

  useEffect(() => {
    const errored = new Set(
      issues
        .filter((i) => i.severity === 'error' && i.ref.kind === 'connection')
        .map((i) => (i.ref as { id: string }).id),
    );
    setEdges(
      model.connections.map((c) => ({
        id: c.id,
        source: c.from.deviceId,
        sourceHandle: c.from.portId,
        target: c.to.deviceId,
        targetHandle: c.to.portId,
        style: { stroke: errored.has(c.id) ? '#dc2626' : '#38bdf8', strokeWidth: 2 },
      })),
    );
  }, [model.connections, issues, setEdges]);

  const onConnect = (c: Connection) => {
    if (!c.sourceHandle || !c.targetHandle) return;
    let reason = '';
    update((m) => {
      const r = addConnection(
        m,
        { deviceId: c.source, portId: c.sourceHandle! },
        { deviceId: c.target, portId: c.targetHandle! },
      );
      if (!r.ok) reason = r.reason;
    });
    setMessage(reason);
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">
        Drag from an output (right) to an input (left) to connect. Select a line and press Backspace
        to remove it. Layout is for this session only.
      </p>
      {message && <p className="text-sm text-red-300">{message}</p>}
      <div className="h-[620px] overflow-hidden rounded-lg border border-slate-800">
        <ReactFlow
          colorMode="dark"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onEdgesDelete={(deleted) =>
            update((m) => {
              for (const e of deleted) removeConnection(m, e.id);
            })
          }
          connectionMode={ConnectionMode.Strict}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
