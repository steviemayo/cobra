'use client';
import { useState } from 'react';
import type { RoomModel } from '@kestrel/model';
import type { IssueRef, ValidationIssue } from '@kestrel/engine';

export const inputCls =
  'h-8 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50';
export const btnCls =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-all hover:bg-primary/85 active:translate-y-px disabled:pointer-events-none disabled:opacity-50';
export const ghostBtnCls =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium transition-all hover:bg-muted active:translate-y-px disabled:pointer-events-none disabled:opacity-50';
export const dangerBtnCls =
  'inline-flex h-7 items-center justify-center rounded-lg border border-destructive/40 px-2 text-xs font-medium text-destructive transition-all hover:bg-destructive/10 active:translate-y-px disabled:pointer-events-none disabled:opacity-50';

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
        hasError ? 'border-destructive/50' : issues.length ? 'border-warning/60' : 'border-border'
      } bg-card ${className}`}
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
        <li
          key={n}
          className={
            i.severity === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-300'
          }
        >
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
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
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
  if (!items.length) return <p className="text-xs text-muted-foreground">{empty}</p>;
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
