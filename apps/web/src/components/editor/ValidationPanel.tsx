'use client';
import type { IssueRef, ValidationResult } from '@kestrel/engine';

export type TabId =
  | 'graph'
  | 'devices'
  | 'connections'
  | 'groups'
  | 'states'
  | 'activities'
  | 'triggers'
  | 'settings';

export function tabForRef(ref: IssueRef): TabId {
  switch (ref.kind) {
    case 'device':
    case 'port':
      return 'devices';
    case 'connection':
      return 'connections';
    case 'group':
      return 'groups';
    case 'state':
      return 'states';
    case 'activity':
      return 'activities';
    case 'trigger':
      return 'triggers';
    case 'model':
      return 'graph';
  }
}

export function ValidationPanel({
  result,
  onSelect,
}: {
  result: ValidationResult;
  onSelect: (tab: TabId) => void;
}) {
  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');
  return (
    <aside className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Validation</h2>
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${
            result.valid ? 'bg-emerald-900 text-emerald-200' : 'bg-red-900 text-red-200'
          }`}
        >
          {result.valid ? 'Valid' : `${errors.length} error${errors.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {result.issues.length === 0 && <p className="text-xs text-slate-400">No problems found.</p>}
      <IssueGroup title="Errors" tone="text-red-300" issues={errors} onSelect={onSelect} />
      <IssueGroup title="Warnings" tone="text-amber-300" issues={warnings} onSelect={onSelect} />
    </aside>
  );
}

function IssueGroup({
  title,
  tone,
  issues,
  onSelect,
}: {
  title: string;
  tone: string;
  issues: ValidationResult['issues'];
  onSelect: (tab: TabId) => void;
}) {
  if (!issues.length) return null;
  return (
    <div className="space-y-1">
      <div className={`text-xs font-medium uppercase tracking-wide ${tone}`}>
        {title} ({issues.length})
      </div>
      <ul className="space-y-1">
        {issues.map((i, n) => (
          <li key={n}>
            <button
              className="w-full rounded px-1 py-0.5 text-left text-xs text-slate-200 hover:bg-slate-800"
              onClick={() => onSelect(tabForRef(i.ref))}
            >
              {i.message}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
