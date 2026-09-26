'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  checkGrid,
  readGrid,
  roomName,
  stepAddress,
  toCsv,
  MAX_BULK_ROWS,
  type BulkColumn,
  type BulkRow,
} from '@kestrel/model';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/trpc/client';

const NONE = 'none';

// Create many rooms from one template: a sheet with a row per room and a column per address. A row
// whose name matches a room already at the site updates that room's addresses instead.
export function BulkRoomsView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const { orgId, canEdit } = useOrg();
  const templates = useQuery(trpc.template.list.queryOptions({ orgId }));
  const sites = useQuery(trpc.site.list.queryOptions({ orgId }));
  const gateways = useQuery(trpc.gateway.list.queryOptions({ orgId }));
  const sets = useQuery({ ...trpc.binding.credentialSets.list.queryOptions({ orgId }), enabled: canEdit });

  const [templateId, setTemplateId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [gatewayId, setGatewayId] = useState(NONE);
  const [rows, setRows] = useState<BulkRow[]>([]);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [pattern, setPattern] = useState('Room {n}');
  const [count, setCount] = useState('10');
  const [paste, setPaste] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const [fill, setFill] = useState<{ column: string; start: string; step: string }>({ column: '', start: '', step: '1' });

  const spec = useQuery({
    ...trpc.bulk.columns.queryOptions({ orgId, templateId }),
    enabled: !!templateId,
  });
  const columns: BulkColumn[] = spec.data?.columns ?? [];
  const logins = spec.data?.logins ?? [];
  const issues = useMemo(() => checkGrid(rows, columns), [rows, columns]);

  const input = () => ({
    orgId,
    templateId,
    siteId,
    gatewayId: gatewayId === NONE ? null : gatewayId,
    rows,
    credentialSets: Object.fromEntries(Object.entries(creds).filter(([, v]) => v)),
  });
  const preview = useMutation(trpc.bulk.preview.mutationOptions({ onError: (e) => toast.error(e.message) }));
  const apply = useMutation(
    trpc.bulk.apply.mutationOptions({
      onSuccess: async (r) => {
        toast.success(`${r.created.length} created, ${r.updated.length} updated`);
        await qc.invalidateQueries({ queryKey: trpc.room.overview.queryKey() });
        await qc.invalidateQueries({ queryKey: trpc.room.list.queryKey() });
        router.push(orgPath(orgId, '/rooms'));
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const edit = (fn: (r: BulkRow[]) => BulkRow[]) => {
    setRows(fn);
    preview.reset();
  };

  const addRows = () => {
    const n = Math.min(Math.max(Number(count) || 0, 0), MAX_BULK_ROWS - rows.length);
    edit((r) => [...r, ...Array.from({ length: n }, (_, i) => ({ name: roomName(pattern, r.length + i + 1), values: {} }))]);
  };
  const fillDown = () => {
    const col = columns.find((c) => c.id === fill.column);
    if (!col || !fill.start.trim()) return;
    const step = Number(fill.step) || 1;
    const out = rows.map((_, i) => stepAddress(fill.start, step, i));
    if (out.includes(null)) return toast.error('That start value cannot be counted up that far. Use an address ending in a number');
    edit((r) => r.map((row, i) => ({ ...row, values: { ...row.values, [col.id]: out[i]! } })));
  };
  const importText = (text: string, replace: boolean) => {
    const read = readGrid(text, columns);
    setNotes(read.problems);
    if (read.rows.length > 0) edit((r) => (replace ? read.rows : [...r, ...read.rows]).slice(0, MAX_BULK_ROWS + 1));
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([toCsv(columns, rows)], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'rooms.csv' });
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!canEdit)
    return (
      <PageContainer>
        <PageHeader title="Create rooms from a template" description="Only owners and developers can create rooms." />
      </PageContainer>
    );

  const templateOptions = [
    ...(templates.data?.starters ?? []).map((t) => ({ value: t.id, label: `${t.name} (starter)` })),
    ...(templates.data?.org ?? []).map((t) => ({ value: t.id, label: t.name })),
  ];
  const siteGateways = (gateways.data ?? []).filter((g) => g.siteId === siteId);
  const errors = issues.filter((i) => i.level === 'error').length;
  const plan = preview.data;
  const ready = !!templateId && !!siteId && rows.length > 0 && errors === 0;

  return (
    <PageContainer wide>
      <PageHeader
        title="Create rooms from a template"
        description="One row per room, one column per address. Addresses are kept apart from the design, so every room starts from the same template. A row with the name of a room already at the site updates that room’s addresses instead."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <SimpleSelect
          value={templateId}
          onValueChange={(v) => {
            setTemplateId(v);
            setRows([]);
            setCreds({});
            preview.reset();
          }}
          options={templateOptions}
          placeholder="Template"
        />
        <SimpleSelect
          value={siteId}
          onValueChange={(v) => {
            setSiteId(v);
            setGatewayId(NONE);
            preview.reset();
          }}
          options={(sites.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
          placeholder="Site"
        />
        <SimpleSelect
          value={gatewayId}
          onValueChange={(v) => {
            setGatewayId(v);
            preview.reset();
          }}
          options={[{ value: NONE, label: 'No gateway yet' }, ...siteGateways.map((g) => ({ value: g.id, label: g.name }))]}
          placeholder="Gateway"
          disabled={!siteId}
        />
      </div>

      {!templateId ? null : spec.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card p-3 text-sm">
            <Input className="w-40" value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label="Name pattern" />
            <Input className="w-20" type="number" min={1} max={MAX_BULK_ROWS} value={count} onChange={(e) => setCount(e.target.value)} aria-label="How many" />
            <Button size="sm" variant="outline" onClick={addRows} disabled={rows.length >= MAX_BULK_ROWS}>
              <Plus data-icon="inline-start" /> Add rows
            </Button>
            <span className="text-xs text-muted-foreground">Use {'{n}'} for the number, {'{nn}'} for two digits</span>
            {columns.length > 0 && (
              <div className="ml-auto flex flex-wrap items-end gap-2">
                <SimpleSelect
                  value={fill.column}
                  onValueChange={(v) => setFill((f) => ({ ...f, column: v }))}
                  options={columns.map((c) => ({ value: c.id, label: c.header }))}
                  placeholder="Fill a column"
                />
                <Input className="w-32" placeholder="Start, e.g. 10.0.4.20" value={fill.start} onChange={(e) => setFill((f) => ({ ...f, start: e.target.value }))} />
                <Input className="w-16" type="number" value={fill.step} onChange={(e) => setFill((f) => ({ ...f, step: e.target.value }))} aria-label="Step" />
                <Button size="sm" variant="outline" onClick={fillDown} disabled={!fill.column || rows.length === 0}>
                  Fill down
                </Button>
              </div>
            )}
          </div>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-8 px-2 py-2">#</th>
                  <th className="px-2 py-2">Room name</th>
                  {columns.map((c) => (
                    <th key={c.id} className="px-2 py-2">
                      {c.header}
                      {c.required && ' *'}
                    </th>
                  ))}
                  <th className="px-2 py-2">{plan ? 'Result' : ''}</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={columns.length + 4} className="px-3 py-6 text-center text-muted-foreground">
                      Add rows above, or paste from a spreadsheet below.
                    </td>
                  </tr>
                )}
                {rows.map((r, i) => {
                  const own = issues.filter((x) => x.row === i);
                  const step = plan?.rows[i];
                  return (
                    <tr key={i} className="border-t border-border align-top">
                      <td className="px-2 py-1.5 text-muted-foreground">{i + 1}</td>
                      <td className="px-1 py-1">
                        <Input
                          value={r.name}
                          aria-invalid={own.some((x) => x.level === 'error' && !x.columnId)}
                          onChange={(e) => edit((all) => all.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)))}
                        />
                      </td>
                      {columns.map((c) => (
                        <td key={c.id} className="px-1 py-1">
                          <Input
                            value={r.values[c.id] ?? ''}
                            aria-invalid={own.some((x) => x.level === 'error' && x.columnId === c.id)}
                            title={own.filter((x) => x.columnId === c.id).map((x) => x.message).join('. ')}
                            className={own.some((x) => x.level === 'warning' && x.columnId === c.id) ? 'border-warning/60' : ''}
                            onChange={(e) =>
                              edit((all) => all.map((x, n) => (n === i ? { ...x, values: { ...x.values, [c.id]: e.target.value } } : x)))
                            }
                          />
                        </td>
                      ))}
                      <td className="px-2 py-1.5 text-xs">
                        {step && (
                          <span className={step.action === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
                            {{ create: 'New room', update: 'Update', unchanged: 'No change', error: 'Fix' }[step.action]}
                          </span>
                        )}
                        {[...own, ...(step?.issues ?? []).filter((x) => !own.includes(x))].map((x, n) => (
                          <div key={n} className={x.level === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-300'}>
                            {x.message}
                          </div>
                        ))}
                      </td>
                      <td className="px-1 py-1">
                        <Button size="sm" variant="ghost" aria-label={`Remove row ${i + 1}`} onClick={() => edit((all) => all.filter((_, n) => n !== i))}>
                          <Trash2 />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {logins.length > 0 && (
            <div className="space-y-2 rounded-lg border border-border bg-card p-3">
              <div className="text-sm font-medium">Shared logins</div>
              <p className="text-xs text-muted-foreground">
                Logins are never typed into the sheet. Pick a shared login for each device that needs one, or leave it and fill it in per room later.
              </p>
              {logins.map((l) => (
                <div key={l.deviceId} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="w-48">
                    {l.deviceName} <span className="text-xs text-muted-foreground">({l.labels.join(', ')})</span>
                  </span>
                  <SimpleSelect
                    value={creds[l.deviceId] ?? ''}
                    onValueChange={(v) => {
                      setCreds((c) => ({ ...c, [l.deviceId]: v === NONE ? '' : v }));
                      preview.reset();
                    }}
                    options={[{ value: NONE, label: 'None' }, ...(sets.data ?? []).map((s) => ({ value: s.id, label: s.name }))]}
                    placeholder="Choose a shared login"
                  />
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2 rounded-lg border border-border bg-card p-3">
            <div className="text-sm font-medium">From a spreadsheet</div>
            <textarea
              className="h-24 w-full rounded-lg border border-input bg-background p-2 font-mono text-xs"
              placeholder="Paste cells copied from a spreadsheet. A header row is matched by name; without one the columns are read in the order shown above."
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={!paste.trim()} onClick={() => importText(paste, true)}>
                Replace rows
              </Button>
              <Button size="sm" variant="outline" disabled={!paste.trim()} onClick={() => importText(paste, false)}>
                Add rows
              </Button>
              <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[0.8rem] font-medium hover:bg-muted">
                <Upload className="size-3.5" /> Import CSV
                <input
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  className="sr-only"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) importText(await file.text(), true);
                  }}
                />
              </label>
              <Button size="sm" variant="ghost" onClick={download}>
                <Download data-icon="inline-start" /> {rows.length ? 'Download CSV' : 'Blank CSV'}
              </Button>
            </div>
            {notes.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-300">
                {notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </div>

          {plan?.problems.map((p) => (
            <p key={p} className="text-sm text-destructive">
              {p}
            </p>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={!ready || preview.isPending} onClick={() => preview.mutate(input())}>
              {preview.isPending ? 'Checking…' : 'Check'}
            </Button>
            <Button disabled={!ready || apply.isPending} onClick={() => apply.mutate(input())}>
              {apply.isPending ? 'Saving…' : plan ? `Create ${plan.creates}, update ${plan.updates}` : `Create ${rows.length} room${rows.length === 1 ? '' : 's'}`}
            </Button>
            <span className="text-xs text-muted-foreground">
              {errors > 0 ? `${errors} problem${errors === 1 ? '' : 's'} to fix first. ` : ''}
              A room with an empty address is created as “Needs setup” and can’t be deployed until it is filled in.
            </span>
          </div>
        </>
      )}
    </PageContainer>
  );
}
