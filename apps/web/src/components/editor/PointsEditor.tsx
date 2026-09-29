'use client';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  BUILT_IN_DRIVERS,
  POINT_ROLES,
  POINT_ROLE_INFO,
  POINT_TYPE_LABEL,
  type ControlPoint,
  type Device,
  type DiscoveredComponent,
  type DiscoveredControl,
  type PointForms,
  type PointType,
  type RoomModel,
} from '@kestrel/model';
import { useBilling } from '@/components/common/plan-gate';
import { useOrg } from '@/components/shell/org-context';
import { uniqueId } from '@/lib/editor/ops';
import { useTRPC } from '@/trpc/client';
import { Label, Select, TextInput, dangerBtnCls, ghostBtnCls, inputCls } from './ui';

// The control points of a DSP or similar device: the things inside it that Kestrel controls. Each is
// written in the address form of the device driver; a role connects it to the room.
export function PointsEditor({
  model,
  device,
  edit,
  roomId,
}: {
  model: RoomModel;
  device: Device;
  edit: (fn: (d: Device) => void) => void;
  roomId?: string;
}) {
  const forms = device.control?.kind === 'driver' ? BUILT_IN_DRIVERS[device.control.driverId]?.points : undefined;
  const types = (Object.keys(forms ?? {}) as PointType[]).filter((t) => forms?.[t]);
  const points = device.points ?? [];
  const [type, setType] = useState<PointType>(types[0] ?? 'level');

  if (!forms)
    return (
      <p className="text-xs text-muted-foreground">
        Control points are available for drivers that support them (Q-SYS, Biamp Tesira). Choose one above.
      </p>
    );

  const change = (id: string, fn: (p: ControlPoint) => void) =>
    edit((d) => {
      const p = d.points?.find((x) => x.id === id);
      if (p) fn(p);
    });
  const add = () =>
    edit((d) => {
      const name = `${POINT_TYPE_LABEL[type]} ${(d.points?.length ?? 0) + 1}`;
      d.points = [
        ...(d.points ?? []),
        { id: uniqueId(name, (d.points ?? []).map((p) => p.id)), name, type, address: {} },
      ];
    });

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">Control points</div>
      {points.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No points yet. Add the levels, mutes and so on to watch or control, then give each a role to connect it to the room.
        </p>
      )}
      {points.map((p) => (
        <PointRow key={p.id} model={model} device={device} point={p} forms={forms} change={change} edit={edit} roomId={roomId} />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={type} options={types.map((t) => ({ value: t, label: POINT_TYPE_LABEL[t] }))} onChange={setType} />
        <button type="button" className={ghostBtnCls} onClick={add}>
          Add point
        </button>
      </div>
    </div>
  );
}

function PointRow({
  model,
  device,
  point: p,
  forms,
  change,
  edit,
  roomId,
}: {
  model: RoomModel;
  device: Device;
  point: ControlPoint;
  forms: PointForms;
  change: (id: string, fn: (p: ControlPoint) => void) => void;
  edit: (fn: (d: Device) => void) => void;
  roomId?: string;
}) {
  // A role connects a point to activities and the panel, which a room without control does not have.
  const control = useBilling().data?.entitlements.control ?? true;
  const fields = forms[p.type] ?? [];
  const roles = POINT_ROLES.filter((r) => POINT_ROLE_INFO[r].type === p.type);
  const info = p.role ? POINT_ROLE_INFO[p.role] : null;
  const mics = model.devices.filter((d) => d.category === (p.role === 'mic_privacy_mute' ? 'voice_capture_mic' : 'reinforcement_mic'));

  return (
    <div className="space-y-2 rounded border border-border p-2">
      <div className="flex flex-wrap items-end gap-2">
        <Label text="Name">
          <TextInput value={p.name} onChange={(v) => change(p.id, (x) => (x.name = v))} />
        </Label>
        <Label text="Kind">
          <Select
            value={p.type}
            options={(Object.keys(forms) as PointType[]).map((t) => ({ value: t, label: POINT_TYPE_LABEL[t] }))}
            onChange={(v) =>
              change(p.id, (x) => {
                x.type = v;
                x.address = {};
                if (x.role && POINT_ROLE_INFO[x.role].type !== v) {
                  delete x.role;
                  delete x.targetId;
                }
              })
            }
          />
        </Label>
        {fields.map((f) => (
          <Label key={f.key} text={f.label}>
            <TextInput
              value={String(p.address[f.key] ?? '')}
              onChange={(v) =>
                change(p.id, (x) => {
                  if (v === '') delete x.address[f.key];
                  else x.address[f.key] = /^(index|input|output)$/.test(f.key) && /^\d+$/.test(v) ? Number(v) : v;
                })
              }
            />
          </Label>
        ))}
        <button
          type="button"
          className={`${dangerBtnCls} ml-auto`}
          onClick={() => edit((d) => void (d.points = (d.points ?? []).filter((x) => x.id !== p.id)))}
        >
          Remove
        </button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {control && (
        <Label text="Role in the room">
          <Select
            value={p.role ?? 'none'}
            options={[{ value: 'none', label: 'None' }, ...roles.map((r) => ({ value: r, label: POINT_ROLE_INFO[r].label }))]}
            onChange={(v) =>
              change(p.id, (x) => {
                if (v === 'none') {
                  delete x.role;
                  delete x.targetId;
                } else {
                  x.role = v;
                  if (!POINT_ROLE_INFO[v].needsMic) delete x.targetId;
                }
              })
            }
          />
        </Label>
        )}
        {control && info?.needsMic && (
          <Label text="Microphone">
            <Select
              value={p.targetId ?? ''}
              options={[{ value: '', label: 'Choose…' }, ...mics.map((m) => ({ value: m.id, label: m.name }))]}
              onChange={(v) => change(p.id, (x) => (v ? (x.targetId = v) : delete x.targetId))}
            />
          </Label>
        )}
        {p.type === 'level' && (
          <>
            <Label text="Lowest">
              <input
                className={`${inputCls} w-24`}
                type="number"
                value={p.min ?? ''}
                placeholder="-40"
                onChange={(e) => change(p.id, (x) => (e.target.value === '' ? delete x.min : (x.min = Number(e.target.value))))}
              />
            </Label>
            <Label text="Highest">
              <input
                className={`${inputCls} w-24`}
                type="number"
                value={p.max ?? ''}
                placeholder="0"
                onChange={(e) => change(p.id, (x) => (e.target.value === '' ? delete x.max : (x.max = Number(e.target.value))))}
              />
            </Label>
          </>
        )}
        <Verify device={device} point={p} roomId={roomId} onRange={(min, max) => change(p.id, (x) => {
          if (x.min === undefined && min !== undefined) x.min = min;
          if (x.max === undefined && max !== undefined) x.max = max;
        })} />
      </div>
      {device.control?.kind === 'driver' && device.control.driverId === 'qsys-core' && (
        <Browse
          device={device}
          roomId={roomId}
          onPick={(component, control) =>
            change(p.id, (x) => {
              x.address = { ...x.address, component, control };
            })
          }
        />
      )}
      <WatchRow point={p} change={change} />
    </div>
  );
}

type WatchMode = 'none' | 'expect' | 'range';
const SEVERITY_OPTIONS = [
  { value: 'info' as const, label: 'Note' },
  { value: 'warning' as const, label: 'Warning' },
  { value: 'critical' as const, label: 'Critical' },
];

/**
 * Watch a point: raise an incident (and alert) when its value is not what it should be. Works in a
 * room without control too, which is how a monitored room uses a point.
 */
function WatchRow({ point: p, change }: { point: ControlPoint; change: (id: string, fn: (p: ControlPoint) => void) => void }) {
  const w = p.watch;
  const numeric = p.type === 'level' || p.type === 'meter';
  const mode: WatchMode = !w ? 'none' : w.expect !== undefined ? 'expect' : w.min !== undefined || w.max !== undefined ? 'range' : 'none';
  const modes: { value: WatchMode; label: string }[] = [
    { value: 'none', label: 'Don’t watch' },
    { value: 'expect', label: p.type === 'mute' ? 'Should be on or off' : 'Should be a certain value' },
    ...(numeric ? [{ value: 'range' as const, label: 'Should stay in a range' }] : []),
  ];
  const set = (fn: (x: NonNullable<ControlPoint['watch']>) => void) =>
    change(p.id, (x) => {
      const next = x.watch ?? { severity: 'warning' as const };
      fn(next);
      x.watch = next;
    });
  const number = (v: string) => (v === '' ? undefined : Number(v));

  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-border pt-2">
      <Label text="Watch this point">
        <Select
          value={mode}
          options={modes}
          onChange={(m) =>
            change(p.id, (x) => {
              if (m === 'none') delete x.watch;
              else if (m === 'expect') x.watch = { severity: x.watch?.severity ?? 'warning', expect: p.type === 'mute' ? false : numeric ? 50 : '' };
              else x.watch = { severity: x.watch?.severity ?? 'warning', min: 20 };
            })
          }
        />
      </Label>
      {mode === 'expect' && p.type === 'mute' && (
        <Label text="Should be">
          <Select
            value={w?.expect === true ? 'on' : 'off'}
            options={[{ value: 'off', label: 'Off (unmuted)' }, { value: 'on', label: 'On (muted)' }]}
            onChange={(v) => set((x) => void (x.expect = v === 'on'))}
          />
        </Label>
      )}
      {mode === 'expect' && p.type !== 'mute' && (
        <Label text={numeric ? 'Should be (0 to 100)' : 'Should say'}>
          <input
            className={`${inputCls} w-32`}
            type={numeric ? 'number' : 'text'}
            value={w?.expect === undefined ? '' : String(w.expect)}
            onChange={(e) => set((x) => void (x.expect = numeric ? (number(e.target.value) ?? 0) : e.target.value))}
          />
        </Label>
      )}
      {mode === 'range' && (
        <>
          <Label text="Lowest allowed (0 to 100)">
            <input className={`${inputCls} w-28`} type="number" value={w?.min ?? ''} onChange={(e) => set((x) => void (x.min = number(e.target.value)))} />
          </Label>
          <Label text="Highest allowed">
            <input className={`${inputCls} w-28`} type="number" value={w?.max ?? ''} onChange={(e) => set((x) => void (x.max = number(e.target.value)))} />
          </Label>
        </>
      )}
      {mode !== 'none' && (
        <Label text="Alert as">
          <Select value={w?.severity ?? 'warning'} options={SEVERITY_OPTIONS} onChange={(v) => set((x) => void (x.severity = v))} />
        </Label>
      )}
    </div>
  );
}

