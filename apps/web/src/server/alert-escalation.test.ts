import { describe, expect, it } from 'vitest';
import {
  ChannelRules,
  describeRules,
  dueNow,
  hasRules,
  inWindow,
  type ChannelRules as Rules,
} from './alert-rules';
import {
  MAX_ATTEMPTS,
  RETRY_AFTER_MS,
  channelRules,
  deliverAlerts,
  deliverDue,
  type AlertDb,
  type Senders,
} from './alerts';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const ROOM = '33333333-3333-4333-8333-333333333331';
const INC = '77777777-7777-4777-8777-777777777771';
// Thursday 24 September 2026, 10:00 UTC.
const T0 = new Date('2026-09-24T10:00:00Z');
const min = (n: number, from = T0) => new Date(from.getTime() + n * 60_000);
const at = (iso: string) => new Date(iso);
const WEEKDAYS = [0, 1, 2, 3, 4];

describe('alert windows', () => {
  const day: NonNullable<Rules['window']> = { days: WEEKDAYS, start: '09:00', end: '17:00', tz: 'UTC' };

  it('is open on the chosen days between the start and the end, the end not included', () => {
    expect(inWindow(day, at('2026-09-24T10:00:00Z'))).toBe(true);
    expect(inWindow(day, at('2026-09-24T09:00:00Z'))).toBe(true);
    expect(inWindow(day, at('2026-09-24T08:59:00Z'))).toBe(false);
    expect(inWindow(day, at('2026-09-24T17:00:00Z'))).toBe(false);
    // Saturday.
    expect(inWindow(day, at('2026-09-26T10:00:00Z'))).toBe(false);
  });

  it('runs a window that crosses midnight into the next day, following the day it started', () => {
    const night = { days: WEEKDAYS, start: '22:00', end: '06:00', tz: 'UTC' };
    expect(inWindow(night, at('2026-09-24T23:00:00Z'))).toBe(true); // Thursday night
    expect(inWindow(night, at('2026-09-25T03:00:00Z'))).toBe(true); // Friday early, from Thursday
    expect(inWindow(night, at('2026-09-26T03:00:00Z'))).toBe(true); // Saturday early, from Friday
    expect(inWindow(night, at('2026-09-27T03:00:00Z'))).toBe(false); // Sunday early: Saturday is not on
    expect(inWindow(night, at('2026-09-28T03:00:00Z'))).toBe(false); // Monday early: Sunday is not on
    expect(inWindow(night, at('2026-09-24T12:00:00Z'))).toBe(false);
  });

  it('reads the hours in the zone chosen', () => {
    const sydney = { ...day, tz: 'Australia/Sydney' };
    // 00:00 UTC is 10:00 in Sydney; 10:00 UTC is 20:00.
    expect(inWindow(sydney, at('2026-09-24T00:00:00Z'))).toBe(true);
    expect(inWindow(sydney, at('2026-09-24T10:00:00Z'))).toBe(false);
  });

  it('means the whole day when the start and end are the same', () => {
    expect(inWindow({ days: [3], start: '00:00', end: '00:00', tz: 'UTC' }, T0)).toBe(true);
    expect(inWindow({ days: [2], start: '00:00', end: '00:00', tz: 'UTC' }, T0)).toBe(false);
  });
});

