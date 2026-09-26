import { slaLabel, type SlaState, type TicketSla } from '@kestrel/model';
import { cn } from '@/lib/utils';

const TONE: Record<SlaState, string> = {
  overdue: 'font-medium text-destructive',
  due_soon: 'font-medium text-warning',
  ok: 'text-muted-foreground',
  met: 'text-success',
  met_late: 'text-muted-foreground',
};

const when = (d: Date) =>
  new Date(d).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Where a request stands against its target: "Reply due in 2 h", "Resolve overdue by 1 d",
 * "Resolved in time". Colour is backed by the words. Renders nothing when there is no target (for
 * example for customer viewers).
 */
export function SlaBadge({
  sla,
  className,
}: {
  sla: TicketSla | null | undefined;
  className?: string;
}) {
  if (!sla) return null;
  const state = sla.next?.clock.state ?? sla.resolution.state;
  return (
    <span
      className={cn('text-xs whitespace-nowrap', TONE[state], className)}
      title={`Reply due ${when(sla.response.dueAt)} · Resolve due ${when(sla.resolution.dueAt)}`}
    >
      {slaLabel(sla)}
    </span>
  );
}
