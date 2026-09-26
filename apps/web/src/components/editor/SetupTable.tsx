'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BUILT_IN_DRIVERS, declaredSettings, type DeclaredSetting, type Device } from '@kestrel/model';
import type { DeviceBindingView } from '@/server/bindings';
import { useOrg } from '@/components/shell/org-context';
import { fieldKind, isBlockPaste, parseFieldValue, parsePasted } from '@/lib/editor/driver-settings';
import { useTRPC } from '@/trpc/client';
import { ValueInput } from './DevicesPanel';
import { btnCls, ghostBtnCls, inputCls, type PanelProps } from './ui';
import { useDriverSources } from './use-driver-sources';

// Every device's driver settings in one grid: a row per device, a column per setting. Addresses and
// logins are kept apart from the design, as on the cards: they save with the Save button and reach
// the room's gateway without a release. Design settings are the room's own and save with the room.

type Scope = DeclaredSetting['scope'];
const SCOPE_ORDER: Scope[] = ['binding', 'secret', 'design'];
const SCOPE_NAME: Record<Scope, string> = { binding: 'address', secret: 'login', design: 'design' };

interface Column {
  id: string;
  key: string;
  label: string;
  scope: Scope;
}

interface Row {
  device: Device;
  declared: DeclaredSetting[];
  driver: string;
  view: DeviceBindingView | undefined;
}

type Typed = Record<string, Record<string, string>>;

const cellCls = `${inputCls} w-full min-w-28`;