describe('what a channel is due to send', () => {
  const base = { openedAt: T0, acknowledged: false, sent: [] as { event: string; at: Date }[] };

  it('alerts at once when there is no delay and no window', () => {
    expect(dueNow({ ...base, rules: { repeatMinutes: 30 }, now: T0 })).toBe('opened');
  });

  it('waits out a delay, and drops the alert if someone acknowledged it first', () => {
    const rules = { delayMinutes: 30 };
    expect(dueNow({ ...base, rules, now: min(29) })).toBeNull();
    expect(dueNow({ ...base, rules, now: min(30) })).toBe('opened');
    expect(dueNow({ ...base, rules, acknowledged: true, now: min(30) })).toBeNull();
  });

  it('holds an alert until the window opens', () => {
    const rules = { window: { days: WEEKDAYS, start: '09:00', end: '17:00', tz: 'UTC' } };
    const opened = at('2026-09-24T18:00:00Z');
    expect(dueNow({ ...base, openedAt: opened, rules, now: at('2026-09-24T18:05:00Z') })).toBeNull();
    expect(dueNow({ ...base, openedAt: opened, rules, now: at('2026-09-25T09:00:00Z') })).toBe('opened');
  });

  it('repeats every so often until acknowledged, up to a limit', () => {
    const rules = { repeatMinutes: 30, maxRepeats: 2 };
    const first = { event: 'opened', at: T0 };
    expect(dueNow({ ...base, rules, sent: [first], now: min(29) })).toBeNull();
    expect(dueNow({ ...base, rules, sent: [first], now: min(30) })).toBe('reminder');
    // The next is counted from the last one sent, not from the start.
    const one = [first, { event: 'reminder', at: min(35) }];
    expect(dueNow({ ...base, rules, sent: one, now: min(60) })).toBeNull();
    expect(dueNow({ ...base, rules, sent: one, now: min(65) })).toBe('reminder');
    const two = [...one, { event: 'reminder', at: min(65) }];
    expect(dueNow({ ...base, rules, sent: two, now: min(200) })).toBeNull();
    expect(dueNow({ ...base, rules, acknowledged: true, sent: [first], now: min(60) })).toBeNull();
  });

  it('does not repeat a channel that has no repeat rule', () => {
    expect(dueNow({ ...base, rules: { delayMinutes: 5 }, sent: [{ event: 'opened', at: T0 }], now: min(500) })).toBeNull();
  });

  it('holds a reminder that falls outside the window', () => {
    const rules = { repeatMinutes: 30, window: { days: WEEKDAYS, start: '09:00', end: '11:00', tz: 'UTC' } };
    expect(dueNow({ ...base, rules, sent: [{ event: 'opened', at: T0 }], now: min(90) })).toBeNull();
  });
});

describe('rules on a channel', () => {
  it('checks the rules are sensible', () => {
    expect(ChannelRules.safeParse({ window: { days: [], start: '09:00', end: '17:00', tz: 'UTC' } }).success).toBe(false);
    expect(ChannelRules.safeParse({ window: { days: [1], start: '9:00', end: '17:00', tz: 'UTC' } }).success).toBe(false);
    expect(ChannelRules.safeParse({ window: { days: [1], start: '09:00', end: '17:00', tz: 'Mars/Base' } }).success).toBe(false);
    expect(ChannelRules.safeParse({ repeatMinutes: 1 }).success).toBe(false);
    expect(ChannelRules.safeParse({ delayMinutes: 30, repeatMinutes: 15, maxRepeats: 3 }).success).toBe(true);
  });

  it('counts only real rules', () => {
    expect(hasRules(undefined)).toBe(false);
    expect(hasRules({})).toBe(false);
    expect(hasRules({ delayMinutes: 0 })).toBe(false);
    expect(hasRules({ delayMinutes: 1 })).toBe(true);
    expect(channelRules({ config: { url: 'https://x.example.com' } })).toBeNull();
    expect(channelRules({ config: { rules: { repeatMinutes: 30 } } })).toEqual({ repeatMinutes: 30 });
    expect(channelRules({ config: { rules: { repeatMinutes: 1 } } })).toBeNull();
  });

  it('describes them in a sentence', () => {
    expect(describeRules({ window: { days: WEEKDAYS, start: '09:00', end: '17:00', tz: 'UTC' }, delayMinutes: 30, repeatMinutes: 15 })).toBe(
      'weekdays 09:00 to 17:00 (UTC), after 30 min if nobody has acknowledged it, repeats every 15 min until acknowledged (up to 5 times)',
    );
    expect(describeRules({ window: { days: [5, 6], start: '00:00', end: '08:00', tz: 'UTC' } })).toBe('Sat, Sun 00:00 to 08:00 (UTC)');
    expect(describeRules(null)).toBeNull();
  });
});

