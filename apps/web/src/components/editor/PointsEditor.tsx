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
  type PointForms,
  type PointType,
  type RoomModel,
} from '@kestrel/model';
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
          No points yet. Add the levels, mutes and so on to control, then give each a role to connect it to the room.
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
        {info?.needsMic && (
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
