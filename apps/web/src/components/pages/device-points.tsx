'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  BUILT_IN_DRIVERS,
  ControlPoint,
  POINT_TYPE_LABEL,
  pointToLevel,
  type PointType,
} from '@kestrel/model';
import { Section } from '@/components/common/section';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  gainPoints,
  namedControlPoint,
  routerPoints,
  slug,
  uniqueIds,
  type NamedControlType,
} from '@/lib/qsys-points';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';

type Device = RouterOutputs['device']['get'];
type Severity = 'info' | 'warning' | 'critical';

const SEVERITIES = [
  { value: 'info', label: 'Information' },
  { value: 'warning', label: 'Warning' },
  { value: 'critical', label: 'Critical' },
];

const round1 = (n: number) => Math.round(n * 10) / 10;
const onOff = (v: boolean) => (v ? 'On' : 'Off');

/** The range a level point maps onto 0 to 100 (its own, or the usual -40 to 0). */
const rangeOf = (p: Pick<ControlPoint, 'min' | 'max'>) => ({ min: p.min ?? -40, max: p.max ?? 0 });
const dbOf = (p: Pick<ControlPoint, 'min' | 'max'>, level: number) => {
  const r = rangeOf(p);
  return round1(r.min + (level / 100) * (r.max - r.min));
};

/** How a reading is shown: a level in dB, a mute as muted or not, anything else as it is. */
function reading(p: ControlPoint, v: unknown): string {
  if (v === undefined || v === null) return '–';
  if (p.type === 'level' && typeof v === 'number') return `${dbOf(p, v)} dB`;
  if (p.type === 'mute') return v === true ? 'Muted' : 'Not muted';
  if (typeof v === 'boolean') return onOff(v);
  return String(v);
}

/** What a point is watched for, in words. */
function watching(p: ControlPoint): string {
  const w = p.watch;
  if (!w) return 'Not watched';
  const parts: string[] = [];
  if (w.expect !== undefined)
    parts.push(
      `should be ${p.type === 'mute' ? (w.expect === true ? 'muted' : 'not muted') : typeof w.expect === 'boolean' ? onOff(w.expect) : String(w.expect)}`,
    );
  if (w.min !== undefined)
    parts.push(`not below ${p.type === 'level' ? `${dbOf(p, w.min)} dB` : w.min}`);
  if (w.max !== undefined)
    parts.push(`not above ${p.type === 'level' ? `${dbOf(p, w.max)} dB` : w.max}`);
  return parts.length ? `${parts.join(', ')} (${w.severity})` : 'Not watched';
}

function addressText(p: ControlPoint): string {
  const { component, control } = p.address;
  return component ? `${component} › ${control}` : `${control ?? ''} (named control)`;
}

// ---- Watch editor -------------------------------------------------------------------------------

type Kind = 'db' | 'bool' | 'text' | 'number';
const kindOf = (p: ControlPoint): Kind =>
  p.type === 'level'
    ? 'db'
    : p.type === 'mute' || p.valueType === 'boolean'
      ? 'bool'
      : p.type === 'generic' && p.valueType === 'text'
        ? 'text'
        : 'number';