function senders(status = 200) {
  const calls: { url: string; body: { event: string } }[] = [];
  const s: Senders = {
    fetch: (async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response('{}', { status });
    }) as typeof fetch,
    resolve: async () => ['93.184.216.34'],
    env: {},
  };
  return { s, calls };
}

function world(channels: { name: string; rules?: Rules; minSeverity?: string; enabled?: boolean }[], incident: Record<string, unknown> = {}) {
  const alertChannel = table(
    channels.map((c, i) => ({
      id: `c${i}`,
      orgId: ORG,
      type: 'webhook',
      enabled: c.enabled ?? true,
      minSeverity: c.minSeverity ?? 'warning',
      config: { url: `https://${c.name}.example.com/x`, ...(c.rules ? { rules: c.rules } : {}) },
    })),
  );
  const alertDelivery = table([]);
  const inc = table([
    {
      id: INC,
      orgId: ORG,
      roomId: ROOM,
      kind: 'device_offline',
      severity: 'warning',
      title: 'DSP is offline',
      detail: 'x',
      status: 'open',
      openedAt: T0,
      resolvedAt: null,
      acknowledgedAt: null,
      ...incident,
    },
  ]);
  const room = table([{ id: ROOM, orgId: ORG, name: 'Boardroom' }]);
  return { db: { alertChannel, alertDelivery, incident: inc, room } as unknown as AlertDb, alertDelivery, incident: inc.rows[0]! };
}
const hosts = (calls: { url: string }[]) => calls.map((c) => new URL(c.url).hostname.split('.')[0]);

