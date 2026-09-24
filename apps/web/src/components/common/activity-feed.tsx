'use client';
import { describeAudit } from '@/lib/audit-text';
import { timeAgo } from '@/lib/format';
import type { RouterOutputs } from '@/trpc/types';

export type AuditRow = RouterOutputs['audit']['list'][number];

export function ActivityFeed({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No activity yet.</p>;
  return (
    <ol className="space-y-3">
      {rows.map((r) => (
        <li key={r.id} className="flex gap-3 text-sm">
          <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-brand/70" />
          <div className="min-w-0">
            <p>
              <span className="font-medium">{r.actor}</span>{' '}
              <span className="text-muted-foreground">{describeAudit(r.action, r.meta)}</span>
            </p>
            <p className="text-xs text-muted-foreground">{timeAgo(r.createdAt)}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