/** Ask the room's gateway to read the point, which confirms it exists and fills in a level's range. */
function Verify({
  device,
  point,
  roomId,
  onRange,
}: {
  device: Device;
  point: ControlPoint;
  roomId?: string;
  onRange: (min?: number, max?: number) => void;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [commandId, setCommandId] = useState<string | null>(null);
  const start = useMutation(trpc.binding.verifyPoint.mutationOptions({ onSuccess: (r) => setCommandId(r.commandId) }));
  const result = useQuery({
    ...trpc.binding.testResult.queryOptions({ orgId, roomId: roomId ?? '', commandId: commandId ?? '00000000-0000-4000-8000-000000000000' }),
    enabled: !!commandId && !!roomId,
    refetchInterval: (q) => (q.state.data && ['succeeded', 'failed'].includes(q.state.data.status) ? false : 2000),
  });
  const status = result.data?.status;
  const done = status === 'succeeded' || status === 'failed';
  const [applied, setApplied] = useState<string | null>(null);
  if (status === 'succeeded' && commandId && applied !== commandId) {
    setApplied(commandId);
    const out = result.data?.output as { min?: number; max?: number } | null;
    onRange(out?.min, out?.max);
  }
  const value = (result.data?.output as { value?: unknown } | null)?.value;

  return (
    <div className="flex items-center gap-2 pb-1">
      <button
        type="button"
        className={ghostBtnCls}
        disabled={!roomId || start.isPending || (!!commandId && !done)}
        title="Ask the room's gateway to read this point. The room must be running with this device."
        onClick={() => {
          setCommandId(null);
          if (roomId) start.mutate({ orgId, roomId, deviceId: device.id, type: point.type, address: point.address });
        }}
      >
        {commandId && !done ? 'Checking…' : 'Verify'}
      </button>
      {status === 'succeeded' && (
        <span className="text-xs text-emerald-700 dark:text-emerald-300">Found{value !== undefined ? `: ${String(value)}` : ''}</span>
      )}
      {status === 'failed' && <span className="text-xs text-destructive">{result.data?.error ?? 'Not found'}</span>}
      {start.error && <span className="text-xs text-destructive">{start.error.message}</span>}
    </div>
  );
}

const PENDING_COMMAND_ID = '00000000-0000-4000-8000-000000000000';

/**
 * Lets someone pick a Q-SYS component and one of its controls from what the Core actually reports,
 * instead of typing the names blind (docs/driver-classes.md, "Where a vendor lets the device list
 * its components, the form offers a pick-list").
 */
function Browse({
  device,
  roomId,
  onPick,
}: {
  device: Device;
  roomId?: string;
  onPick: (component: string, control: string) => void;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [componentsId, setComponentsId] = useState<string | null>(null);
  const [controlsId, setControlsId] = useState<string | null>(null);
  const [component, setComponent] = useState('');

  const startComponents = useMutation(
    trpc.binding.discoverComponents.mutationOptions({ onSuccess: (r) => setComponentsId(r.commandId) }),
  );
  const componentsResult = useQuery({
    ...trpc.binding.testResult.queryOptions({ orgId, roomId: roomId ?? '', commandId: componentsId ?? PENDING_COMMAND_ID }),
    enabled: !!componentsId && !!roomId,
    refetchInterval: (q) => (q.state.data && ['succeeded', 'failed'].includes(q.state.data.status) ? false : 2000),
  });
  const components = (componentsResult.data?.output as { components?: DiscoveredComponent[] } | null)?.components ?? [];
  const componentsDone = componentsResult.data?.status === 'succeeded' || componentsResult.data?.status === 'failed';

  const startControls = useMutation(
    trpc.binding.discoverControls.mutationOptions({ onSuccess: (r) => setControlsId(r.commandId) }),
  );
  const controlsResult = useQuery({
    ...trpc.binding.testResult.queryOptions({ orgId, roomId: roomId ?? '', commandId: controlsId ?? PENDING_COMMAND_ID }),
    enabled: !!controlsId && !!roomId,
    refetchInterval: (q) => (q.state.data && ['succeeded', 'failed'].includes(q.state.data.status) ? false : 2000),
  });
  const controls = (controlsResult.data?.output as { controls?: DiscoveredControl[] } | null)?.controls ?? [];
  const controlsDone = controlsResult.data?.status === 'succeeded' || controlsResult.data?.status === 'failed';

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
      <button
        type="button"
        className={ghostBtnCls}
        disabled={!roomId || startComponents.isPending || (!!componentsId && !componentsDone)}
        title="Ask the room's gateway to list this device's named components. The room must be running with this device."
        onClick={() => {
          setComponentsId(null);
          setControlsId(null);
          setComponent('');
          if (roomId) startComponents.mutate({ orgId, roomId, deviceId: device.id });
        }}
      >
        {componentsId && !componentsDone ? 'Listing…' : 'Browse components'}
      </button>
      {components.length > 0 && (
        <Select
          value={component}
          options={[
            { value: '', label: 'Choose a component…' },
            ...components.map((c) => ({ value: c.name, label: c.type ? `${c.name} (${c.type})` : c.name })),
          ]}
          onChange={(v) => {
            setComponent(v);
            setControlsId(null);
            if (v && roomId) startControls.mutate({ orgId, roomId, deviceId: device.id, component: v });
          }}
        />
      )}
      {controlsId && !controlsDone && <span className="text-xs text-muted-foreground">Listing controls…</span>}
      {controls.length > 0 && (
        <Select
          value=""
          options={[{ value: '', label: 'Choose a control…' }, ...controls.map((c) => ({ value: c.name, label: c.name }))]}
          onChange={(v) => v && onPick(component, v)}
        />
      )}
      {componentsResult.data?.status === 'failed' && (
        <span className="text-xs text-destructive">{componentsResult.data?.error ?? 'Could not list components'}</span>
      )}
      {controlsResult.data?.status === 'failed' && (
        <span className="text-xs text-destructive">{controlsResult.data?.error ?? 'Could not list controls'}</span>
      )}
    </div>
  );
}