describe('a problem opens', () => {
  it('alerts channels with no rules at once and holds back those that wait', async () => {
    const w = world([{ name: 'now' }, { name: 'later', rules: { delayMinutes: 30 } }, { name: 'repeating', rules: { repeatMinutes: 30 } }]);
    const { s, calls } = senders();
    await deliverAlerts(w.db, [{ incidentId: INC, event: 'opened' }], s, T0);
    expect(hosts(calls)).toEqual(['now', 'repeating']);
  });

  it('sends the held alert when its delay is up, once', async () => {
    const w = world([{ name: 'later', rules: { delayMinutes: 30 } }]);
    const { s, calls } = senders();
    await deliverAlerts(w.db, [{ incidentId: INC, event: 'opened' }], s, T0);
    expect(await deliverDue(w.db, s, min(29))).toBe(0);
    expect(await deliverDue(w.db, s, min(30))).toBe(1);
    expect(calls.map((c) => c.body.event)).toEqual(['opened']);
    expect(await deliverDue(w.db, s, min(120))).toBe(0);
  });

  it('does not send the delayed alert when someone acknowledged the problem first', async () => {
    const w = world([{ name: 'later', rules: { delayMinutes: 30 } }]);
    w.incident.acknowledgedAt = min(10);
    const { s, calls } = senders();
    expect(await deliverDue(w.db, s, min(45))).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('does not send it when the problem cleared first', async () => {
    const w = world([{ name: 'later', rules: { delayMinutes: 30 } }], { status: 'resolved', resolvedAt: min(10) });
    const { s, calls } = senders();
    expect(await deliverDue(w.db, s, min(45))).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('holds an alert that comes up out of hours until the window opens', async () => {
    const window = { days: WEEKDAYS, start: '09:00', end: '17:00', tz: 'UTC' };
    const night = at('2026-09-24T20:00:00Z');
    const w = world([{ name: 'oncall', rules: { window } }], { openedAt: night });
    const { s, calls } = senders();
    await deliverAlerts(w.db, [{ incidentId: INC, event: 'opened' }], s, night);
    expect(calls).toHaveLength(0);
    expect(await deliverDue(w.db, s, at('2026-09-25T08:59:00Z'))).toBe(0);
    expect(await deliverDue(w.db, s, at('2026-09-25T09:00:00Z'))).toBe(1);
    expect(calls[0]!.body.event).toBe('opened');
  });

  it('shares a rota between channels by their hours', async () => {
    const early = { days: WEEKDAYS, start: '08:00', end: '12:00', tz: 'UTC' };
    const late = { days: WEEKDAYS, start: '12:00', end: '18:00', tz: 'UTC' };
    const w = world([{ name: 'alice', rules: { window: early } }, { name: 'bob', rules: { window: late } }]);
    const { s, calls } = senders();
    await deliverAlerts(w.db, [{ incidentId: INC, event: 'opened' }], s, T0);
    expect(hosts(calls)).toEqual(['alice']);
  });
});

describe('reminders', () => {
  it('repeats until the limit, and stops when the problem is acknowledged', async () => {
    const w = world([{ name: 'r', rules: { repeatMinutes: 30, maxRepeats: 3 } }]);
    const { s, calls } = senders();
    await deliverAlerts(w.db, [{ incidentId: INC, event: 'opened' }], s, T0);
    expect(await deliverDue(w.db, s, min(30))).toBe(1);
    expect(await deliverDue(w.db, s, min(60))).toBe(1);
    w.incident.acknowledgedAt = min(70);
    expect(await deliverDue(w.db, s, min(90))).toBe(0);
    expect(calls.map((c) => c.body.event)).toEqual(['opened', 'reminder', 'reminder']);
  });

  it('stops after the limit', async () => {
    const w = world([{ name: 'r', rules: { repeatMinutes: 30, maxRepeats: 1 } }]);
    const { s, calls } = senders();
    await deliverAlerts(w.db, [{ incidentId: INC, event: 'opened' }], s, T0);
    await deliverDue(w.db, s, min(30));
    await deliverDue(w.db, s, min(60));
    expect(calls.map((c) => c.body.event)).toEqual(['opened', 'reminder']);
  });
});

describe('when it clears', () => {
  const job = [{ incidentId: INC, event: 'resolved' as const }];

  it('tells a channel with rules only if it was told about the problem', async () => {
    const w = world([{ name: 'told', rules: { repeatMinutes: 30 } }, { name: 'never', rules: { delayMinutes: 60 } }, { name: 'plain' }], {
      status: 'resolved',
      resolvedAt: min(20),
    });
    w.alertDelivery.rows.push({ channelId: 'c0', incidentId: INC, event: 'opened', status: 'sent', at: T0 });
    const { s, calls } = senders();
    await deliverAlerts(w.db, job, s, min(20));
    // A channel with no rules gets it as it always did.
    expect(hosts(calls).sort()).toEqual(['plain', 'told']);
  });
});

describe('a channel that fails', () => {
  it('is not hammered: waits before trying again, and gives up after a few attempts', async () => {
    const w = world([{ name: 'broken', rules: { delayMinutes: 1 } }]);
    const { s, calls } = senders(500);
    expect(await deliverDue(w.db, s, min(1))).toBe(0);
    expect(calls).toHaveLength(1);
    // Too soon to try again.
    await deliverDue(w.db, s, min(2));
    expect(calls).toHaveLength(1);
    let t = 1;
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      t += RETRY_AFTER_MS / 60_000 + 1;
      await deliverDue(w.db, s, min(t));
    }
    expect(calls).toHaveLength(MAX_ATTEMPTS);
  });

  it('ignores disabled channels and those the problem is too small for', async () => {
    const w = world([
      { name: 'off', rules: { delayMinutes: 1 }, enabled: false },
      { name: 'critical', rules: { delayMinutes: 1 }, minSeverity: 'critical' },
    ]);
    const { s, calls } = senders();
    expect(await deliverDue(w.db, s, min(5))).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
