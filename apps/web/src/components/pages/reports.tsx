'use client';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Mail, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer, PageHeader } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { percent, plural } from '@/lib/format';
import { useTRPC } from '@/trpc/client';

const duration = (m: number) => (m >= 120 ? `${Math.round((m / 60) * 10) / 10} h` : `${Math.round(m)} min`);
const KIND: Record<string, string> = {
  device_offline: 'Device stopped answering',
  gateway_offline: 'Gateway went quiet',
  room_fault: 'Room fault',
  deploy_failed: 'Deployment failed',
  point_alert: 'Watched value out of bounds',
};
const date = (iso: string, tz: string) =>
  new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz });

/** The last four months, this one first. */
function monthOptions(tz: string) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric' }).formatToParts(now);
  let y = Number(parts.find((p) => p.type === 'year')!.value);
  let m = Number(parts.find((p) => p.type === 'month')!.value);
  return Array.from({ length: 4 }, () => {
    const value = `${y}-${m}`;
    const label = new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    if (--m === 0) {
      m = 12;
      y--;
    }
    return { value, label };
  });
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-sm text-muted-foreground">{label}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="break-inside-avoid overflow-hidden rounded-lg border">
      <div className="border-b bg-muted/40 px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
      </div>
      {children}
    </section>
  );
}

