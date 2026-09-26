import { describe, expect, it } from 'vitest';
import { SLA_TARGETS, firstResponseAt, slaLabel, ticketSla } from './sla';

const T0 = new Date('2026-09-26T00:00:00Z');
const after = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe('the clocks', () => {
  it('start at the beginning with targets by priority', () => {
    const s = ticketSla({ priority: 'urgent', startedAt: T0, now: T0 });
    expect(s.response.dueAt).toEqual(after(SLA_TARGETS.urgent.responseMinutes));
    expect(s.resolution.dueAt).toEqual(after(SLA_TARGETS.urgent.resolutionMinutes));
    expect(s.response.state).toBe('ok');
    expect(s.next?.kind).toBe('response');
    // Urgent is stricter than low, in both.
    expect(SLA_TARGETS.urgent.responseMinutes).toBeLessThan(SLA_TARGETS.high.responseMinutes);
    expect(SLA_TARGETS.high.resolutionMinutes).toBeLessThan(SLA_TARGETS.normal.resolutionMinutes);
    expect(SLA_TARGETS.normal.responseMinutes).toBeLessThan(SLA_TARGETS.low.responseMinutes);
  });

  it('go from ok to due soon to overdue as time passes', () => {
    const at = (m: number) =>
      ticketSla({ priority: 'high', startedAt: T0, now: after(m) }).response.state;
    const window = SLA_TARGETS.high.responseMinutes; // 240
    expect(at(0)).toBe('ok');
    expect(at(window * 0.7)).toBe('ok');
    expect(at(window * 0.8)).toBe('due_soon');
    expect(at(window)).toBe('due_soon'); // exactly at the target is not late yet
    expect(at(window + 1)).toBe('overdue');
  });

  it('a reply stops the response clock, in time or late, and moves attention to the resolution', () => {
    const inTime = ticketSla({
      priority: 'high',
      startedAt: T0,
      respondedAt: after(60),
      now: after(1000),
    });
    expect(inTime.response).toMatchObject({ state: 'met', doneAt: after(60) });
    expect(inTime.next?.kind).toBe('resolution');
    const late = ticketSla({
      priority: 'high',
      startedAt: T0,
      respondedAt: after(500),
      now: after(600),
    });
    expect(late.response.state).toBe('met_late');
  });

  it('resolving stops both, and a ticket closed without a reply counts as answered when closed', () => {
    const s = ticketSla({
      priority: 'normal',
      startedAt: T0,
      closedAt: after(100),
      now: after(99999),
    });
    expect(s.response).toMatchObject({ state: 'met', doneAt: after(100) });
    expect(s.resolution.state).toBe('met');
    expect(s.next).toBeNull();
    const late = ticketSla({
      priority: 'urgent',
      startedAt: T0,
      closedAt: after(600),
      now: after(700),
    });
    expect(late.resolution.state).toBe('met_late');
  });

  it('an unknown priority is treated as normal', () => {
    expect(ticketSla({ priority: 'whenever', startedAt: T0, now: T0 }).response.dueAt).toEqual(
      after(SLA_TARGETS.normal.responseMinutes),
    );
  });
});

describe('the first reply', () => {
  const c = (over: Record<string, unknown>) => ({
    authorId: 'staff1',
    fromStaff: false,
    visibility: 'public',
    createdAt: after(30),
    ...over,
  });
  const ticket = { createdBy: 'cust1' };

  it('is the earliest public comment by someone other than the person who raised it', () => {
    expect(
      firstResponseAt(ticket, [
        c({ authorId: 'cust1', createdAt: after(5) }),
        c({ createdAt: after(40) }),
        c({ createdAt: after(20) }),
      ]),
    ).toEqual(after(20));
  });

  it('counts a Kestrel staff reply, but not an internal note or the requester talking to themselves', () => {
    expect(
      firstResponseAt(ticket, [c({ fromStaff: true, authorId: null, createdAt: after(9) })]),
    ).toEqual(after(9));
    expect(firstResponseAt(ticket, [c({ visibility: 'internal' })])).toBeNull();
    expect(firstResponseAt(ticket, [c({ authorId: 'cust1' })])).toBeNull();
    expect(firstResponseAt(ticket, [])).toBeNull();
  });

  it('can be limited to replies after the clock started (an escalation)', () => {
    const replies = [c({ createdAt: after(10) }), c({ createdAt: after(70) })];
    expect(firstResponseAt(ticket, replies, after(60))).toEqual(after(70));
  });
});

describe('wording', () => {
  it('says what is due and when', () => {
    const now = after(0);
    expect(slaLabel(ticketSla({ priority: 'urgent', startedAt: T0, now }), now)).toBe(
      'Reply due in 1 h',
    );
    expect(slaLabel(ticketSla({ priority: 'normal', startedAt: T0, now }), now)).toBe(
      'Reply due in 24 h',
    );
    expect(slaLabel(ticketSla({ priority: 'low', startedAt: T0, now }), now)).toBe(
      'Reply due in 3 d',
    );
    const later = after(5 * 60);
    expect(slaLabel(ticketSla({ priority: 'high', startedAt: T0, now: later }), later)).toBe(
      'Reply overdue by 1 h',
    );
    const replied = ticketSla({
      priority: 'high',
      startedAt: T0,
      respondedAt: after(30),
      now: later,
    });
    expect(slaLabel(replied, later)).toBe('Resolve due in 19 h');
    const done = ticketSla({ priority: 'high', startedAt: T0, closedAt: after(90), now: later });
    expect(slaLabel(done, later)).toBe('Resolved in time');
  });
});
