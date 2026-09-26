'use client';
import { useState } from 'react';
import {
  BUILT_IN_DRIVERS,
  DEVICE_CATALOG,
  addAvoipSystem,
  avoipFamilies,
  DeviceCategory,
  LEGACY_CATEGORIES,
  GenericProtocol,
  PortDirection,
  SignalKind,
  MicStart,
  MicStop,
  type Device,
} from '@kestrel/model';
import { useQuery } from '@tanstack/react-query';
import { useOrg } from '@/components/shell/org-context';
import { PointsEditor } from './PointsEditor';
import { addDevice, addPort, removeDevice, removePort } from '@/lib/editor/ops';
import { useTRPC } from '@/trpc/client';
import {
  Card,
  ConfirmButton,
  Label,
  Select,
  TextInput,
  btnCls,
  dangerBtnCls,
  ghostBtnCls,
  inputCls,
  issuesForDevice,
  type PanelProps,
} from './ui';

const BUILT_IN_HINTS = Object.keys(BUILT_IN_DRIVERS);
const categoryOptions = DeviceCategory.options
  .filter((c) => !LEGACY_CATEGORIES.includes(c))
  .map((c) => ({
    value: c,
    label: DEVICE_CATALOG[c].label,
  }));
const signalOptions = SignalKind.options.map((s) => ({ value: s, label: s.toUpperCase() }));
const directionOptions = PortDirection.options.map((d) => ({
  value: d,
  label: d === 'in' ? 'Input' : 'Output',
}));

type ControlChoice = 'none' | 'driver' | GenericProtocol;
const controlOptions: { value: ControlChoice; label: string }[] = [
  { value: 'none', label: 'No control' },
  { value: 'driver', label: 'Driver' },
  { value: 'pjlink', label: 'Generic: PJLink' },
  { value: 'tcp', label: 'Generic: TCP' },
  { value: 'serial', label: 'Generic: Serial' },
  { value: 'rest', label: 'Generic: REST' },
];

function controlChoice(d: Device): ControlChoice {
  if (!d.control) return 'none';
  return d.control.kind === 'driver' ? 'driver' : d.control.protocol;
}

export function DevicesPanel({ model, update, issues, roomId }: PanelProps & { roomId?: string }) {
  const [category, setCategory] = useState<DeviceCategory>('video_source');
  return (
    <div className="space-y-4">
      <SharedPicker model={model} update={update} roomId={roomId} />
      <AvoipAdder update={update} />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={category} options={categoryOptions} onChange={setCategory} />
        <button className={btnCls} onClick={() => update((m) => void addDevice(m, category))}>
          Add device
        </button>
      </div>
      {model.devices.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No devices yet. Add sources, a matrix, displays and so on.
        </p>
      )}
      {model.devices.map((d) => (
        <DeviceCard key={d.id} model={model} roomId={roomId} device={d} update={update} issues={issuesForDevice(issues, d.id)} />
      ))}
    </div>
  );
}

/** Add an AVoIP system: a switcher and its encoders and decoders, created and wired together. */
function AvoipAdder({ update }: { update: PanelProps['update'] }) {
  const families = avoipFamilies();
  const [family, setFamily] = useState(families[0]?.id ?? '');
  const [encoders, setEncoders] = useState('2');
  const [decoders, setDecoders] = useState('2');
  const [problem, setProblem] = useState('');
  if (families.length === 0) return null;
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card p-2">
      <span className="basis-full text-xs text-muted-foreground">
        Add an AVoIP system: a virtual switcher with its encoders and decoders, wired together. Then connect your sources to the encoders and the decoders to your displays.
      </span>
      <Select value={family} options={families.map((f) => ({ value: f.id, label: f.label }))} onChange={setFamily} />
      <Label text="Encoders">
        <input className={`${inputCls} w-20`} type="number" min={1} value={encoders} onChange={(e) => setEncoders(e.target.value)} />
      </Label>
      <Label text="Decoders">
        <input className={`${inputCls} w-20`} type="number" min={1} value={decoders} onChange={(e) => setDecoders(e.target.value)} />
      </Label>
      <button
        type="button"
        className={ghostBtnCls}
        onClick={() => {
          const out: { result?: ReturnType<typeof addAvoipSystem> } = {};
          update((m) => {
            out.result = addAvoipSystem(m, { family, encoders: Number(encoders), decoders: Number(decoders) });
          });
          setProblem(out.result && !out.result.ok ? (out.result.message ?? '') : '');
        }}
      >
        Add AVoIP system
      </button>
      {problem && <span className="text-xs text-destructive">{problem}</span>}
    </div>
  );
}

