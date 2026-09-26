// Response and resolution targets for support requests. Worked out from a ticket's own times, so
// nothing extra is stored. Targets run in calendar time (nights and weekends count); business hours
// per organisation come later.
export const SLA_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type SlaPriority = (typeof SLA_PRIORITIES)[number];

const HOUR = 60;
const DAY = 24 * HOUR;

/** Minutes to a first reply, and to resolution, by priority. */
export const SLA_TARGETS: Record<
  SlaPriority,
  { responseMinutes: number; resolutionMinutes: number }
> = {
  urgent: { responseMinutes: 1 * HOUR, resolutionMinutes: 4 * HOUR },
  high: { responseMinutes: 4 * HOUR, resolutionMinutes: 1 * DAY },
  normal: { responseMinutes: 1 * DAY, resolutionMinutes: 5 * DAY },
  low: { responseMinutes: 3 * DAY, resolutionMinutes: 10 * DAY },
};

/** A target is "due soon" once this much of its time is left or less. */
export const DUE_SOON_FRACTION = 0.25;

/**
 * ok: plenty of time. due_soon: little time left. overdue: the target has passed and it is not done.
 * met: done in time. met_late: done, but after the target.
 */
export type SlaState = 'ok' | 'due_soon' | 'overdue' | 'met' | 'met_late';

export interface SlaClock {
  dueAt: Date;
  /** When it was done (first reply sent, or ticket resolved), or null while it is still to do. */
  doneAt: Date | null;
  state: SlaState;
}

export interface TicketSla {
  response: SlaClock;
  resolution: SlaClock;
  /** The clock that matters now: the reply while there is none, then the resolution. Null when both are done. */
  next: { kind: 'response' | 'resolution'; clock: SlaClock } | null;
}

function clock(startedAt: Date, minutes: number, doneAt: Date | null, now: Date): SlaClock {
  const dueAt = new Date(startedAt.getTime() + minutes * 60_000);
  if (doneAt)
    return { dueAt, doneAt, state: doneAt.getTime() <= dueAt.getTime() ? 'met' : 'met_late' };
  const left = dueAt.getTime() - now.getTime();
  const state: SlaState =
    left < 0 ? 'overdue' : left <= minutes * 60_000 * DUE_SOON_FRACTION ? 'due_soon' : 'ok';
  return { dueAt, doneAt: null, state };
}

export function isSlaPriority(p: string): p is SlaPriority {
  return (SLA_PRIORITIES as readonly string[]).includes(p);
}

/**
 * The response and resolution clocks for a ticket. `startedAt` is when the team's clock started
 * (when it was raised, or when it was escalated to Kestrel). A ticket closed without a reply counts
 * as answered when it was closed.
 */
export function ticketSla(input: {
  priority: string;
  startedAt: Date;
  respondedAt?: Date | null;
  closedAt?: Date | null;
  now?: Date;
}): TicketSla {
  const now = input.now ?? new Date();
  const target = SLA_TARGETS[isSlaPriority(input.priority) ? input.priority : 'normal'];
  const closedAt = input.closedAt ?? null;
  const respondedAt = input.respondedAt ?? closedAt;
  const response = clock(input.startedAt, target.responseMinutes, respondedAt, now);
  const resolution = clock(input.startedAt, target.resolutionMinutes, closedAt, now);
  const next = !response.doneAt
    ? { kind: 'response' as const, clock: response }
    : !resolution.doneAt
      ? { kind: 'resolution' as const, clock: resolution }
      : null;
  return { response, resolution, next };
}

/** The first reply from the team: a public comment by someone other than whoever raised the ticket. */
export function firstResponseAt(
  ticket: { createdBy: string | null },
  comments: { authorId: string | null; fromStaff: boolean; visibility: string; createdAt: Date }[],
  after?: Date | null,
): Date | null {
  const replies = comments
    .filter(
      (c) =>
        c.visibility === 'public' &&
        (c.fromStaff || (c.authorId !== null && c.authorId !== ticket.createdBy)) &&
        (!after || c.createdAt.getTime() >= after.getTime()),
    )
    .map((c) => c.createdAt.getTime());
  return replies.length ? new Date(Math.min(...replies)) : null;
}

function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/** "Reply due in 2 h", "Reply overdue by 3 h", "Resolve due in 1 d", or "Replied in time". */
export function slaLabel(sla: TicketSla, now: Date = new Date()): string {
  if (!sla.next) return sla.resolution.state === 'met' ? 'Resolved in time' : 'Resolved late';
  const { kind, clock: c } = sla.next;
  const verb = kind === 'response' ? 'Reply' : 'Resolve';
  const ms = c.dueAt.getTime() - now.getTime();
  return ms < 0 ? `${verb} overdue by ${span(-ms)}` : `${verb} due in ${span(ms)}`;
}
