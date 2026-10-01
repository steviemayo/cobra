import { describe, expect, it } from 'vitest';
import {
  LATENCY_DEFAULTS,
  bucketStart,
  evaluateLatency,
  judge,
  latencyLimits,
  latencySeries,
  latencySummary,
  median,
  pruneLatency,
  recordLatency,
  resetLatencyLimits,
  rollupHours,
  saveLatencyLimits,
  worstDevices,
  type LatencyDb,
} from './latency';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222221';
const ROOM = '33333333-3333-4333-8333-333333333331';
const GW = '99999999-9999-4999-8999-999999999991';
const dev = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const NOW = new Date('2026-10-01T12:07:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const limits = { ...LATENCY_DEFAULTS };

const sums = (sent: number, ok: number, avg: number, max = avg) => ({
  sent,
  ok,
  sumMs: avg * ok,
  minMs: ok ? avg : null,
  maxMs: ok ? max : null,
});

function world(deviceCount = 4) {
  return {
    latencyBucket: table([]),
    latencyHour: table([]),
    orgLatencySettings: table([]),
    device: table(
      Array.from({ length: deviceCount }, (_, i) => ({
        id: dev(i + 1),
        orgId: ORG,
        siteId: SITE,
        roomId: ROOM,
        name: `Device ${i + 1}`,
        online: true,
      })),
    ),
    gateway: table([{ id: GW, orgId: ORG, siteId: SITE }]),
    site: table([{ id: SITE, orgId: ORG, name: 'HQ', timezone: 'Australia/Sydney' }]),
    room: table([{ id: ROOM, orgId: ORG, siteId: SITE, name: 'Boardroom' }]),
    incident: table([]),
  };
}
type W = ReturnType<typeof world>;
const asDb = (w: W) => w as unknown as LatencyDb;

/** A usual 10 ms for the last week, hour by hour, for each device given. */
function usual(w: W, ids: string[], avg = 10) {
  for (const id of ids)
    for (let h = 2; h < 7 * 24; h++)
      w.latencyHour.rows.push({
        deviceId: id,
        orgId: ORG,
        siteId: SITE,
        bucket: new Date(bucketStart(NOW, HOUR).getTime() - h * HOUR),
        ...sums(360, 360, avg),
      });
}
/** The last 15 minutes: `sent` pings a bucket. */
function recent(w: W, id: string, avg: number, ok = 30, sent = 30) {
  for (const back of [0, 5 * MIN, 10 * MIN])
    w.latencyBucket.rows.push({
      deviceId: id,
      orgId: ORG,
      siteId: SITE,
      bucket: new Date(bucketStart(NOW).getTime() - back),
      ...sums(sent, ok, avg),
    });
}

describe('recording', () => {
  it('adds each heartbeat to the current 5-minute bucket', async () => {
    const w = world();
    const d = { id: dev(1), orgId: ORG, siteId: SITE };
    await recordLatency(asDb(w), d, { sent: 3, ok: 3, minMs: 4, avgMs: 10, maxMs: 20 }, NOW);
    await recordLatency(
      asDb(w),
      d,
      { sent: 3, ok: 2, minMs: 2, avgMs: 40, maxMs: 60 },
      new Date(NOW.getTime() + MIN),
    );
    expect(w.latencyBucket.rows).toHaveLength(1);
    expect(w.latencyBucket.rows[0]).toMatchObject({
      sent: 6,
      ok: 5,
      sumMs: 110,
      minMs: 2,
      maxMs: 60,
      bucket: bucketStart(NOW),
    });
  });

  it('records a window with no answers as loss', async () => {
    const w = world();
    await recordLatency(asDb(w), { id: dev(1), orgId: ORG, siteId: SITE }, { sent: 3, ok: 0 }, NOW);
    expect(w.latencyBucket.rows[0]).toMatchObject({ sent: 3, ok: 0, sumMs: 0, minMs: null });
  });
});

describe('judging', () => {
  const s = (sent: number, ok: number, avg: number) => ({ ...sums(sent, ok, avg) });
  it('flags dropped pings, slow answers and a change from the usual', () => {
    expect(judge(s(100, 80, 10), 10, limits).reason).toBe('loss');
    expect(judge(s(100, 100, 200), null, limits).reason).toBe('high');
    expect(judge(s(100, 100, 45), 10, limits).reason).toBe('trend');
  });
  it('leaves normal variation alone', () => {
    // Twice the usual but only 8 ms more: not worth an incident.
    expect(judge(s(100, 100, 12), 4, limits).reason).toBeNull();
    expect(judge(s(100, 100, 25), 15, limits).reason).toBeNull();
    expect(judge(s(100, 100, 45), null, limits).reason).toBeNull();
  });
  it('says nothing from a handful of pings', () => {
    expect(judge(s(3, 0, 0), 10, limits).reason).toBeNull();
  });
  it('takes the median', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('incidents from response times', () => {
  it('opens one for a device slow against its own usual, then resolves it', async () => {
    const w = world();
    usual(w, [dev(1)]);
    recent(w, dev(1), 60);
    const jobs = await evaluateLatency(asDb(w), NOW);
    expect(jobs).toHaveLength(1);
    expect(w.incident.rows[0]).toMatchObject({
      kind: 'latency_high',
      subject: `device:${dev(1)}`,
      roomId: ROOM,
      severity: 'warning',
      title: 'Device 1 is responding slowly',
    });
    expect(w.incident.rows[0]!.detail).toContain('usually answers in about 10 ms');

    // Back to normal: the same incident closes.
    w.latencyBucket.rows.length = 0;
    recent(w, dev(1), 11);
    const later = await evaluateLatency(asDb(w), new Date(NOW.getTime() + 5 * MIN));
    expect(later).toEqual([{ incidentId: w.incident.rows[0]!.id, event: 'resolved' }]);
    expect(w.incident.rows[0]!.status).toBe('resolved');
  });

  it('says dropping pings when answers are lost', async () => {
    const w = world();
    recent(w, dev(1), 8, 20, 30);
    await evaluateLatency(asDb(w), NOW);
    expect(w.incident.rows[0]).toMatchObject({ title: 'Device 1 is dropping pings' });
    expect(w.incident.rows[0]!.detail).toContain('33% of pings had no answer');
  });

  it('does not open one for a device with no week behind it unless it is slow outright', async () => {
    const w = world();
    recent(w, dev(1), 60);
    expect(await evaluateLatency(asDb(w), NOW)).toEqual([]);
    expect(w.incident.rows).toHaveLength(0);
  });

  it('leaves an offline device to its own incident', async () => {
    const w = world();
    w.device.rows[0]!.online = false;
    recent(w, dev(1), 8, 0, 30);
    expect(await evaluateLatency(asDb(w), NOW)).toEqual([]);
  });

  it('raises one network incident for the site when several devices slow together', async () => {
    const w = world();
    usual(w, [dev(1), dev(2), dev(3), dev(4)]);
    for (const n of [1, 2, 3]) recent(w, dev(n), 80);
    recent(w, dev(4), 10);
    const jobs = await evaluateLatency(asDb(w), NOW);
    expect(jobs).toHaveLength(1);
    expect(w.incident.rows).toHaveLength(1);
    expect(w.incident.rows[0]).toMatchObject({
      kind: 'network_degraded',
      subject: `site:${SITE}`,
      gatewayId: GW,
      title: 'The network at HQ is slow or dropping pings',
    });
    expect(w.incident.rows[0]!.detail).toContain('3 of 4 devices are affected');
  });

  it('keeps one slow device a device problem', async () => {
    const w = world();
    usual(w, [dev(1), dev(2), dev(3), dev(4)]);
    recent(w, dev(1), 80);
    for (const n of [2, 3, 4]) recent(w, dev(n), 10);
    await evaluateLatency(asDb(w), NOW);
    expect(w.incident.rows.map((i) => i.kind)).toEqual(['latency_high']);
  });

  it('uses an organisation’s own limits', async () => {
    const w = world();
    usual(w, [dev(1)]);
    recent(w, dev(1), 60);
    await saveLatencyLimits(asDb(w), ORG, { ...limits, factor: 10, highMs: 500 });
    expect(await evaluateLatency(asDb(w), NOW)).toEqual([]);
  });
});

describe('limits', () => {
  it('start at the defaults, can be changed and reset', async () => {
    const w = world();
    expect(await latencyLimits(asDb(w), ORG)).toEqual({ limits, custom: false });
    await saveLatencyLimits(asDb(w), ORG, { ...limits, highMs: 300 });
    expect(await latencyLimits(asDb(w), ORG)).toEqual({
      limits: { ...limits, highMs: 300 },
      custom: true,
    });
    // Only what differs from the default is stored.
    expect(w.orgLatencySettings.rows[0]).toMatchObject({ highMs: 300, factor: null });
    await resetLatencyLimits(asDb(w), ORG);
    expect(await latencyLimits(asDb(w), ORG)).toEqual({ limits, custom: false });
  });
});

describe('hours and graphs', () => {
  it('rolls complete hours up from the buckets, and can be run again', async () => {
    const w = world();
    const hour = bucketStart(NOW, HOUR).getTime() - HOUR; // 11:00
    for (let i = 0; i < 12; i++)
      w.latencyBucket.rows.push({
        deviceId: dev(1),
        orgId: ORG,
        siteId: SITE,
        bucket: new Date(hour + i * 5 * MIN),
        ...sums(10, 10, 20, 30),
      });
    expect(await rollupHours(asDb(w), NOW)).toBe(1);
    await rollupHours(asDb(w), NOW);
    expect(w.latencyHour.rows).toHaveLength(1);
    expect(w.latencyHour.rows[0]).toMatchObject({ sent: 120, ok: 120, sumMs: 2400, maxMs: 30 });
  });

  it('draws 5-minute points for a day and hours for a week, up to now', async () => {
    const w = world();
    usual(w, [dev(1)]);
    recent(w, dev(1), 20);
    const day = await latencySeries(asDb(w), ORG, { deviceId: dev(1) }, '24h', NOW);
    expect(day).toHaveLength(3);
    expect(day[0]).toMatchObject({ avgMs: 20, lossPct: 0 });
    const week = await latencySeries(asDb(w), ORG, { deviceId: dev(1) }, '7d', NOW);
    // The rolled-up hours, and the current hour built from its buckets.
    expect(week.length).toBeGreaterThan(160);
    expect(week.at(-1)).toMatchObject({ avgMs: 20 });
    expect(week[0]!.t < week.at(-1)!.t).toBe(true);
  });

  it('puts the last day against the usual', async () => {
    const w = world();
    usual(w, [dev(1)], 10);
    recent(w, dev(1), 30);
    expect(await latencySummary(asDb(w), ORG, { siteId: SITE }, NOW)).toMatchObject({
      avgMs: 30,
      usualMs: 10,
      changePct: 200,
    });
  });

  it('ranks the worst devices at a site, lost pings first', async () => {
    const w = world();
    recent(w, dev(1), 50);
    recent(w, dev(2), 8, 20, 30);
    recent(w, dev(3), 5);
    const out = await worstDevices(asDb(w), ORG, SITE, NOW);
    expect(out.map((r) => r.deviceId)).toEqual([dev(2), dev(1), dev(3)]);
    expect(out[0]).toMatchObject({ name: 'Device 2', roomName: 'Boardroom', lossPct: 33.3 });
  });
});

describe('keeping', () => {
  it('drops buckets after a week and hours after the retention window', async () => {
    const w = world();
    const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
    for (const [i, d] of [1, 8].entries())
      w.latencyBucket.rows.push({
        deviceId: dev(i + 1),
        orgId: ORG,
        siteId: SITE,
        bucket: at(d),
        ...sums(1, 1, 1),
      });
    for (const [i, d] of [30, 100].entries())
      w.latencyHour.rows.push({
        deviceId: dev(i + 1),
        orgId: ORG,
        siteId: SITE,
        bucket: at(d),
        ...sums(1, 1, 1),
      });
    expect(await pruneLatency(asDb(w), NOW, 90)).toEqual({ buckets: 1, hours: 1 });
    expect(w.latencyBucket.rows).toHaveLength(1);
    expect(w.latencyHour.rows).toHaveLength(1);
  });
});