/** Add this room's slice of a shared device from the room's site. */
function SharedPicker({ model, update, roomId }: { model: PanelProps['model']; update: PanelProps['update']; roomId?: string }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const room = useQuery({ ...trpc.room.get.queryOptions({ orgId, roomId: roomId ?? '' }), enabled: !!roomId });
  const siteId = room.data?.siteId;
  const shared = useQuery({ ...trpc.siteDevice.list.queryOptions({ orgId, ...(siteId ? { siteId } : {}) }), enabled: !!siteId });
  const [pick, setPick] = useState('');
  const used = new Set(model.devices.flatMap((d) => (d.siteDeviceId ? [d.siteDeviceId] : [])));
  const options = (shared.data ?? []).filter((s) => !used.has(s.id));
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2">
      <span className="text-xs text-muted-foreground">Use a shared device from this site</span>
      <Select
        value={pick || options[0]!.id}
        options={options.map((s) => ({ value: s.id, label: s.name }))}
        onChange={setPick}
      />
      <button
        type="button"
        className={btnCls}
        onClick={() => {
          const s = options.find((o) => o.id === (pick || options[0]!.id));
          if (!s) return;
          update((m) => {
            const device = addDevice(m, s.category as DeviceCategory, s.name);
            device.siteDeviceId = s.id;
            const control = s.control as Device['control'];
            if (control) device.control = control;
          });
          setPick('');
        }}
      >
        Add
      </button>
    </div>
  );
}