/** Owners choose who gets the report by email each month. */
function ScheduleCard() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const schedule = useQuery(trpc.report.schedule.queryOptions({ orgId }));
  const [draft, setDraft] = useState<{ enabled: boolean; recipients: string } | null>(null);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const save = useMutation(
    trpc.report.setSchedule.mutationOptions({
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: trpc.report.schedule.queryKey() });
        setDraft(null);
        toast.success('Monthly report settings saved');
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const s = schedule.data;
  if (!s) return schedule.isPending ? <Skeleton className="h-24 w-full" /> : null;
  const enabled = draft?.enabled ?? s.enabled;
  const recipients = draft?.recipients ?? s.recipients.join(', ');
  return (
    <section className="space-y-3 rounded-lg border p-4 print:hidden">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Email this report every month</h2>
          <p className="text-sm text-muted-foreground">
            Sent in the first days of each month, for the month that just ended.
            {s.lastSentMonth && ` Last sent for ${s.lastSentMonth}.`}
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={(on) => setDraft({ enabled: on, recipients })} aria-label="Send monthly report" />
      </div>
      {!s.emailReady && (
        <p className="rounded-md bg-warning/10 px-3 py-2 text-sm">Email is not set up on this Kestrel server yet, so nothing will be sent.</p>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="report-to">Who gets it (separate addresses with commas)</Label>
        <Input id="report-to" value={recipients} onChange={(e) => setDraft({ enabled, recipients: e.target.value })} placeholder="manager@example.com, it@example.com" />
      </div>
      <Button
        size="sm"
        disabled={!draft || save.isPending}
        onClick={() =>
          save.mutate({
            orgId,
            enabled,
            recipients: recipients.split(/[,;\s]+/).filter(Boolean),
            timezone: s.timezone === 'UTC' ? tz : s.timezone,
          })
        }
      >
        Save
      </Button>
    </section>
  );
}

/** A month's usage, reliability and support in one page that prints or saves as a PDF. */
export function ReportsView() {
  const trpc = useTRPC();
  const { orgId, isOwner, role } = useOrg();
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const options = useMemo(() => monthOptions(tz), [tz]);
  const [choice, setChoice] = useState(options[1]?.value ?? options[0]!.value);
  const [year, month] = choice.split('-').map(Number) as [number, number];
  const report = useQuery({ ...trpc.report.monthly.queryOptions({ orgId, year, month, tz }), staleTime: 60_000 });
  const send = useMutation(
    trpc.report.emailMe.mutationOptions({
      onSuccess: (r) => toast.success(`Sent to ${r.sentTo}`),
      onError: (e) => toast.error(e.message),
    }),
  );
  const canEmail = role === 'owner' || role === 'dev' || role === 'support';
  const r = report.data;
  const s = r?.summary;

  return (
    <PageContainer>
      {/* Print only the report: hide the app's navigation. */}
      <style>{`@media print { [data-slot="sidebar-wrapper"] > [data-slot="sidebar"], [data-slot="sidebar-gap"], [data-slot="sidebar-container"], header.sticky { display: none !important; } }`}</style>
      <PageHeader
        title={r ? `${r.label} report` : 'Monthly report'}
        description={r ? `${r.orgName}. Use, reliability and support for the month.` : 'Use, reliability and support for a month.'}
        actions={
          <div className="flex items-center gap-2 print:hidden">
            <SimpleSelect size="sm" value={choice} onValueChange={setChoice} options={options} />
            <Button size="sm" variant="outline" onClick={() => window.print()}>
              <Printer /> Print or save as PDF
            </Button>
            {canEmail && (
              <Button size="sm" variant="outline" disabled={send.isPending} onClick={() => send.mutate({ orgId, year, month, tz })}>
                <Mail /> Email me a copy
              </Button>
            )}
          </div>
        }
      />

      {report.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : report.isError ? (
        <p className="text-sm text-destructive">{report.error.message}</p>
      ) : !r || !s ? null : s.rooms === 0 ? (
        <EmptyState icon={FileText} title="No rooms yet" description="A report needs rooms that have been deployed and used." />
      ) : (
        <>
          {r.beyondRetention && (
            <p className="rounded-md bg-warning/10 px-3 py-2 text-sm">
              Part of this month is older than the history Kestrel keeps (90 days), so the figures may be low.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Hours in use" value={String(s.hoursInUse)} hint={`${plural(s.sessions, 'session')} in ${plural(s.rooms, 'room')}`} />
            <Stat label="Business hours in use" value={percent(s.avgUtilisation)} hint="average per room" />
            <Stat label="Time out of service" value={duration(s.downtimeMinutes)} hint={`${plural(s.incidentsOpened, 'problem')} came up`} />
            <Stat
              label="Support requests"
              value={String(s.ticketsOpened)}
              hint={`${s.ticketsClosed} closed, ${s.ticketsOpenNow} still open`}
            />
          </div>

          {r.usage.insights.length > 0 && (
            <Section title="Worth a look">
              <ul className="divide-y">
                {r.usage.insights.map((i) => (
                  <li key={`${i.kind}-${i.roomId}`} className="px-4 py-2.5 text-sm">
                    {i.text}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Use, room by room">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Room</TableHead>
                  <TableHead className="text-right">Business hours in use</TableHead>
                  <TableHead className="text-right">Hours in use</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.usage.rooms.map((x) => (
                  <TableRow key={x.roomId}>
                    <TableCell className="font-medium">{x.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{percent(x.utilisation)}</TableCell>
                    <TableCell className="text-right tabular-nums">{Math.round(x.inUseMinutes / 6) / 10}</TableCell>
                    <TableCell className="text-right tabular-nums">{x.sessions}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>

          <Section title="Reliability">
            <div className="space-y-3 px-4 py-3 text-sm">
              <p>
                {plural(s.incidentsOpened, 'problem')} came up and {s.incidentsResolved} {s.incidentsResolved === 1 ? 'was' : 'were'} resolved
                {s.avgResolveMinutes !== null && `, taking ${duration(s.avgResolveMinutes)} on average`}.
              </p>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Room</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                  <TableHead className="text-right">Time out</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.availability.map((a) => (
                  <TableRow key={a.roomId}>
                    <TableCell className="font-medium">{a.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{percent(a.availability, 2)}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.downtimeMinutes > 0 ? duration(a.downtimeMinutes) : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>

          {r.incidents.length > 0 && (
            <Section title="Problems this month">
              <ul className="divide-y">
                {r.incidents.map((i, n) => (
                  <li key={`${i.openedAt}-${n}`} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5 text-sm">
                    <span>
                      <span className="font-medium">{i.title}</span>
                      <span className="text-muted-foreground">
                        {' '}
                        · {KIND[i.kind] ?? i.kind}
                        {i.room ? ` · ${i.room}` : ''}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {date(i.openedAt, r.tz)} · {i.resolvedAt ? `out ${duration(i.minutes)}` : 'still open'}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <p className="text-xs text-muted-foreground">
            Times are in {r.tz}. Business hours are Monday to Friday, 8am to 6pm. Generated {date(r.generatedAt, r.tz)}.
          </p>
          {isOwner && <ScheduleCard />}
        </>
      )}
    </PageContainer>
  );
}
