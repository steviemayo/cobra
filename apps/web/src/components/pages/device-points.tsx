'use client';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  BUILT_IN_DRIVERS,
  type BrowsedPoint,
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
import { cascade } from '@/lib/point-tree';
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
const WHOLE_DEVICE = '__whole';
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

/** How often to ask whether the gateway has answered, and when to stop asking. */
const BROWSE_POLL_MS = 2000;
const BROWSE_GIVE_UP_MS = 2 * 60_000;
const MAX_LISTED = 100;

/** A control point's value type, from the value the device reported for it. */
const valueTypeOf = (v: BrowsedPoint['value']): ControlPoint['valueType'] =>
  typeof v === 'boolean'
    ? 'boolean'
    : typeof v === 'number'
      ? Number.isInteger(v)
        ? 'integer'
        : 'float'
      : typeof v === 'string'
        ? 'text'
        : undefined;

/**
 * Lists what the live device can report, read through its gateway, so a point is picked from the
 * device instead of its path being typed. The device has to be online and answer with its whole tree.
 */
function PointPicker({
  deviceId,
  onPick,
}: {
  deviceId: string;
  onPick: (p: BrowsedPoint) => void;
}) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [commandId, setCommandId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<'browse' | 'search'>('browse');
  const [chosen, setChosen] = useState<string[]>([]);
  const asked = useRef(false);

  const start = useMutation(
    trpc.device.browsePoints.mutationOptions({
      onSuccess: (res) => {
        setStartError(null);
        setTimedOut(false);
        setCommandId(res.commandId);
      },
      onError: (e) => setStartError(e.message),
    }),
  );
  const ask = () => {
    setCommandId(null);
    setStartError(null);
    start.mutate({ orgId, deviceId });
  };
  // Ask once when the dialog opens; "Try again" asks again.
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    start.mutate({ orgId, deviceId });
  }, [start, orgId, deviceId]);
  useEffect(() => {
    if (!commandId) return;
    const t = setTimeout(() => setTimedOut(true), BROWSE_GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [commandId]);

  const result = useQuery({
    ...trpc.device.browseResult.queryOptions({ orgId, commandId: commandId ?? '' }),
    enabled: !!commandId,
    retry: false,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return timedOut ||
        q.state.status === 'error' ||
        (status && status !== 'pending' && status !== 'sent')
        ? false
        : BROWSE_POLL_MS;
    },
  });
  const status = result.data?.status;
  const waiting =
    start.isPending ||
    (!!commandId && !timedOut && (!status || status === 'pending' || status === 'sent'));
  const problem =
    startError ??
    (status === 'failed' || status === 'expired'
      ? (result.data?.error ?? 'The gateway could not read the device.')
      : timedOut && !status
        ? 'The gateway did not answer in time.'
        : null);
  const points = status === 'succeeded' ? (result.data?.points ?? []) : [];
  const q = filter.trim().toLowerCase();
  const matches = q
    ? points.filter((p) =>
        `${p.label} ${p.group} ${p.path} ${p.value ?? ''}`.toLowerCase().includes(q),
      )
    : points;

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <Label>Pick from the device</Label>
        {!waiting && (
          <Button variant="ghost" size="sm" onClick={ask}>
            {problem ? 'Try again' : 'Read again'}
          </Button>
        )}
      </div>
      {waiting && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner /> Asking the gateway to read the device. This can take up to 30 seconds.
        </p>
      )}
      {problem && !waiting && (
        <p className="text-xs text-destructive">
          {problem} The device has to be online. You can still type the path below.
        </p>
      )}
      {points.length > 0 && (
        <div className="flex gap-1">
          <Button
            variant={mode === 'browse' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setMode('browse')}
          >
            Browse by section
          </Button>
          <Button
            variant={mode === 'search' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setMode('search')}
          >
            Search
          </Button>
        </div>
      )}
      {points.length > 0 && mode === 'browse' && (
        <div className="space-y-2">
          {cascade(points, chosen).map((level, depth) => (
            <SimpleSelect
              key={depth}
              className="w-full"
              value={level.value}
              placeholder={depth === 0 ? 'Choose a section' : 'Choose…'}
              onValueChange={(v) => {
                const next = [...chosen.slice(0, depth), v];
                setChosen(next);
                const leaf = level.choices.find((c) => c.segment === v);
                if (leaf?.point && leaf.count === 1) onPick(leaf.point);
              }}
              options={level.choices.map((c) => ({
                value: c.segment,
                label:
                  c.point && c.count === 1
                    ? `${c.point.label}${c.point.value !== undefined ? `  =  ${String(c.point.value)}` : ''}`
                    : `${c.segment}  (${c.count})`,
              }))}
            />
          ))}
        </div>
      )}
      {points.length > 0 && mode === 'search' && (
        <>
          <Input
            placeholder="Search, for example IP table, TSW or ONLINE"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Search what the device reports"
          />
          <div className="max-h-56 overflow-y-auto rounded-md border">
            {matches.slice(0, MAX_LISTED).map((p) => (
              <button
                key={p.path}
                type="button"
                onClick={() => onPick(p)}
                className="flex w-full items-start justify-between gap-3 border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{p.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{p.group}</span>
                </span>
                {p.value !== undefined && (
                  <span className="shrink-0 text-xs tabular-nums">{String(p.value)}</span>
                )}
              </button>
            ))}
            {matches.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">Nothing matches.</p>
            )}
          </div>
          {(matches.length > MAX_LISTED || result.data?.truncated) && (
            <p className="text-xs text-muted-foreground">
              {matches.length > MAX_LISTED
                ? `Showing the first ${MAX_LISTED} of ${matches.length}. Search to narrow it down.`
                : 'The device has more values than are listed. Type the path for anything missing.'}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Any other driver that takes points: choose the kind and fill in the address it asks for. */
function AddGeneric({
  driverId,
  deviceId,
  taken,
  onAdd,
  onClose,
}: {
  driverId: string;
  deviceId: string;
  taken: string[];
  onAdd: (points: ControlPoint[]) => void;
  onClose: () => void;
}) {
  const info = BUILT_IN_DRIVERS[driverId]!;
  const types = Object.keys(info.points ?? {}) as PointType[];
  const [type, setType] = useState<PointType>(types[0]!);
  const [name, setName] = useState('');
  const [address, setAddress] = useState<Record<string, string>>({});
  // What was picked from the device: the type of its value, and what it should be (if the driver knows).
  const [picked, setPicked] = useState<BrowsedPoint | null>(null);
  const [alertOn, setAlertOn] = useState(true);
  const [severity, setSeverity] = useState<Severity>('warning');
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
          {info.browse && type === 'generic' && (
            <PointPicker
              deviceId={deviceId}
              onPick={(p) => {
                setPicked(p);
                setAddress({ ...address, path: p.path });
                if (!name.trim()) setName(`${p.group}: ${p.label}`.slice(0, 80));
              }}
            />
          )}
          {fields.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label htmlFor={`g-${f.key}`}>{f.label}</Label>
              {f.options ? (
                <SimpleSelect
                  className="w-full"
                  value={address[f.key] ?? ''}
                  placeholder="Choose…"
                  onValueChange={(v) => {
                    setPicked(null);
                    setAddress({ ...address, [f.key]: v });
                  }}
                  options={f.options}
                />
              ) : (
                <Input
                  id={`g-${f.key}`}
                  value={address[f.key] ?? ''}
                  onChange={(e) => {
                    setPicked(null);
                    setAddress({ ...address, [f.key]: e.target.value });
                  }}
                />
              )}
            </div>
          ))}
          {picked?.expect !== undefined && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Watch</Label>
                <SimpleSelect
                  className="w-full"
                  value={alertOn ? 'on' : 'off'}
                  onValueChange={(v) => setAlertOn(v === 'on')}
                  options={[
                    { value: 'on', label: `Alert when it is not ${String(picked.expect)}` },
                    { value: 'off', label: 'Do not watch' },
                  ]}
                />
              </div>
              {alertOn && (
                <div className="space-y-1.5">
                  <Label>How serious</Label>
                  <SimpleSelect
                    className="w-full"
                    value={severity}
                    onValueChange={(v) => setSeverity(v as Severity)}
                    options={SEVERITIES}
                  />
                </div>
              )}
            </div>
          )}
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
                        ...(picked && valueTypeOf(picked.value)
                          ? { valueType: valueTypeOf(picked.value) }
                          : {}),
                        ...(picked && alertOn && picked.expect !== undefined
                          ? { watch: { expect: picked.expect, severity } }
                          : {}),
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
  // A shared device holds a room's own points: say which room each one belongs to.
  const serves = [
    ...(device.roomId && device.roomName ? [{ id: device.roomId, name: device.roomName }] : []),
    ...device.sharedRooms.map((r) => ({ id: r.id, name: r.name })),
  ];
  const sharedDevice = device.sharedRooms.length > 0;

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
              {sharedDevice && <TableHead>Room</TableHead>}
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
                {sharedDevice && (
                  <TableCell>
                    <SimpleSelect
                      size="sm"
                      className="w-44"
                      value={p.roomId ?? WHOLE_DEVICE}
                      disabled={!canSupport || save.isPending}
                      onValueChange={(v) =>
                        put(
                          list.map((x) => {
                            if (x.id !== p.id) return x;
                            const rest = { ...x };
                            delete rest.roomId;
                            return v === WHOLE_DEVICE ? rest : { ...rest, roomId: v };
                          }),
                        )
                      }
                      options={[
                        { value: WHOLE_DEVICE, label: 'Every room' },
                        ...serves.map((r) => ({ value: r.id, label: r.name })),
                      ]}
                    />
                  </TableCell>
                )}
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
            deviceId={device.id}
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