export function SetupTable({
  roomId,
  model,
  update,
  views,
  sets,
  canEdit,
  onDirty,
}: {
  roomId: string;
  model: PanelProps['model'];
  update: PanelProps['update'];
  views: DeviceBindingView[];
  sets: { id: string; name: string; fields: string[] }[];
  canEdit: boolean;
  onDirty: (dirty: boolean) => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const { sources, drivers, ready } = useDriverSources();
  const [typed, setTyped] = useState<Typed>({});
  const [setChoice, setSetChoice] = useState<Record<string, string>>({});

  const driverName = (d: Device) => {
    const c = d.control;
    if (c?.kind === 'generic') return `Generic: ${c.protocol}`;
    if (c?.kind === 'driver') return BUILT_IN_DRIVERS[c.driverId]?.name ?? drivers.find((x) => x.id === c.driverId)?.name ?? c.driverId;
    return '';
  };

  // Devices with the same driver sit together, so their columns line up.
  const rows: Row[] = model.devices
    .flatMap((device, i) => {
      const declared = declaredSettings(device, sources);
      return declared && declared.length > 0
        ? [{ i, row: { device, declared, driver: driverName(device), view: views.find((v) => v.deviceId === device.id) } }]
        : [];
    })
    .sort((a, b) => a.row.driver.localeCompare(b.row.driver) || a.i - b.i)
    .map((x) => x.row);

  const columns: Column[] = [];
  for (const scope of SCOPE_ORDER)
    for (const r of rows)
      for (const s of r.declared)
        if (s.scope === scope && !columns.some((c) => c.scope === scope && c.key === s.key))
          columns.push({ id: `${scope}:${s.key}`, key: s.key, label: s.label, scope });

  const dirty = Object.values(typed).some((f) => Object.keys(f).length > 0) || Object.keys(setChoice).length > 0;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const save = useMutation(
    trpc.binding.saveDevices.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Saved ${r.devices} ${r.devices === 1 ? 'device' : 'devices'}`);
        setTyped({});
        setSetChoice({});
        void qc.invalidateQueries({ queryKey: trpc.binding.view.queryKey() });
        void qc.invalidateQueries({ queryKey: trpc.binding.credentialSets.list.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const settingOf = (row: Row, col: Column) => row.declared.find((s) => s.key === col.key && s.scope === col.scope);
  const isShared = (row: Row) => !!row.view?.sharedFrom || !!row.device.siteDeviceId;
  const slotOf = (row: Row, key: string) => row.view?.slots.find((s) => s.key === key);

  const setTypedValue = (deviceId: string, key: string, text: string | null) =>
    setTyped((t) => {
      const fields = { ...t[deviceId] };
      if (text === null) delete fields[key];
      else fields[key] = text;
      const next = { ...t };
      if (Object.keys(fields).length === 0) delete next[deviceId];
      else next[deviceId] = fields;
      return next;
    });

  const setDesignValue = (deviceId: string, key: string, kind: ReturnType<typeof fieldKind>, text: string) => {
    const r = parseFieldValue(kind, text);
    if (!r.ok) return;
    update((m) => {
      const dev = m.devices.find((x) => x.id === deviceId);
      if (!dev) return;
      if (r.value === undefined) delete dev.settings[key];
      else dev.settings[key] = r.value;
    });
  };

  /** What pasting text into this cell does, or null when the cell takes no text. */
  const pasteInto = (ri: number, ci: number): ((text: string) => void) | null => {
    const row = rows[ri];
    const col = columns[ci];
    const s = row && col && settingOf(row, col);
    if (!row || !col || !s || !canEdit) return null;
    if (s.scope === 'design') {
      const kind = fieldKind(s, row.device.settings[s.key]);
      return kind === 'json' ? null : (text) => setDesignValue(row.device.id, s.key, kind, text);
    }
    if (isShared(row)) return null;
    return (text) => setTypedValue(row.device.id, s.key, text);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTableElement>) => {
    const at = (e.target as HTMLElement).dataset.cell;
    const text = e.clipboardData.getData('text');
    if (!at || !isBlockPaste(text)) return;
    e.preventDefault();
    const [r, c] = at.split(':').map(Number) as [number, number];
    parsePasted(text).forEach((cells, i) =>
      cells.forEach((v, j) => {
        // A blank cell in what was pasted leaves that setting as it is.
        if (v.trim() !== '') pasteInto(r + i, c + j)?.(v.trim());
      }),
    );
  };

  // Enter and the up and down arrows move between rows, like a spreadsheet.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTableElement>) => {
    const target = e.target as HTMLElement;
    const at = target.dataset.cell;
    if (!at || e.altKey || e.ctrlKey || e.metaKey) return;
    const numeric = target instanceof HTMLInputElement && target.type === 'number';
    const multiline = target instanceof HTMLTextAreaElement;
    const step =
      e.key === 'Enter' && !multiline ? (e.shiftKey ? -1 : 1) : !numeric && !multiline && e.key === 'ArrowDown' ? 1 : !numeric && !multiline && e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    const [r, c] = at.split(':').map(Number) as [number, number];
    for (let n = r + step; n >= 0 && n < rows.length; n += step) {
      const next = e.currentTarget.querySelector<HTMLElement>(`[data-cell="${n}:${c}"]:not(:disabled)`);
      if (next) {
        e.preventDefault();
        next.focus();
        if (next instanceof HTMLInputElement && next.type !== 'checkbox') next.select();
        return;
      }
    }
  };

  // Starting values for addresses that have one (a usual username, say), typed in where nothing is set.
  const fillable: { deviceId: string; key: string; value: string }[] = [];
  for (const row of rows)
    if (!isShared(row))
      for (const s of row.declared)
        if (s.scope === 'binding' && s.default !== undefined && !slotOf(row, s.key)?.isSet && !typed[row.device.id]?.[s.key])
          fillable.push({ deviceId: row.device.id, key: s.key, value: String(s.default) });

  const anySecret = rows.some((r) => !isShared(r) && r.declared.some((s) => s.scope === 'secret'));

  const submit = () => {
    const ids = new Set([...Object.keys(typed), ...Object.keys(setChoice)]);
    save.mutate({
      orgId,
      roomId,
      changes: [...ids].map((deviceId) => ({
        deviceId,
        ...(typed[deviceId] ? { set: typed[deviceId] } : {}),
        ...(setChoice[deviceId] !== undefined ? { credentialSetId: setChoice[deviceId] || null } : {}),
      })),
    });
  };

  if (!ready) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">No device in this room has a driver with settings yet.</p>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        One row per device, one column per setting. Paste a block from a spreadsheet into any cell to fill several at once.
        Enter and the arrow keys move between rows. Design settings save with the room. Addresses and logins save with Save.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full border-collapse text-sm" onPaste={onPaste} onKeyDown={onKeyDown}>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="sticky left-0 z-10 min-w-44 bg-card px-2 py-1.5 font-medium">Device</th>
              {columns.map((c) => (
                <th key={c.id} className="min-w-32 px-1 py-1.5 font-medium">
                  <div>{c.label}</div>
                  <div className="text-[10px] font-normal uppercase tracking-wide">{SCOPE_NAME[c.scope]}</div>
                </th>
              ))}
              {anySecret && canEdit && <th className="min-w-40 px-1 py-1.5 font-medium">Shared login</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={row.device.id} className="border-b border-border last:border-0">
                <th className="sticky left-0 z-10 bg-card px-2 py-1 text-left font-normal">
                  <div className="font-medium">{row.device.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {row.driver}
                    {isShared(row) && ' · shared device'}
                  </div>
                </th>
                {columns.map((col, ci) => (
                  <Cell
                    key={col.id}
                    at={`${ri}:${ci}`}
                    row={row}
                    setting={settingOf(row, col)}
                    slot={settingOf(row, col) ? slotOf(row, col.key) : undefined}
                    typed={typed[row.device.id]?.[col.key]}
                    shared={isShared(row)}
                    canEdit={canEdit}
                    onTyped={(text) => setTypedValue(row.device.id, col.key, text)}
                    onDesign={(kind, text) => setDesignValue(row.device.id, col.key, kind, text)}
                  />
                ))}
                {anySecret && canEdit && (
                  <td className="px-1 py-1">
                    {!isShared(row) && row.declared.some((s) => s.scope === 'secret') && (
                      <select
                        className={cellCls}
                        value={setChoice[row.device.id] ?? row.view?.credentialSetId ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          setSetChoice((c) => {
                            const next = { ...c };
                            if (v === (row.view?.credentialSetId ?? '')) delete next[row.device.id];
                            else next[row.device.id] = v;
                            return next;
                          });
                        }}
                      >
                        <option value="">Own login</option>
                        {sets.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <button className={btnCls} disabled={!dirty || save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            className={ghostBtnCls}
            disabled={!dirty || save.isPending}
            onClick={() => {
              setTyped({});
              setSetChoice({});
            }}
          >
            Discard changes
          </button>
          {fillable.length > 0 && (
            <button
              className={ghostBtnCls}
              title="Type each driver’s usual value into the empty address cells that have one"
              onClick={() => fillable.forEach((f) => setTypedValue(f.deviceId, f.key, f.value))}
            >
              Fill usual values ({fillable.length})
            </button>
          )}
          {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
        </div>
      )}
    </div>
  );
}

function Cell({
  at,
  row,
  setting: s,
  slot,
  typed,
  shared,
  canEdit,
  onTyped,
  onDesign,
}: {
  at: string;
  row: Row;
  setting: DeclaredSetting | undefined;
  slot: DeviceBindingView['slots'][number] | undefined;
  typed: string | undefined;
  shared: boolean;
  canEdit: boolean;
  onTyped: (text: string | null) => void;
  onDesign: (kind: ReturnType<typeof fieldKind>, text: string) => void;
}) {
  // A driver that does not read this setting.
  if (!s) return <td className="bg-muted/40" />;
  const missing = (filled: boolean) => (s.required && !filled ? 'bg-warning/10' : '');

  if (s.scope === 'design') {
    const value = row.device.settings[s.key];
    const kind = fieldKind(s, value);
    return (
      <td className={`px-1 py-1 ${missing(value !== undefined && value !== '')}`}>
        {kind === 'json' ? (
          <span className="block truncate px-1 font-mono text-xs text-muted-foreground" title={JSON.stringify(value)}>
            {value === undefined ? 'Not set' : 'Edit on the Devices tab'}
          </span>
        ) : kind === 'boolean' ? (
          <input
            type="checkbox"
            data-cell={at}
            disabled={!canEdit}
            checked={value === true}
            onChange={(e) => onDesign('boolean', e.target.checked ? 'true' : 'false')}
          />
        ) : (
          <ValueInput
            kind={kind}
            value={value}
            dataCell={at}
            disabled={!canEdit}
            placeholder={s.default === undefined ? '' : String(s.default)}
            onChange={(v) => onDesign(kind, v === undefined ? '' : String(v))}
          />
        )}
      </td>
    );
  }

  if (shared)
    return (
      <td className="bg-muted/40 px-2 text-xs text-muted-foreground" title="Kept on the shared device, under Shared devices">
        Shared
      </td>
    );

  const secret = s.scope === 'secret';
  const filled = typed !== undefined ? typed !== '' : !!slot?.isSet;
  const clearable = canEdit && secret && slot?.isSet && !slot.fromCredentialSet && typed === undefined;
  return (
    <td className={`px-1 py-1 ${missing(filled)}`}>
      <div className="flex items-center gap-1">
        <input
          className={`${cellCls} min-w-0`}
          data-cell={at}
          type={secret ? 'password' : 'text'}
          autoComplete="off"
          disabled={!canEdit}
          placeholder={
            secret
              ? typed === ''
                ? 'Will be cleared'
                : slot?.isSet
                  ? slot.fromCredentialSet
                    ? 'Set by shared login'
                    : 'Set. Type to replace'
                  : 'Not set'
              : s.default !== undefined
                ? String(s.default)
                : ''
          }
          value={typed ?? (secret ? '' : String(slot?.value ?? ''))}
          onChange={(e) => {
            // Emptying a login someone has typed into puts it back as it was. Clearing is the ×.
            if (secret && e.target.value === '' && typed !== '') onTyped(null);
            else onTyped(e.target.value);
          }}
        />
        {clearable && (
          <button
            type="button"
            className="px-1 text-muted-foreground hover:text-destructive"
            title="Remove this login when you save"
            onClick={() => onTyped('')}
          >
            ×
          </button>
        )}
      </div>
    </td>
  );
}
