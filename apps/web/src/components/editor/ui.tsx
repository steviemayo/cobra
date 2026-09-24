'use client';
import { useState } from 'react';
import type { RoomModel } from '@kestrel/model';
import type { IssueRef, ValidationIssue } from '@kestrel/engine';

export const inputCls =
  'rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100 placeholder:text-slate-500 disabled:opacity-50';
export const btnCls =
  'rounded bg-sky-600 px-3 py-1.5 text-sm font-medium hover:bg-sky-500 disabled:opacity-50';
export const ghostBtnCls =
  'rounded border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50';
export const dangerBtnCls =
  'rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950 disabled:opacity-50';

export interface PanelProps {
  model: RoomModel;
  update: (fn: (m: RoomModel) => void) => void;
  issues: ValidationIssue[];
}

export function Card({
  children,
  issues = [],
  className = '',
}: {
  children: React.ReactNode;
  issues?: ValidationIssue[];
  className?: string;
}) {
  const hasError = issues.some((i) => i.severity === 'error');
  return (
    <div
      className={`space-y-3 rounded-lg border p-3 ${
        hasError ? 'border-red-800' : issues.length ? 'border-amber-800' : 'border-slate-800'
      } bg-slate-900/40 ${className}`}
    >
      {children}
      <IssueLines issues={issues} />
    </div>
  );
}

export function IssueLines({ issues }: { issues: ValidationIssue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="space-y-0.5 text-xs">
      {issues.map((i, n) => (
        <li key={n} className={i.severity === 'error' ? 'text-red-300' : 'text-amber-300'}>
          {i.severity === 'error' ? 'Error: ' : 'Warning: '}
          {i.message}
        </li>
      ))}
    </ul>
  );
}

export function refMatches(ref: IssueRef, kind: IssueRef['kind'], id: string): boolean {
  if (ref.kind !== kind) return false;
  return 'id' in ref ? ref.id === id : false;
}

export function issuesFor(issues: ValidationIssue[], kind: IssueRef['kind'], id: string) {
  return issues.filter((i) => refMatches(i.ref, kind, id));
}

/** Issues on a device or on any of its ports. */
export function issuesForDevice(issues: ValidationIssue[], id: string) {
  return issues.filter(
    (i) => refMatches(i.ref, 'device', id) || (i.ref.kind === 'port' && i.ref.parentId === id),
  );
}

export function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-slate-400">
      {text}
      {children}
    </label>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  className = '',
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <select
      className={`${inputCls} ${className}`}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function TextInput({
  value,
  onChange,
  ...rest
}: { value: string; onChange: (v: string) => void } & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange'
>) {
  return (
    <input
      {...rest}
      className={`${inputCls} ${rest.className ?? ''}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function ConfirmButton({
  label,
  confirmLabel = 'Confirm',
  onConfirm,
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  return armed ? (
    <span className="flex gap-1">
      <button className={dangerBtnCls} onClick={onConfirm}>
        {confirmLabel}
      </button>
      <button className={ghostBtnCls + ' !px-2 !py-1 text-xs'} onClick={() => setArmed(false)}>
        Cancel
      </button>
    </span>
  ) : (
    <button className={dangerBtnCls} onClick={() => setArmed(true)}>
      {label}
    </button>
  );
}

export function CheckList({
  items,
  selected,
  onToggle,
  empty,
}: {
  items: { id: string; label: string }[];
  selected: string[];
  onToggle: (id: string, on: boolean) => void;
  empty: string;
}) {
  if (!items.length) return <p className="text-xs text-slate-500">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {items.map((it) => (
        <label key={it.id} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={selected.includes(it.id)}
            onChange={(e) => onToggle(it.id, e.target.checked)}
          />
          {it.label}
        </label>
      ))}
    </div>
  );
}

export function deviceOptions(model: RoomModel, devices = model.devices) {
  return devices.map((d) => ({ value: d.id, label: d.name }));
}