function DeviceCard({
  model,
  roomId,
  device: d,
  update,
  issues,
}: {
  model: PanelProps['model'];
  roomId?: string;
  device: Device;
  update: PanelProps['update'];
  issues: PanelProps['issues'];
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const custom = useQuery({ ...trpc.driver.options.queryOptions({ orgId }), staleTime: 60_000 });
  const customIds = (custom.data ?? []).map((d) => d.id);
  const edit = (fn: (dev: Device) => void) =>
    update((m) => {
      const dev = m.devices.find((x) => x.id === d.id);
      if (dev) fn(dev);
    });
  const [newPort, setNewPort] = useState<{ direction: PortDirection; signal: SignalKind }>({
    direction: 'in',
    signal: 'av',
  });
  const choice = controlChoice(d);
  const needsControl = DEVICE_CATALOG[d.category].controllable;

  return (
    <Card issues={issues}>
      <div className="flex flex-wrap items-end gap-3">
        <Label text="Name">
          <TextInput value={d.name} onChange={(v) => edit((dev) => (dev.name = v))} />
        </Label>
        <div className="text-xs text-muted-foreground">
          <div>{DEVICE_CATALOG[d.category].label}</div>
          <div className="font-mono">{d.id}</div>
        </div>
        <Label text={needsControl ? 'Control (required)' : 'Control'}>
          <Select
            value={choice}
            options={controlOptions}
            onChange={(v) =>
              edit((dev) => {
                if (v === 'none') delete dev.control;
                else if (v === 'driver')
                  dev.control = { kind: 'driver', driverId: BUILT_IN_HINTS[0]! };
                else dev.control = { kind: 'generic', protocol: v };
              })
            }
          />
        </Label>
        {d.control?.kind === 'driver' && (
          <Label text="Driver id">
            <TextInput
              list="driver-hints"
              value={d.control.driverId}
              onChange={(v) =>
                edit((dev) => {
                  if (dev.control?.kind === 'driver') dev.control.driverId = v;
                })
              }
            />
            <datalist id="driver-hints">
              {[...BUILT_IN_HINTS, ...customIds].map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
          </Label>
        )}
        {d.control?.kind === 'driver' && BUILT_IN_DRIVERS[d.control.driverId] && (
          <div className="basis-full text-xs text-muted-foreground">
            {BUILT_IN_DRIVERS[d.control.driverId]!.description}{' '}
            <button
              type="button"
              className="text-foreground underline-offset-4 hover:underline"
              onClick={() =>
                edit((dev) => {
                  if (dev.control?.kind === 'driver')
                    dev.settings = structuredClone(BUILT_IN_DRIVERS[dev.control.driverId]!.example);
                })
              }
            >
              Use example settings
            </button>
          </div>
        )}
        <div className="ml-auto">
          <ConfirmButton
            label="Delete"
            confirmLabel="Delete device"
            onConfirm={() => update((m) => removeDevice(m, d.id))}
          />
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">Ports</div>
        {d.ports.length === 0 && <p className="text-xs text-muted-foreground">No ports.</p>}
        {d.ports.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-2">
            <TextInput
              value={p.name}
              onChange={(v) =>
                edit((dev) => {
                  const port = dev.ports.find((x) => x.id === p.id);
                  if (port) port.name = v;
                })
              }
            />
            {d.siteDeviceId && (
              <TextInput
                value={p.maps ?? ''}
                placeholder="Port on the shared device"
                title="Which port of the shared device this room port stands for. Left empty, the ids are the same."
                onChange={(v) =>
                  edit((dev) => {
                    const port = dev.ports.find((x) => x.id === p.id);
                    if (!port) return;
                    if (v.trim() === '') delete port.maps;
                    else port.maps = v.trim();
                  })
                }
              />
            )}
            <Select
              value={p.direction}
              options={directionOptions}
              onChange={(v) =>
                edit((dev) => {
                  const port = dev.ports.find((x) => x.id === p.id);
                  if (port) port.direction = v;
                })
              }
            />
            <Select
              value={p.signal}
              options={signalOptions}
              onChange={(v) =>
                edit((dev) => {
                  const port = dev.ports.find((x) => x.id === p.id);
                  if (port) port.signal = v;
                })
              }
            />
            <button
              className={dangerBtnCls}
              onClick={() => update((m) => removePort(m, d.id, p.id))}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Select
            value={newPort.direction}
            options={directionOptions}
            onChange={(direction) => setNewPort((s) => ({ ...s, direction }))}
          />
          <Select
            value={newPort.signal}
            options={signalOptions}
            onChange={(signal) => setNewPort((s) => ({ ...s, signal }))}
          />
          <button
            className={ghostBtnCls}
            onClick={() => update((m) => addPort(m, d.id, { name: '', ...newPort }))}
          >
            Add port
          </button>
        </div>
      </div>

      {d.category === 'reinforcement_mic' && <MicEditor device={d} edit={edit} />}
      {['audio_matrix', 'lighting', 'hvac'].includes(d.category) && d.control?.kind === 'driver' && (
        <PointsEditor model={model} device={d} edit={edit} roomId={roomId} />
      )}

      <SettingsEditor value={d.settings} onChange={(v) => edit((dev) => (dev.settings = v))} />
    </Card>
  );
}

/** How a reinforcement microphone appears on the panel and what it does with the room. */
function MicEditor({ device: d, edit }: { device: Device; edit: (fn: (dev: Device) => void) => void }) {
  const set = (fn: (m: NonNullable<Device['mic']>) => void) =>
    edit((dev) => {
      const m = { ...dev.mic };
      fn(m);
      // Nothing set means nothing stored, so the device stays as it was.
      const cleaned = Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && v !== ''));
      if (Object.keys(cleaned).length) dev.mic = cleaned;
      else delete dev.mic;
    });
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">Microphone</div>
      <div className="flex flex-wrap items-end gap-3">
        <Label text="Label on the panel">
          <TextInput
            value={d.mic?.label ?? ''}
            placeholder={d.name}
            onChange={(v) => set((m) => (m.label = v.trim() === '' ? undefined : v))}
          />
        </Label>
        <Label text="Order">
          <input
            className={`${inputCls} w-20`}
            type="number"
            min={0}
            max={999}
            value={d.mic?.order ?? ''}
            onChange={(e) => set((m) => (m.order = e.target.value === '' ? undefined : Math.round(Number(e.target.value))))}
          />
        </Label>
        <Label text="When the room turns on">
          <Select
            value={d.mic?.onStart ?? 'unmute'}
            options={MicStart.options.map((o) => ({ value: o, label: o[0]!.toUpperCase() + o.slice(1) }))}
            onChange={(v) => set((m) => (m.onStart = v === 'unmute' ? undefined : v))}
          />
        </Label>
        <Label text="When the room turns off">
          <Select
            value={d.mic?.onStop ?? 'mute'}
            options={MicStop.options.map((o) => ({ value: o, label: o[0]!.toUpperCase() + o.slice(1) }))}
            onChange={(v) => set((m) => (m.onStop = v === 'mute' ? undefined : v))}
          />
        </Label>
        <label className="flex items-center gap-2 pb-1.5 text-sm">
          <input
            type="checkbox"
            checked={d.mic?.hidden ?? false}
            onChange={(e) => set((m) => (m.hidden = e.target.checked ? true : undefined))}
          />
          Hide from the panel
        </label>
      </div>
    </div>
  );
}

function SettingsEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(JSON.stringify(value, null, 2));
  }
  const [error, setError] = useState('');
  return (
    <details>
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Driver settings (JSON)
        {Object.keys(value).length ? ` — ${Object.keys(value).length} set` : ''}
      </summary>
      <textarea
        className={`${inputCls} mt-1 h-24 w-full font-mono`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            const parsed: unknown = JSON.parse(text || '{}');
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
              throw new Error('Must be a JSON object');
            setError('');
            onChange(parsed as Record<string, unknown>);
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Invalid JSON');
          }
        }}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </details>
  );
}