function WatchDialog({
  point,
  onSave,
  onClose,
}: {
  point: ControlPoint;
  onSave: (p: ControlPoint) => void;
  onClose: () => void;
}) {
  const kind = kindOf(point);
  const w = point.watch;
  const [expect, setExpect] = useState(
    w?.expect === undefined
      ? ''
      : typeof w.expect === 'boolean'
        ? String(w.expect)
        : String(w.expect),
  );
  const [min, setMin] = useState(
    w?.min === undefined ? '' : String(kind === 'db' ? dbOf(point, w.min) : w.min),
  );
  const [max, setMax] = useState(
    w?.max === undefined ? '' : String(kind === 'db' ? dbOf(point, w.max) : w.max),
  );
  const [severity, setSeverity] = useState<Severity>(w?.severity ?? 'warning');

  const save = () => {
    const watch: NonNullable<ControlPoint['watch']> = { severity };
    if (expect !== '') {
      if (kind === 'bool') watch.expect = expect === 'true';
      else if (kind === 'text') watch.expect = expect;
      else if (!Number.isNaN(Number(expect))) watch.expect = Number(expect);
    }
    const num = (s: string) =>
      s.trim() !== '' && !Number.isNaN(Number(s)) ? Number(s) : undefined;
    const lo = num(min);
    const hi = num(max);
    if (kind === 'db') {
      if (lo !== undefined) watch.min = pointToLevel(rangeOf(point), lo);
      if (hi !== undefined) watch.max = pointToLevel(rangeOf(point), hi);
    } else if (kind === 'number') {
      if (lo !== undefined) watch.min = lo;
      if (hi !== undefined) watch.max = hi;
    }
    const watching =
      watch.expect !== undefined || watch.min !== undefined || watch.max !== undefined;
    const next: ControlPoint = { ...point };
    if (watching) next.watch = watch;
    else delete next.watch;
    onSave(next);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Watch: {point.name}</DialogTitle>
          <DialogDescription>
            Kestrel raises an incident while the reading is outside what you set here, and closes it
            when it is back. Leave everything blank to stop watching.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {kind === 'bool' && (
            <div className="space-y-1.5">
              <Label>It should be</Label>
              <SimpleSelect
                className="w-full"
                value={expect}
                onValueChange={setExpect}
                options={[
                  { value: '', label: 'Do not watch' },
                  point.type === 'mute'
                    ? { value: 'false', label: 'Not muted' }
                    : { value: 'false', label: 'Off' },
                  point.type === 'mute'
                    ? { value: 'true', label: 'Muted' }
                    : { value: 'true', label: 'On' },
                ]}
              />
            </div>
          )}
          {(kind === 'text' || kind === 'number') && (
            <div className="space-y-1.5">
              <Label htmlFor="w-expect">It should be (blank: any)</Label>
              <Input
                id="w-expect"
                type={kind === 'number' ? 'number' : 'text'}
                value={expect}
                onChange={(e) => setExpect(e.target.value)}
              />
            </div>
          )}
          {(kind === 'db' || kind === 'number') && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="w-min">Not below{kind === 'db' ? ' (dB)' : ''}</Label>
                <Input
                  id="w-min"
                  type="number"
                  step="any"
                  value={min}
                  onChange={(e) => setMin(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="w-max">Not above{kind === 'db' ? ' (dB)' : ''}</Label>
                <Input
                  id="w-max"
                  type="number"
                  step="any"
                  value={max}
                  onChange={(e) => setMax(e.target.value)}
                />
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>How serious</Label>
            <SimpleSelect
              className="w-full"
              value={severity}
              onValueChange={(v) => setSeverity(v as Severity)}
              options={SEVERITIES}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- Adding -------------------------------------------------------------------------------------

type QsysMode = 'gain' | 'router' | 'control';

/** The Q-SYS way: a named component (gain or router) or a named control. */
function AddQsys({
  taken,
  onAdd,
  onClose,
}: {
  taken: string[];
  onAdd: (points: ControlPoint[]) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<QsysMode>('gain');
  const [name, setName] = useState('');
  const [outputs, setOutputs] = useState('4');
  const [valueType, setValueType] = useState<NamedControlType>('boolean');
  const [minDb, setMinDb] = useState('');
  const [maxDb, setMaxDb] = useState('');
  const [mute, setMute] = useState('');
  const [expect, setExpect] = useState('');
  const [severity, setSeverity] = useState<Severity>('warning');

  const num = (s: string) => (s.trim() !== '' && !Number.isNaN(Number(s)) ? Number(s) : null);
  const build = (): ControlPoint[] => {
    if (mode === 'gain')
      return gainPoints(name, {
        minDb: num(minDb),
        maxDb: num(maxDb),
        muteShouldBe: mute === '' ? null : mute === 'true',
        severity,
      });
    if (mode === 'router') return routerPoints(name, Number(outputs) || 1);
    const e =
      expect === ''
        ? null
        : valueType === 'boolean'
          ? expect === 'true'
          : valueType === 'integer'
            ? num(expect)
            : expect;
    return [namedControlPoint(name, valueType, e, severity)];
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add control points</DialogTitle>
          <DialogDescription>
            Use the names exactly as they are in your Q-SYS design. Kestrel reads them through one
            change group on the Core, so only what changes is sent.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>What are you adding?</Label>
            <SimpleSelect
              className="w-full"
              value={mode}
              onValueChange={(v) => setMode(v as QsysMode)}
              options={[
                { value: 'gain', label: 'Named component: gain (level and mute)' },
                { value: 'router', label: 'Named component: router (an input per output)' },
                { value: 'control', label: 'Named control (on or off, a number, or text)' },
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="q-name">{mode === 'control' ? 'Control name' : 'Component name'}</Label>
            <Input
              id="q-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                mode === 'control'
                  ? 'Mic Mute'
                  : mode === 'router'
                    ? 'Main Router'
                    : 'Boardroom Gain'
              }
            />
          </div>

          {mode === 'router' && (
            <div className="space-y-1.5">
              <Label htmlFor="q-out">How many outputs does it have?</Label>
              <Input
                id="q-out"
                type="number"
                min={1}
                max={64}
                value={outputs}
                onChange={(e) => setOutputs(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Adds select.1 to select.{Math.max(1, Math.min(64, Number(outputs) || 1))}, each
                showing which input is routed to that output.
              </p>
            </div>
          )}

          {mode === 'gain' && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Adds its gain (dB) and its mute. Optionally watch them:
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="q-min">Level not below (dB)</Label>
                  <Input
                    id="q-min"
                    type="number"
                    step="any"
                    value={minDb}
                    onChange={(e) => setMinDb(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="q-max">Level not above (dB)</Label>
                  <Input
                    id="q-max"
                    type="number"
                    step="any"
                    value={maxDb}
                    onChange={(e) => setMaxDb(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Mute should be</Label>
                <SimpleSelect
                  className="w-full"
                  value={mute}
                  onValueChange={setMute}
                  options={[
                    { value: '', label: 'Do not watch' },
                    { value: 'false', label: 'Not muted' },
                    { value: 'true', label: 'Muted' },
                  ]}
                />
              </div>
            </div>
          )}

          {mode === 'control' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Type of value</Label>
                <SimpleSelect
                  className="w-full"
                  value={valueType}
                  onValueChange={(v) => {
                    setValueType(v as NamedControlType);
                    setExpect('');
                  }}
                  options={[
                    { value: 'boolean', label: 'On or off (Boolean)' },
                    { value: 'integer', label: 'Whole number (Integer)' },
                    { value: 'text', label: 'Text' },
                  ]}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="q-expect">Should be (blank: do not watch)</Label>
                {valueType === 'boolean' ? (
                  <SimpleSelect
                    className="w-full"
                    value={expect}
                    onValueChange={setExpect}
                    options={[
                      { value: '', label: 'Do not watch' },
                      { value: 'false', label: 'Off' },
                      { value: 'true', label: 'On' },
                    ]}
                  />
                ) : (
                  <Input
                    id="q-expect"
                    type={valueType === 'integer' ? 'number' : 'text'}
                    value={expect}
                    onChange={(e) => setExpect(e.target.value)}
                  />
                )}
              </div>
            </div>
          )}

          {mode !== 'router' && (
            <div className="space-y-1.5">
              <Label>How serious if it is not</Label>
              <SimpleSelect
                className="w-full"
                value={severity}
                onValueChange={(v) => setSeverity(v as Severity)}
                options={SEVERITIES}
              />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!name.trim()} onClick={() => onAdd(uniqueIds(build(), taken))}>
              Add
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Any other driver that takes points: choose the kind and fill in the address it asks for. */
function AddGeneric({
  driverId,
  taken,
  onAdd,
  onClose,
}: {
  driverId: string;
  taken: string[];
  onAdd: (points: ControlPoint[]) => void;
  onClose: () => void;
}) {
  const info = BUILT_IN_DRIVERS[driverId]!;
  const types = Object.keys(info.points ?? {}) as PointType[];
  const [type, setType] = useState<PointType>(types[0]!);
  const [name, setName] = useState('');
  const [address, setAddress] = useState<Record<string, string>>({});
  const fields = info.points?.[type] ?? [];
  const ready = name.trim() && fields.every((f) => f.optional || (address[f.key] ?? '').trim());
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a control point</DialogTitle>
          <DialogDescription>{info.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Kind</Label>
              <SimpleSelect
                className="w-full"
                value={type}
                onValueChange={(v) => setType(v as PointType)}
                options={types.map((t) => ({ value: t, label: POINT_TYPE_LABEL[t] }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="g-name">Name</Label>
              <Input id="g-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          {fields.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label htmlFor={`g-${f.key}`}>{f.label}</Label>
              <Input
                id={`g-${f.key}`}
                value={address[f.key] ?? ''}
                onChange={(e) => setAddress({ ...address, [f.key]: e.target.value })}
              />
            </div>
          ))}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!ready}
              onClick={() =>
                onAdd(
                  uniqueIds(
                    [
                      {
                        id: slug(name),
                        name: name.trim(),
                        type,
                        address: Object.fromEntries(
                          fields.flatMap((f) =>
                            (address[f.key] ?? '').trim() ? [[f.key, address[f.key]!.trim()]] : [],
                          ),
                        ),
                      },
                    ],
                    taken,
                  ),
                )
              }
            >
              Add
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- The tab ------------------------------------------------------------------------------------

/** The control points read on a monitored device (a DSP's gain blocks, routers, named controls). */
export function DevicePoints({ device }: { device: Device }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId, canSupport } = useOrg();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ControlPoint | null>(null);
  const control = device.control as { kind?: string; driverId?: string } | null;
  const driverId = control?.kind === 'driver' ? (control.driverId ?? null) : null;
  const info = driverId ? BUILT_IN_DRIVERS[driverId] : undefined;
  const points = ControlPoint.array().safeParse(device.points);
  const list = points.success ? points.data : [];
  const values = (device.pointValues ?? {}) as Record<string, unknown>;

  const save = useMutation(
    trpc.device.setPoints.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: trpc.device.get.queryKey() });
        toast.success('Control points saved. The gateway picks them up within a minute.');
        setAdding(false);
        setEditing(null);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const put = (next: ControlPoint[]) => save.mutate({ orgId, deviceId: device.id, points: next });

  if (device.kind !== 'active' || !info?.points)
    return (
      <p className="text-sm text-muted-foreground">
        {device.kind !== 'active'
          ? 'Control points are read on monitored devices.'
          : 'Choose a driver that supports control points (for example Q-SYS Core) to add them here.'}
      </p>
    );

  return (
    <Section
      title="Control points"
      action={
        canSupport && (
          <Button size="sm" onClick={() => setAdding(true)} disabled={save.isPending}>
            <Plus data-icon="inline-start" /> Add
          </Button>
        )
      }
    >
      {list.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          Nothing is being read inside this device yet.
          {driverId === 'qsys-core'
            ? ' Add the named components (gain, router) and named controls you want to see and watch.'
            : ' Add the points you want to see and watch.'}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Where</TableHead>
              <TableHead>Reading</TableHead>
              <TableHead>Watching</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">
                  {p.name}
                  <div className="text-xs font-normal text-muted-foreground">
                    {POINT_TYPE_LABEL[p.type]}
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{addressText(p)}</TableCell>
                <TableCell className="tabular-nums">{reading(p, values[p.id])}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{watching(p)}</TableCell>
                <TableCell>
                  {canSupport && (
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Change what ${p.name} is watched for`}
                        onClick={() => setEditing(p)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${p.name}`}
                        disabled={save.isPending}
                        onClick={() => put(list.filter((x) => x.id !== p.id))}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {save.isPending && (
        <p className="flex items-center gap-2 px-4 pb-3 text-xs text-muted-foreground">
          <Spinner /> Saving
        </p>
      )}
      {adding &&
        (driverId === 'qsys-core' ? (
          <AddQsys
            taken={list.map((p) => p.id)}
            onAdd={(more) => put([...list, ...more])}
            onClose={() => setAdding(false)}
          />
        ) : (
          <AddGeneric
            driverId={driverId!}
            taken={list.map((p) => p.id)}
            onAdd={(more) => put([...list, ...more])}
            onClose={() => setAdding(false)}
          />
        ))}
      {editing && (
        <WatchDialog
          key={editing.id}
          point={editing}
          onSave={(p) => put(list.map((x) => (x.id === p.id ? p : x)))}
          onClose={() => setEditing(null)}
        />
      )}
    </Section>
  );
}
