'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { expandPattern, rewritePoints, rewriteText, stepAddress, type ControlPoint } from '@kestrel/model';
import { PageContainer } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { useInvalidateEstate } from '@/lib/use-estate';
import { useTRPC } from '@/trpc/client';
import type { RouterOutputs } from '@/trpc/types';
import { useRoom } from './room-shell';

type Shape = RouterOutputs['room']['copyShape'];
type ShapeDevice = Shape['devices'][number];

interface DeviceDraft {
  skip: boolean;
  name: string;
  values: Record<string, string>;
  credentialSetId: string | null;
  secrets: Record<string, string>;
  points: ControlPoint[];
}
interface CopyDraft {
  name: string;
  areaId: string | null;
  devices: Record<string, DeviceDraft>;
}

const NONE = '__none';
const MAX_ROWS = 50;

/** The rows a person starts from: numbered names, stepped addresses, points rewritten for each room. */
function generate(
  shape: Shape,
  o: {
    count: number;
    start: number;
    pattern: string;
    find: string;
    replace: string;
    addresses: Record<string, { start: string; step: number }>;
  },
): CopyDraft[] {
  const rewrite = o.find ? { find: o.find, replace: o.replace } : undefined;
  return Array.from({ length: o.count }, (_, i) => {
    const n = o.start + i;
    return {
      name: expandPattern(o.pattern, n),
      areaId: shape.room.areaId,
      devices: Object.fromEntries(
        shape.devices.map((d) => {
          const a = o.addresses[d.id];
          return [
            d.id,
            {
              skip: false,
              name: rewriteText(d.name, rewrite, n),
              values: Object.fromEntries(
                d.binding.map((f) => [
                  f.key,
                  f.key === 'host' && a?.start ? (stepAddress(a.start, a.step, i) ?? '') : '',
                ]),
              ),
              credentialSetId: d.credentialSetId,
              secrets: {},
              points: rewritePoints(d.points, rewrite, n),
            } satisfies DeviceDraft,
          ];
        }),
      ),
    };
  });
}

function clean(values: Record<string, string>) {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ''));
}

