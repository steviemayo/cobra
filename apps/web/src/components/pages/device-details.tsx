'use client';
import { useState } from 'react';
import type { DetailStatus, DeviceDetailSection } from '@kestrel/model';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

const TONE: Record<DetailStatus, string> = {
  ok: 'bg-success',
  warning: 'bg-warning',
  bad: 'bg-destructive',
};

function StatusMark({ status }: { status?: DetailStatus }) {
  if (!status) return null;
  return (
    <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', TONE[status])} />
  );
}

const COLLAPSED_ROWS = 8;

function DetailTable({ table }: { table: NonNullable<DeviceDetailSection['table']> }) {
  const [all, setAll] = useState(false);
  const rows = all ? table.rows : table.rows.slice(0, COLLAPSED_ROWS);
  return (
    <div className="space-y-1.5">
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-6" />
              {table.columns.map((c) => (
                <TableHead key={c} className="h-8 text-xs">
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                <TableCell className="w-6 py-1.5">
                  <StatusMark status={r.status} />
                </TableCell>
                {table.columns.map((c, j) => (
                  <TableCell key={c} className="py-1.5 text-xs tabular-nums">
                    {r.cells[j] ?? ''}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {table.rows.length > COLLAPSED_ROWS && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {all ? 'Show fewer' : `Show all ${table.rows.length}`}
        </button>
      )}
    </div>
  );
}

/** What a device says about itself, as its driver laid it out: titled sections of facts and tables. */
export function DeviceDetailsView({ details }: { details: DeviceDetailSection[] }) {
  return (
    <div className="grid gap-3 pt-2 pl-6 md:grid-cols-2">
      {details.map((s) => (
        <section
          key={s.title}
          className={cn('space-y-2 rounded-md border p-3', s.table && 'md:col-span-2')}
        >
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {s.title}
          </h3>
          {s.rows.length > 0 && (
            <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              {s.rows.map((r) => (
                <div key={r.label} className="contents">
                  <dt className="text-muted-foreground">{r.label}</dt>
                  <dd className="flex min-w-0 items-center gap-2 break-words">
                    <StatusMark status={r.status} />
                    <span className="min-w-0 select-text">{r.value}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {s.table && <DetailTable table={s.table} />}
        </section>
      ))}
    </div>
  );
}
