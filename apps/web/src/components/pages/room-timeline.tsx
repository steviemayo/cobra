'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { INCIDENT_KIND_LABEL } from '@/components/common/health';
import { PageContainer } from '@/components/common/page-header';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { clock, dayLabel, hhmm, zonedToUtc } from '@/lib/week';
import { useTRPC } from '@/trpc/client';

const DAY_MIN = 24 * 60;
const LABEL_W = '11rem';

/** Minutes from midnight on the zone's wall clock; anything outside the day is held to its edges. */
function minuteOf(iso: string, day: { start: string; end: string }, tz: string): number {
  const t = Date.parse(iso);
  if (t <= Date.parse(day.start)) return 0;
  if (t >= Date.parse(day.end)) return DAY_MIN;
  const c = clock(new Date(t), tz);
  return c.h * 60 + c.mi;
}

const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }) =>
  a.from < b.to && b.from < a.to;

const SEVERITY_LOOK: Record<string, string> = {
  critical: 'border-destructive/70 bg-destructive/70',
  warning: 'border-amber-500/70 bg-amber-500/70',
  info: 'border-sky-500/70 bg-sky-500/60',
};

/** The date a zone is on at an instant, as yyyy-mm-dd (what a date input holds). */
function ymd(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * One day of a room: its bookings across the top and a lane for each device below, with the times
 * each had a fault. Each booking is shaded down through every lane, so a fault in a meeting is
 * seen at a glance. Lanes with faults come first, nearest the bookings.
 */
export function RoomTimeline({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [at, setAt] = useState<string | undefined>(undefined);
  const q = useQuery(
    trpc.monitoring.timeline.queryOptions({ orgId, roomId, at }, { staleTime: 30_000 }),
  );
  const base = orgPath(orgId, `/rooms/${roomId}`);

  if (q.isPending)
    return (
      <PageContainer className="pt-5">
        <Skeleton className="h-96 w-full" />
      </PageContainer>
    );
  if (q.error || !q.data)
    return (
      <PageContainer className="pt-5">
        <p className="text-sm text-destructive">{q.error?.message ?? 'Couldn’t load.'}</p>
      </PageContainer>
    );

  const t = q.data;
  const tz = t.timezone;
  const day = { start: t.dayStart, end: t.dayEnd };
  const nowMs = Date.now();
  const isToday = Date.parse(t.dayStart) <= nowMs && nowMs < Date.parse(t.dayEnd);
  const move = (days: number) =>
    setAt(new Date(Date.parse(t.dayStart) + days * 86_400_000 + 12 * 3_600_000).toISOString());

  const meetings = t.meetings.map((m) => ({
    ...m,
    ...(() => {
      const from = minuteOf(m.start, day, tz);
      return { from, to: Math.max(minuteOf(m.end, day, tz), from + 10) };
    })(),
  }));
  const windows = t.windows.map((w) => {
    const from = minuteOf(w.start, day, tz);
    return { ...w, from, to: Math.max(minuteOf(w.end, day, tz), from + 10) };
  });
  const lanes = t.lanes.map((l) => ({
    ...l,
    incidents: l.incidents.map((i) => {
      // An open fault runs to now (or the end of a day that is over).
      const endIso = i.end ?? new Date(Math.min(nowMs, Date.parse(t.dayEnd))).toISOString();
      const from = minuteOf(i.start, day, tz);
      return { ...i, from, to: Math.max(minuteOf(endIso, day, tz), from + 5) };
    }),
  }));

  // Faults that ran while a booking was on.
  const during = lanes.flatMap((l) =>
    l.incidents.flatMap((i) =>
      meetings
        .filter((m) => overlaps(i, m))
        .map((m) => ({ lane: l.name, incident: i, meeting: m })),
    ),
  );
  const faultCount = lanes.reduce((n, l) => n + l.incidents.length, 0);

  // Working hours, widened to fit anything outside them.
  const spans = [...meetings, ...windows, ...lanes.flatMap((l) => l.incidents)];
  const first = Math.floor(Math.min(6 * 60, ...spans.map((s) => s.from)) / 60) * 60;
  const last = Math.ceil(Math.max(20 * 60, ...spans.map((s) => s.to)) / 60) * 60;
  const range = last - first;
  const pct = (min: number) => `${((Math.min(Math.max(min, first), last) - first) / range) * 100}%`;
  const width = (from: number, to: number) =>
    `${((Math.min(to, last) - Math.max(from, first)) / range) * 100}%`;
  const hours = Array.from({ length: (last - first) / 60 + 1 }, (_, i) => first / 60 + i);
  const nowMin = isToday ? ((c) => c.h * 60 + c.mi)(clock(new Date(nowMs), tz)) : null;

  const grid = (
    <>
      {hours.map((h) => (
        <div
          key={h}
          className="absolute inset-y-0 border-l border-border/50"
          style={{ left: pct(h * 60) }}
        />
      ))}
    </>
  );
  const row = 'grid items-center border-b last:border-b-0';
  const rowCols = { gridTemplateColumns: `${LABEL_W} 1fr` };

  return (
    <PageContainer className="space-y-3 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {dayLabel(t.dayStart, tz)}
          <span className="ml-2 font-normal text-muted-foreground">{tz}</span>
        </h2>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" aria-label="Previous day" onClick={() => move(-1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <Input
            type="date"
            aria-label="Day"
            className="h-8 w-40"
            value={ymd(new Date(Date.parse(t.dayStart) + 12 * 3_600_000), tz)}
            onChange={(e) => {
              const [y, m, d] = e.target.value.split('-').map(Number);
              if (y && m && d) setAt(zonedToUtc(y, m, d, 12, 0, tz).toISOString());
            }}
          />
          <Button variant="outline" size="sm" onClick={() => setAt(undefined)}>
            Today
          </Button>
          <Button variant="outline" size="icon" aria-label="Next day" onClick={() => move(1)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {t.problem && (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          {t.source === 'history'
            ? `Showing the bookings Kestrel kept, because the calendar couldn’t be read now (${t.problem}).`
            : `The calendar couldn’t be read (${t.problem}).`}
        </p>
      )}
      {!t.configured && t.source === 'none' && (
        <p className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          <CalendarDays className="size-4 shrink-0" />
          <span>
            No calendar for this room, so no bookings are shown.{' '}
            <Link href={`${base}/settings`} className="underline">
              Room settings
            </Link>
          </span>
        </p>
      )}

      <p className="text-sm text-muted-foreground">
        {faultCount === 0
          ? 'No faults on this day.'
          : `${faultCount} fault${faultCount === 1 ? '' : 's'}${
              during.length
                ? `, ${new Set(during.map((d) => d.incident.id)).size} during a booking.`
                : ', none during a booking.'
            }`}
      </p>

      <div className="overflow-x-auto rounded-lg border">
        <div className="min-w-[820px]">
          <div className={row} style={rowCols}>
            <div />
            <div className="relative h-6 text-[11px] text-muted-foreground">
              {hours.slice(0, -1).map((h) => (
                <span key={h} className="absolute top-1" style={{ left: pct(h * 60) }}>
                  <span className="pl-1">{String(h).padStart(2, '0')}:00</span>
                </span>
              ))}
            </div>
          </div>

          <div className="relative">
            {/* Each booking, shaded through every row beneath it. */}
            <div
              className="pointer-events-none absolute inset-y-0 right-0"
              style={{ left: LABEL_W }}
              aria-hidden
            >
              {meetings.map((m) => (
                <div
                  key={`band-${m.id}${m.start}`}
                  className="absolute inset-y-0 bg-primary/10"
                  style={{ left: pct(m.from), width: width(m.from, m.to) }}
                />
              ))}
              {nowMin !== null && nowMin >= first && nowMin <= last && (
                <div
                  className="absolute inset-y-0 z-10 border-l-2 border-destructive"
                  style={{ left: pct(nowMin) }}
                />
              )}
            </div>

            <div className={row} style={rowCols}>
              <div className="px-3 py-2 text-xs font-medium">Bookings</div>
              <div className="relative h-12">
                {grid}
                {meetings.map((m) => (
                  <div
                    key={`${m.id}${m.start}`}
                    title={`${m.busy ? 'Busy' : m.title || 'Meeting'}\n${hhmm(m.start, tz)}–${hhmm(m.end, tz)}${m.organiser ? `, ${m.organiser}` : ''}`}
                    className={`absolute inset-y-1 overflow-hidden rounded border px-1 py-0.5 text-[11px] leading-tight ${
                      m.busy
                        ? 'border-border bg-muted text-muted-foreground'
                        : 'border-primary/40 bg-primary/20'
                    }`}
                    style={{ left: pct(m.from), width: width(m.from, m.to) }}
                  >
                    <div className="truncate font-medium">
                      {m.busy ? 'Busy' : m.title || 'Meeting'}
                    </div>
                    <div className="truncate opacity-80">
                      {hhmm(m.start, tz)}–{hhmm(m.end, tz)}
                    </div>
                  </div>
                ))}
                {meetings.length === 0 && (
                  <span className="absolute inset-y-0 left-2 flex items-center text-xs text-muted-foreground">
                    No bookings known for this day
                  </span>
                )}
              </div>
            </div>

            {windows.length > 0 && (
              <div className={row} style={rowCols}>
                <div className="px-3 py-1 text-xs font-medium">Maintenance</div>
                <div className="relative h-7">
                  {grid}
                  {windows.map((w, i) => (
                    <div
                      key={`${w.id}${i}`}
                      title={`${w.name}\n${hhmm(w.start, tz)}–${hhmm(w.end, tz)}`}
                      className="absolute inset-y-1 truncate rounded border border-amber-500/60 bg-amber-500/15 px-1 text-[11px] text-amber-900 dark:text-amber-200"
                      style={{ left: pct(w.from), width: width(w.from, w.to) }}
                    >
                      {w.name}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {lanes.length === 0 && (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                No monitored devices in this room.
              </p>
            )}
            {lanes.map((l) => (
              <div key={`${l.kind}-${l.deviceId ?? l.name}`} className={row} style={rowCols}>
                <div
                  className={`truncate px-3 py-1.5 text-xs ${l.incidents.length ? 'font-medium' : 'text-muted-foreground'}`}
                  title={l.name}
                >
                  {l.name}
                  {l.category && (
                    <span className="ml-1 text-[10px] text-muted-foreground">{l.category}</span>
                  )}
                </div>
                <div className="relative h-8">
                  {grid}
                  {l.incidents.map((i) => {
                    const hit = meetings.some((m) => overlaps(i, m));
                    return (
                      <div
                        key={i.id}
                        title={`${INCIDENT_KIND_LABEL[i.kind] ?? i.kind}: ${i.title}\n${hhmm(i.start, tz)}–${i.end ? hhmm(i.end, tz) : 'still open'}${hit ? '\nDuring a booking' : ''}`}
                        className={`absolute inset-y-1.5 rounded-sm border ${SEVERITY_LOOK[i.severity] ?? SEVERITY_LOOK.warning} ${
                          hit ? 'ring-2 ring-foreground/70' : ''
                        } ${i.end ? '' : 'border-r-0 [mask-image:linear-gradient(to_right,black_80%,transparent)]'}`}
                        style={{ left: pct(i.from), width: width(i.from, i.to), minWidth: 4 }}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {during.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-sm font-medium">Faults during bookings</h3>
          <ul className="space-y-1 text-sm">
            {during.map((d) => (
              <li key={`${d.incident.id}${d.meeting.id}${d.meeting.start}`}>
                <span className="font-medium">{d.lane}</span>:{' '}
                {INCIDENT_KIND_LABEL[d.incident.kind] ?? d.incident.kind}{' '}
                {hhmm(d.incident.start, tz)}–
                {d.incident.end ? hhmm(d.incident.end, tz) : 'still open'}
                <span className="text-muted-foreground">
                  {' '}
                  during{' '}
                  {d.meeting.busy ? 'a private booking' : `“${d.meeting.title || 'Meeting'}”`}{' '}
                  {hhmm(d.meeting.start, tz)}–{hhmm(d.meeting.end, tz)}
                  {d.meeting.organiser ? `, ${d.meeting.organiser}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span>
          <span className="mr-1 inline-block size-2.5 rounded-sm border border-primary/40 bg-primary/20" />
          Booking
        </span>
        <span>
          <span className="mr-1 inline-block size-2.5 rounded-sm border border-destructive/70 bg-destructive/70" />
          Critical
        </span>
        <span>
          <span className="mr-1 inline-block size-2.5 rounded-sm border border-amber-500/70 bg-amber-500/70" />
          Warning
        </span>
        <span>
          <span className="mr-1 inline-block size-2.5 rounded-sm ring-2 ring-foreground/70" />
          During a booking
        </span>
        <span>Read only. Kestrel never changes your calendar.</span>
      </p>
    </PageContainer>
  );
}