/** Makes several copies of a room: each with its own name, addresses, logins and control points. */
export function RoomCopy({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const { orgId, canEdit } = useOrg();
  const { room } = useRoom(roomId);
  const invalidate = useInvalidateEstate();
  const shape = useQuery({ ...trpc.room.copyShape.queryOptions({ orgId, roomId }), retry: false });
  const sets = useQuery(trpc.binding.credentialSets.list.queryOptions({ orgId }));
  const areas = useQuery(trpc.area.list.queryOptions({ orgId, siteId: room?.siteId }));

  const [count, setCount] = useState(2);
  const [start, setStart] = useState(2);
  const [pattern, setPattern] = useState('');
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [addresses, setAddresses] = useState<Record<string, { start: string; step: number }>>({});
  const [drafts, setDrafts] = useState<CopyDraft[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<RouterOutputs['room']['copy'] | null>(null);

  const patternValue = pattern || `${room?.name ?? 'Room'} copy {n}`;
  const active = useMemo(() => (shape.data?.devices ?? []).filter((d) => d.kind === 'active'), [shape.data]);

  const send = useMutation(
    trpc.room.copy.mutationOptions({
      onSuccess: async (res, vars) => {
        setResult(res);
        if (vars.dryRun) {
          if (res.ok) toast.success('Everything checks out');
          return;
        }
        if (res.ok) {
          await invalidate();
          toast.success(`Made ${res.created.length} room${res.created.length === 1 ? '' : 's'}`);
          router.push(orgPath(orgId, '/rooms'));
        }
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  if (!room) return null;
  if (!canEdit)
    return (
      <PageContainer className="pt-5">
        <p className="text-sm text-muted-foreground">You don’t have permission to copy this room.</p>
      </PageContainer>
    );
  if (shape.isPending) return null;
  if (shape.isError || !shape.data)
    return (
      <PageContainer className="pt-5">
        <p className="text-sm text-destructive">This room could not be read.</p>
      </PageContainer>
    );
  const s = shape.data;

  const change = (i: number, fn: (c: CopyDraft) => CopyDraft) =>
    setDrafts((all) => all.map((c, j) => (j === i ? fn(c) : c)));
  const changeDevice = (i: number, id: string, fn: (d: DeviceDraft) => DeviceDraft) =>
    change(i, (c) => ({ ...c, devices: { ...c.devices, [id]: fn(c.devices[id]!) } }));

  const submit = (dryRun: boolean) =>
    send.mutate({
      orgId,
      sourceRoomId: roomId,
      dryRun,
      copies: drafts.map((c) => ({
        name: c.name,
        areaId: c.areaId,
        devices: s.devices.map((d) => {
          const x = c.devices[d.id]!;
          if (x.skip) return { sourceDeviceId: d.id, skip: true };
          return {
            sourceDeviceId: d.id,
            name: x.name,
            ...(d.kind === 'active'
              ? {
                  values: clean(x.values),
                  secrets: clean(x.secrets),
                  credentialSetId: x.credentialSetId,
                  points: x.points,
                }
              : {}),
          };
        }),
      })),
    });

  const rowResult = (i: number) => result?.rows[i];

  return (
    <PageContainer className="max-w-5xl space-y-6 pt-5">
      <section className="space-y-4 rounded-lg border p-4">
        <div>
          <h2 className="text-sm font-medium">Make copies of {s.room.name}</h2>
          <p className="text-sm text-muted-foreground">
            Each copy gets this room’s devices and control points. Addresses and logins are not copied: fill in
            what is different for each room, or leave the saved login in place.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="copy-count">How many</Label>
            <Input
              id="copy-count"
              type="number"
              min={1}
              max={MAX_ROWS}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(MAX_ROWS, Number(e.target.value) || 1)))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="copy-start">First number</Label>
            <Input
              id="copy-start"
              type="number"
              min={0}
              value={start}
              onChange={(e) => setStart(Math.max(0, Number(e.target.value) || 0))}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="copy-pattern">Room names</Label>
            <Input
              id="copy-pattern"
              value={pattern}
              placeholder={patternValue}
              onChange={(e) => setPattern(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {'{n}'} is the number; {'{n:2}'} pads it to two digits.
            </p>
          </div>
        </div>
        {s.devices.some((d) => d.points.length > 0 || d.kind === 'active') && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="copy-find">In names and control points, find</Label>
              <Input id="copy-find" value={find} placeholder="Room1" onChange={(e) => setFind(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="copy-replace">and replace with</Label>
              <Input
                id="copy-replace"
                value={replace}
                placeholder="Room{n}"
                onChange={(e) => setReplace(e.target.value)}
              />
            </div>
          </div>
        )}
        {active.length > 0 && (
          <div className="space-y-2">
            <Label>Starting addresses (each copy steps up from here)</Label>
            {active.map((d) => (
              <div key={d.id} className="grid items-center gap-2 sm:grid-cols-[14rem_minmax(0,1fr)_6rem]">
                <span className="truncate text-sm">{d.name}</span>
                <Input
                  aria-label={`${d.name} starting address`}
                  placeholder="10.0.0.20"
                  value={addresses[d.id]?.start ?? ''}
                  onChange={(e) =>
                    setAddresses((a) => ({ ...a, [d.id]: { start: e.target.value, step: a[d.id]?.step ?? 1 } }))
                  }
                />
                <Input
                  aria-label={`${d.name} step`}
                  type="number"
                  value={addresses[d.id]?.step ?? 1}
                  onChange={(e) =>
                    setAddresses((a) => ({
                      ...a,
                      [d.id]: { start: a[d.id]?.start ?? '', step: Number(e.target.value) || 0 },
                    }))
                  }
                />
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Leave a device’s address blank to type each one below. The number on the right is the step per room
              (0 gives every room the same address, as for a shared device).
            </p>
          </div>
        )}
        <Button
          onClick={() => {
            setDrafts(
              generate(s, { count, start, pattern: patternValue, find, replace, addresses }),
            );
            setResult(null);
          }}
        >
          {drafts.length ? 'Start the rows again' : 'Make the rows'}
        </Button>
      </section>

      {drafts.map((c, i) => {
        const r = rowResult(i);
        return (
          <section key={i} className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1 space-y-1.5">
                <Label htmlFor={`name-${i}`}>Room name</Label>
                <Input
                  id={`name-${i}`}
                  value={c.name}
                  onChange={(e) => change(i, (x) => ({ ...x, name: e.target.value }))}
                />
              </div>
              <div className="w-56 space-y-1.5">
                <Label>Area</Label>
                <SimpleSelect
                  className="w-full"
                  value={c.areaId ?? NONE}
                  onValueChange={(v) => change(i, (x) => ({ ...x, areaId: v === NONE ? null : v }))}
                  options={[
                    { value: NONE, label: 'No area' },
                    ...(areas.data ?? []).map((a) => ({ value: a.id, label: a.name })),
                  ]}
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${c.name || 'this room'}`}
                onClick={() => setDrafts((all) => all.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>

            <div className="divide-y rounded-md border">
              {s.devices.map((d) => (
                <DeviceRow
                  key={d.id}
                  d={d}
                  x={c.devices[d.id]!}
                  sets={sets.data ?? []}
                  expanded={!!open[`${i}:${d.id}`]}
                  onToggle={() => setOpen((o) => ({ ...o, [`${i}:${d.id}`]: !o[`${i}:${d.id}`] }))}
                  onChange={(fn) => changeDevice(i, d.id, fn)}
                />
              ))}
            </div>

            {r?.problems.map((p) => (
              <p key={p} className="text-sm text-destructive">
                {p}
              </p>
            ))}
            {r?.warnings.map((p) => (
              <p key={p} className="text-sm text-warning">
                {p}
              </p>
            ))}
          </section>
        );
      })}

      {drafts.length > 0 && (
        <div className="space-y-2">
          {result?.batch.map((p) => (
            <p key={p} className="text-sm text-destructive">
              {p}
            </p>
          ))}
          <div className="flex gap-2">
            <Button variant="outline" disabled={send.isPending} onClick={() => submit(true)}>
              {send.isPending && send.variables?.dryRun && <Spinner />}
              Check
            </Button>
            <Button disabled={send.isPending} onClick={() => submit(false)}>
              {send.isPending && !send.variables?.dryRun && <Spinner />}
              Make {drafts.length} room{drafts.length === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      )}
    </PageContainer>
  );
}

function DeviceRow({
  d,
  x,
  sets,
  expanded,
  onToggle,
  onChange,
}: {
  d: ShapeDevice;
  x: DeviceDraft;
  sets: { id: string; name: string }[];
  expanded: boolean;
  onToggle: () => void;
  onChange: (fn: (d: DeviceDraft) => DeviceDraft) => void;
}) {
  const needsLogin = d.secret.length > 0 && !x.credentialSetId;
  return (
    <div className={x.skip ? 'space-y-2 p-3 opacity-60' : 'space-y-2 p-3'}>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label={`${d.name} name`}
          className="w-56"
          value={x.name}
          disabled={x.skip}
          onChange={(e) => onChange((v) => ({ ...v, name: e.target.value }))}
        />
        <span className="text-xs text-muted-foreground">{d.driverName ?? 'Recorded only'}</span>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={x.skip}
            onChange={(e) => onChange((v) => ({ ...v, skip: e.target.checked }))}
          />
          Leave out
        </label>
      </div>
      {!x.skip && d.kind === 'active' && (
        <div className="grid gap-2 sm:grid-cols-3">
          {d.binding.map((f) => (
            <Input
              key={f.key}
              aria-label={`${d.name} ${f.label}`}
              placeholder={f.label}
              value={x.values[f.key] ?? ''}
              onChange={(e) => onChange((v) => ({ ...v, values: { ...v.values, [f.key]: e.target.value } }))}
            />
          ))}
          {d.secret.length > 0 && (
            <SimpleSelect
              className="w-full"
              value={x.credentialSetId ?? NONE}
              onValueChange={(v) => onChange((c) => ({ ...c, credentialSetId: v === NONE ? null : v }))}
              options={[
                { value: NONE, label: 'Type a login for this room' },
                ...sets.map((s) => ({ value: s.id, label: `Saved login: ${s.name}` })),
              ]}
            />
          )}
          {needsLogin &&
            d.secret.map((f) => (
              <Input
                key={f.key}
                type="password"
                autoComplete="off"
                aria-label={`${d.name} ${f.label}`}
                placeholder={f.label}
                value={x.secrets[f.key] ?? ''}
                onChange={(e) => onChange((v) => ({ ...v, secrets: { ...v.secrets, [f.key]: e.target.value } }))}
              />
            ))}
        </div>
      )}
      {!x.skip && x.points.length > 0 && (
        <div>
          <button
            type="button"
            onClick={onToggle}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {x.points.length} control point{x.points.length === 1 ? '' : 's'}
          </button>
          {expanded && (
            <div className="mt-2 space-y-2">
              {x.points.map((p, k) => (
                <div key={p.id} className="grid gap-2 sm:grid-cols-[12rem_repeat(auto-fit,minmax(8rem,1fr))]">
                  <Input
                    aria-label={`Point ${k + 1} name`}
                    value={p.name}
                    onChange={(e) =>
                      onChange((v) => ({
                        ...v,
                        points: v.points.map((q, j) => (j === k ? { ...q, name: e.target.value } : q)),
                      }))
                    }
                  />
                  {Object.entries(p.address).map(([key, value]) => (
                    <Input
                      key={key}
                      aria-label={`${p.name} ${key}`}
                      placeholder={key}
                      value={String(value)}
                      onChange={(e) =>
                        onChange((v) => ({
                          ...v,
                          points: v.points.map((q, j) =>
                            j === k ? { ...q, address: { ...q.address, [key]: e.target.value } } : q,
                          ),
                        }))
                      }
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
