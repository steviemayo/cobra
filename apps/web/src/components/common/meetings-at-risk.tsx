import { CalendarClock } from 'lucide-react';

/** Meetings in a room's calendar that a fault may disturb. Private meetings arrive as "Busy". */
export function MeetingsAtRisk({
  impact,
  compact,
}: {
  impact: { lines: string[]; more: number };
  compact?: boolean;
}) {
  return (
    <div
      className={`rounded-md border border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-200 ${compact ? 'px-3 py-2 text-xs' : 'p-3 text-sm'}`}
    >
      <p className="flex items-center gap-1.5 font-medium">
        <CalendarClock className="size-4 shrink-0" />
        This may affect {impact.lines.length + impact.more === 1 ? 'a meeting' : 'meetings'}
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-6">
        {impact.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
        {impact.more > 0 && <li>and {impact.more} more</li>}
      </ul>
      <p className="mt-1 opacity-80">
        Tell the people booked, reschedule, or move to another room.
      </p>
    </div>
  );
}
