'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/common/empty-state';
import { PageContainer } from '@/components/common/page-header';
import { SimpleSelect } from '@/components/common/simple-select';
import { orgPath, useOrg } from '@/components/shell/org-context';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { clock, dayLabel, hhmm } from '@/lib/week';
import { useTRPC } from '@/trpc/client';

const HOUR_PX = 44;
const DAY_MIN = 24 * 60;

interface Block {
  key: string;
  kind: 'meeting' | 'busy' | 'maintenance';
  label: string;
  detail: string;
  from: number;
  to: number;
}

/** Minutes from midnight on the wall clock, with an end past the day's edge drawn to its bottom. */
function minutesIn(start: string, end: string, day: { start: string; end: string }, tz: string) {
  const s = Date.parse(start) <= Date.parse(day.start) ? 0 : clock(new Date(start), tz);
  const e = Date.parse(end) >= Date.parse(day.end) ? DAY_MIN : clock(new Date(end), tz);
  const toMin = (x: number | { h: number; mi: number }) =>
    typeof x === 'number' ? x : x.h * 60 + x.mi;
  return { from: toMin(s), to: Math.max(toMin(e), toMin(s) + 15) };
}

/** A room's week, Monday to Sunday, with booked times and maintenance blocked out. */
export function RoomCalendar({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const { orgId } = useOrg();
  const [at, setAt] = useState<string | undefined>(undefined);
  const week = useQuery(
    trpc.calendar.week.queryOptions({ orgId, roomId, at }, { staleTime: 60_000 }),
  );
  const base = orgPath(orgId, `/rooms/${roomId}`);

  if (week.isPending)
    return (
      <PageContainer className="pt-5">
        <Skeleton className="h-96 w-full" />
      </PageContainer>
    );
  if (week.error || !week.data)
    return (
      <PageContainer className="pt-5">
        <p className="text-sm text-destructive">{week.error?.message ?? 'Couldn’t load.'}</p>
      </PageContainer>
    );
  const w = week.data;
  if (!w.configured)
    return (
      <PageContainer className="pt-5">
        <EmptyState
          icon={CalendarDays}
          title="No calendar for this room yet"
          description="Choose a calendar profile and enter the room’s calendar address in the room’s settings. Profiles are added under Settings > Calendars."
          action={
            <Link href={`${base}/settings`} className={buttonVariants({ variant: 'outline' })}>
              Room settings
            </Link>
          }
        />
      </PageContainer>
    );

  const move = (days: number) =>
    setAt(new Date(Date.parse(w.weekStart) + days * 86_400_000 + 12 * 3_600_000).toISOString());

  const perDay = w.days.map((day) => {
    const blocks: Block[] = [];
    for (const m of w.meetings) {
      if (Date.parse(m.end) <= Date.parse(day.start) || Date.parse(m.start) >= Date.parse(day.end))
        continue;
      blocks.push({
        key: `m${m.id}`,
        kind: m.busy ? 'busy' : 'meeting',
        label: m.busy ? 'Busy' : m.title || 'Meeting',
        detail: `${hhmm(m.start, w.timezone)}–${hhmm(m.end, w.timezone)}${m.organiser ? `, ${m.organiser}` : ''}`,
        ...minutesIn(m.start, m.end, day, w.timezone),
      });
    }
    w.windows.forEach((x, i) => {
      if (Date.parse(x.end) <= Date.parse(day.start) || Date.parse(x.start) >= Date.parse(day.end))
        return;
      blocks.push({
        key: `w${x.id}${i}`,
        kind: 'maintenance',
        label: `Maintenance: ${x.name}`,
        detail: `${hhmm(x.start, w.timezone)}–${hhmm(x.end, w.timezone)}`,
        ...minutesIn(x.start, x.end, day, w.timezone),
      });
    });
    return blocks;
  });

  // Show working hours, widened to fit anything outside them.
  const all = perDay.flat();
  const first = Math.min(7 * 60, ...all.map((b) => b.from));
  const last = Math.max(19 * 60, ...all.map((b) => b.to));
  const startH = Math.floor(first / 60);
  const endH = Math.ceil(last / 60);
  const hours = Array.from({ length: endH - startH }, (_, i) => startH + i);
  const nowMs = Date.now();

  return (
    <PageContainer className="space-y-3 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {dayLabel(w.days[0]!.start, w.timezone)} – {dayLabel(w.days[6]!.start, w.timezone)}
          <span className="ml-2 font-normal text-muted-foreground">{w.timezone}</span>
        </h2>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" aria-label="Previous week" onClick={() => move(-7)}>
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAt(undefined)}>
            This week
          </Button>
          <Button variant="outline" size="icon" aria-label="Next week" onClick={() => move(7)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {w.problem && (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          {w.source === 'copy'
            ? `Showing Kestrel’s last saved copy, because the calendar couldn’t be read now (${w.problem}).`
            : `The calendar couldn’t be read (${w.problem}).`}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <div className="min-w-[760px]">
          <div className="grid grid-cols-[3.5rem_repeat(7,1fr)] border-b text-xs">
            <div />
            {w.days.map((d) => {
              const today = Date.parse(d.start) <= nowMs && nowMs < Date.parse(d.end);
              return (
                <div
                  key={d.start}
                  className={`border-l px-2 py-1.5 font-medium ${today ? 'bg-primary/5 text-primary' : ''}`}
                >
                  {dayLabel(d.start, w.timezone)}
                </div>
              );
            })}
          </div>
          <div className="grid grid-cols-[3.5rem_repeat(7,1fr)]">
            <div>
              {hours.map((h) => (
                <div
                  key={h}
                  style={{ height: HOUR_PX }}
                  className="pr-1 text-right text-[11px] text-muted-foreground"
                >
                  {String(h).padStart(2, '0')}:00
                </div>
              ))}
            </div>
            {w.days.map((d, i) => {
              const nowMin =
                Date.parse(d.start) <= nowMs && nowMs < Date.parse(d.end)
                  ? ((c) => c.h * 60 + c.mi)(clock(new Date(nowMs), w.timezone))
                  : null;
              return (
                <div
                  key={d.start}
                  className="relative border-l"
                  style={{ height: hours.length * HOUR_PX }}
                >
                  {hours.map((h, k) => (
                    <div
                      key={h}
                      className="absolute inset-x-0 border-t border-border/50"
                      style={{ top: k * HOUR_PX }}
                    />
                  ))}
                  {perDay[i]!.map((b) => {
                    const top = ((Math.max(b.from, startH * 60) - startH * 60) / 60) * HOUR_PX;
                    const height = Math.max(
                      ((Math.min(b.to, endH * 60) - Math.max(b.from, startH * 60)) / 60) * HOUR_PX,
                      14,
                    );
                    const look =
                      b.kind === 'maintenance'
                        ? 'border-amber-500/60 bg-amber-500/15 text-amber-900 dark:text-amber-200'
                        : b.kind === 'busy'
                          ? 'border-border bg-muted text-muted-foreground'
                          : 'border-primary/40 bg-primary/15 text-foreground';
                    return (
                      <div
                        key={b.key}
                        title={`${b.label}\n${b.detail}`}
                        className={`absolute inset-x-0.5 overflow-hidden rounded border px-1 py-0.5 text-[11px] leading-tight ${look}`}
                        style={{ top, height }}
                      >
                        <div className="truncate font-medium">{b.label}</div>
                        {height > 28 && <div className="truncate opacity-80">{b.detail}</div>}
                      </div>
                    );
                  })}
                  {nowMin !== null && nowMin >= startH * 60 && nowMin <= endH * 60 && (
                    <div
                      className="absolute inset-x-0 z-10 border-t-2 border-destructive"
                      style={{ top: ((nowMin - startH * 60) / 60) * HOUR_PX }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <p className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span>
          <span className="mr-1 inline-block size-2.5 rounded-sm border border-primary/40 bg-primary/15" />
          Meeting
        </span>
        <span>
          <span className="mr-1 inline-block size-2.5 rounded-sm border bg-muted" />
          Busy (private)
        </span>
        <span>
          <span className="mr-1 inline-block size-2.5 rounded-sm border border-amber-500/60 bg-amber-500/15" />
          Maintenance
        </span>
        <span>Read only. Kestrel never changes your calendar.</span>
      </p>
    </PageContainer>
  );
}

/** Which calendar profile a room uses, and the room's own calendar address in it. */
export function RoomCalendarSetting({ roomId }: { roomId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const profiles = useQuery(trpc.calendar.list.queryOptions({ orgId }));
  const current = useQuery(trpc.calendar.forRoom.queryOptions({ orgId, roomId }));
  const [profile, setProfile] = useState<string | null>(null);
  const [resource, setResource] = useState<string | null>(null);
  const save = useMutation(
    trpc.calendar.setRoom.mutationOptions({
      onSuccess: async (_d, v) => {
        await Promise.all([
          qc.invalidateQueries({ queryKey: trpc.calendar.forRoom.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.calendar.list.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.calendar.week.queryKey() }),
        ]);
        setProfile(null);
        setResource(null);
        toast.success(v.connectionId ? 'Calendar saved' : 'Calendar removed from this room');
      },
    }),
  );
  if (!profiles.data || !current.data) return null;
  const list = profiles.data.connections;
  const chosen = profile ?? current.data.calendarConnectionId ?? 'none';
  const address = resource ?? current.data.calendarResource ?? '';
  const kind = list.find((c) => c.id === chosen)?.provider;
  const dirty =
    chosen !== (current.data.calendarConnectionId ?? 'none') ||
    address !== (current.data.calendarResource ?? '');

  return (
    <section className="mt-8 space-y-3 border-t pt-6">
      <div>
        <h2 className="text-sm font-medium">Calendar</h2>
        <p className="text-sm text-muted-foreground">
          Shows this room’s week, adds the meetings a fault may affect to its alerts, and checks
          bookings when you plan maintenance. Read only.
        </p>
      </div>
      {list.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          No calendar profiles yet. Add one under Settings &gt; Calendars first.
        </p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(
              chosen === 'none'
                ? { orgId, roomId, connectionId: null }
                : { orgId, roomId, connectionId: chosen, resource: address },
            );
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="room-cal-profile">Calendar profile</Label>
            <SimpleSelect
              id="room-cal-profile"
              className="w-full"
              value={chosen}
              onValueChange={setProfile}
              options={[
                { value: 'none', label: 'No calendar' },
                ...list.map((c) => ({
                  value: c.id,
                  label: `${c.name} (${c.provider === 'graph' ? 'Microsoft 365' : 'Google'})`,
                })),
              ]}
            />
          </div>
          {chosen !== 'none' && (
            <div className="space-y-2">
              <Label htmlFor="room-cal-address">
                {kind === 'google' ? 'Calendar ID' : 'Room calendar email address'}
              </Label>
              <Input
                id="room-cal-address"
                required
                placeholder={
                  kind === 'google' ? 'room-1@yourcompany.com' : 'boardroom@yourcompany.com'
                }
                value={address}
                onChange={(e) => setResource(e.target.value)}
              />
            </div>
          )}
          {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
          <Button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending && <Spinner />}
            Save calendar
          </Button>
        </form>
      )}
    </section>
  );
}
