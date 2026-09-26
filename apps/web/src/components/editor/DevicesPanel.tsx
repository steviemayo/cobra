'use client';
import { useState } from 'react';
import {
  BUILT_IN_DRIVERS,
  DEVICE_CATALOG,
  DeviceCategory,
  LEGACY_CATEGORIES,
  GenericProtocol,
  PortDirection,
  SignalKind,
  type Device,
} from '@kestrel/model';
import { useQuery } from '@tanstack/react-query';
import { useOrg } from '@/components/shell/org-context';
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

export function DevicesPanel({ model, update, issues }: PanelProps) {
  const [category, setCategory] = useState<DeviceCategory>('video_source');
  return (
    <div className="space-y-4">
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
        <DeviceCard key={d.id} device={d} update={update} issues={issuesForDevice(issues, d.id)} />
      ))}
    </div>
  );
}

function DeviceCard({
  device: d,
  update,
  issues,
}: {
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

      <SettingsEditor value={d.settings} onChange={(v) => edit((dev) => (dev.settings = v))} />
    </Card>
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
