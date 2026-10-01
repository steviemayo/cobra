import type { PrismaClient } from '@kestrel/db';
import type { DeviceLatency } from '@kestrel/model';
import { openIncident, resolveIncident, type AlertJob, type MonitoringDb } from './monitoring';

// Response times (docs/decisions.md RT-1..): gateways ping each device and send how it answered with
// every heartbeat. Kestrel sums that into 5-minute buckets, rolls them into hours, draws the graphs,
// and raises an incident when a device is slow against its own usual, slow outright, or dropping
// pings. When several devices at one site do it together, that is one network incident for the site.
export type LatencyDb = Pick<
  PrismaClient,
  'latencyBucket' | 'latencyHour' | 'orgLatencySettings' | 'device' | 'gateway' | 'site' | 'room'
> &
  MonitoringDb;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Kestrel's own limits. An organisation can change each of them, and reset to these. */
export const LATENCY_DEFAULTS = {
  /** Slow when the last 15 minutes' average is this many times the device's usual... */
  factor: 2,
  /** ...and at least this many milliseconds above it. */
  minIncreaseMs: 20,
  /** Slow whatever the usual: an average above this. */
  highMs: 150,
  /** Dropping pings: this share (percent) of the last 15 minutes' pings went unanswered. */
  lossPercent: 10,
} as const;
export type LatencyLimits = { -readonly [K in keyof typeof LATENCY_DEFAULTS]: number };

/** What is judged: the last 15 minutes against the previous 7 days. */
export const WINDOW_MS = 15 * MIN;
export const BASELINE_DAYS = 7;
/** Fewer pings than this in the window say nothing. */
export const MIN_PINGS = 6;
/** A usual time needs at least this many hours with answers behind it. */
export const MIN_BASELINE_HOURS = 24;
/** Several devices at a site slow together are a network problem, not several device problems. */
export const SITE_MIN_DEVICES = 3;
export const SITE_MIN_SHARE = 0.3;
/** Five-minute buckets are kept this long; the hourly rollup is kept for the retention window. */
export const BUCKET_KEEP_DAYS = 7;

export const bucketStart = (t: Date | number, size = 5 * MIN) =>
  new Date(Math.floor(new Date(t).getTime() / size) * size);

// ---- Limits --------------------------------------------------------------------------------------

export async function latencyLimits(
  db: Pick<LatencyDb, 'orgLatencySettings'>,
  orgId: string,
): Promise<{ limits: LatencyLimits; custom: boolean }> {
  const row = await db.orgLatencySettings.findFirst({ where: { orgId } });
  const limits: LatencyLimits = { ...LATENCY_DEFAULTS };
  if (!row) return { limits, custom: false };
  for (const k of Object.keys(limits) as (keyof LatencyLimits)[]) {
    const v = row[k];
    if (typeof v === 'number') limits[k] = v;
  }
  return { limits, custom: true };
}

export async function saveLatencyLimits(
  db: Pick<LatencyDb, 'orgLatencySettings'>,
  orgId: string,
  limits: LatencyLimits,
) {
  // A value equal to the default is stored as "default", so a later change to Kestrel's defaults
  // reaches an organisation that never really chose its own.
  const data = Object.fromEntries(
    (Object.keys(LATENCY_DEFAULTS) as (keyof LatencyLimits)[]).map((k) => [
      k,
      limits[k] === LATENCY_DEFAULTS[k] ? null : limits[k],
    ]),
  );
  const row = await db.orgLatencySettings.findFirst({ where: { orgId } });
  if (row) await db.orgLatencySettings.update({ where: { orgId }, data });
  else await db.orgLatencySettings.create({ data: { orgId, ...data } });
}

export async function resetLatencyLimits(db: Pick<LatencyDb, 'orgLatencySettings'>, orgId: string) {
  await db.orgLatencySettings.deleteMany({ where: { orgId } });
}

// ---- Recording -----------------------------------------------------------------------------------

/** Adds one heartbeat's pings to the device's current 5-minute bucket. */
export async function recordLatency(
  db: Pick<LatencyDb, 'latencyBucket'>,
  device: { id: string; orgId: string; siteId: string },
  l: DeviceLatency,
  now: Date,
): Promise<void> {
  const bucket = bucketStart(now);
  const where = { deviceId: device.id, bucket };
  const sum = (l.avgMs ?? 0) * l.ok;
  const row = await db.latencyBucket.findFirst({ where });
  if (!row) {
    await db.latencyBucket.create({
      data: {
        deviceId: device.id,
        bucket,
        orgId: device.orgId,
        siteId: device.siteId,
        sent: l.sent,
        ok: l.ok,
        sumMs: sum,
        minMs: l.minMs ?? null,
        maxMs: l.maxMs ?? null,
      },
    });
    return;
  }
  await db.latencyBucket.updateMany({
    where,
    data: {
      sent: row.sent + l.sent,
      ok: row.ok + l.ok,
      sumMs: row.sumMs + sum,
      minMs: l.minMs === undefined ? row.minMs : Math.min(row.minMs ?? Infinity, l.minMs),
      maxMs: l.maxMs === undefined ? row.maxMs : Math.max(row.maxMs ?? 0, l.maxMs),
    },
  });
}

interface Sums {
  sent: number;
  ok: number;
  sumMs: number;
  minMs: number | null;
  maxMs: number | null;
}
const empty = (): Sums => ({ sent: 0, ok: 0, sumMs: 0, minMs: null, maxMs: null });
function add(into: Sums, r: Sums) {
  into.sent += r.sent;
  into.ok += r.ok;
  into.sumMs += r.sumMs;
  if (r.minMs !== null) into.minMs = Math.min(into.minMs ?? Infinity, r.minMs);
  if (r.maxMs !== null) into.maxMs = Math.max(into.maxMs ?? 0, r.maxMs);
}
const avgOf = (s: Sums) => (s.ok > 0 ? s.sumMs / s.ok : null);
const lossOf = (s: Sums) => (s.sent > 0 ? ((s.sent - s.ok) / s.sent) * 100 : 0);

/**
 * Builds the hourly rows for the last few complete hours from the 5-minute buckets. Safe to run
 * as often as you like: each hour is rebuilt from its buckets.
 */
export async function rollupHours(db: LatencyDb, now: Date, hours = 6): Promise<number> {
  const end = bucketStart(now, HOUR);
  const start = new Date(end.getTime() - hours * HOUR);
  const rows = await db.latencyBucket.findMany({ where: { bucket: { gte: start, lt: end } } });
  const groups = new Map<string, { row: (typeof rows)[number]; sums: Sums; hour: Date }>();
  for (const r of rows) {
    const hour = bucketStart(r.bucket, HOUR);
    const key = `${r.deviceId}|${hour.getTime()}`;
    const g = groups.get(key) ?? { row: r, sums: empty(), hour };
    add(g.sums, r);
    groups.set(key, g);
  }
  for (const { row, sums, hour } of groups.values()) {
    const where = { deviceId: row.deviceId, bucket: hour };
    const data = { orgId: row.orgId, siteId: row.siteId, ...sums };
    if (await db.latencyHour.findFirst({ where })) await db.latencyHour.updateMany({ where, data });
    else await db.latencyHour.create({ data: { ...where, ...data } });
  }
  return groups.size;
}

// ---- Judging -------------------------------------------------------------------------------------

export type Reason = 'loss' | 'high' | 'trend';

/** Whether the last 15 minutes are a problem, and why. Pure, so it can be tested on its own. */
export function judge(
  recent: Sums,
  baselineMs: number | null,
  limits: LatencyLimits,
): { reason: Reason | null; avgMs: number | null; lossPct: number } {
  const avgMs = avgOf(recent);
  const lossPct = lossOf(recent);
  if (recent.sent < MIN_PINGS) return { reason: null, avgMs, lossPct };
  if (lossPct >= limits.lossPercent) return { reason: 'loss', avgMs, lossPct };
  if (avgMs !== null && avgMs > limits.highMs) return { reason: 'high', avgMs, lossPct };
  if (
    avgMs !== null &&
    baselineMs !== null &&
    avgMs > Math.max(baselineMs * limits.factor, baselineMs + limits.minIncreaseMs)
  )
    return { reason: 'trend', avgMs, lossPct };
  return { reason: null, avgMs, lossPct };
}

export const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const ms = (n: number) => `${Math.round(n)} ms`;

function describe(
  reason: Reason,
  avgMs: number | null,
  lossPct: number,
  baselineMs: number | null,
): string {
  const parts: string[] = [];
  if (avgMs !== null) parts.push(`Average ${ms(avgMs)} over the last 15 minutes`);
  if (reason === 'trend' && baselineMs !== null)
    parts.push(`this device usually answers in about ${ms(baselineMs)}`);
  if (lossPct >= 1) parts.push(`${Math.round(lossPct)}% of pings had no answer`);
  return `${parts.join('; ')}.`;
}

/**
 * Looks at the last 15 minutes of every device that has pings, and opens or resolves incidents:
 * one per slow device, or one for the site when several are slow together.
 */
export async function evaluateLatency(db: LatencyDb, now: Date): Promise<AlertJob[]> {
  const jobs: AlertJob[] = [];
  const push = (j: AlertJob | null) => void (j && jobs.push(j));
  const recentRows = await db.latencyBucket.findMany({
    where: { bucket: { gte: new Date(now.getTime() - WINDOW_MS - 5 * MIN) } },
  });
  // Buckets overlap the window's edge; keeping only those that end inside it is close enough.
  const byDevice = new Map<string, Sums>();
  for (const r of recentRows) {
    if (r.bucket.getTime() + 5 * MIN <= now.getTime() - WINDOW_MS) continue;
    const s = byDevice.get(r.deviceId) ?? empty();
    add(s, r);
    byDevice.set(r.deviceId, s);
  }
  // Devices with an open latency incident are looked at too, so they can be resolved.
  const open = await db.incident.findMany({
    where: { kind: { in: ['latency_high', 'network_degraded'] }, status: 'open' },
  });
  const openDeviceIds = open.flatMap((i) =>
    i.kind === 'latency_high' && i.subject.startsWith('device:') ? [i.subject.slice(7)] : [],
  );
  const ids = [...new Set([...byDevice.keys(), ...openDeviceIds])];
  if (ids.length === 0 && open.length === 0) return jobs;
  const devices = ids.length ? await db.device.findMany({ where: { id: { in: ids } } }) : [];

  const limitsByOrg = new Map<string, LatencyLimits>();
  const limitsOf = async (orgId: string) => {
    if (!limitsByOrg.has(orgId)) limitsByOrg.set(orgId, (await latencyLimits(db, orgId)).limits);
    return limitsByOrg.get(orgId)!;
  };

  // The usual time for each device that could be judged against it.
  const candidates: string[] = [];
  for (const d of devices) {
    const s = byDevice.get(d.id);
    if (
      s &&
      d.online !== false &&
      avgOf(s) !== null &&
      avgOf(s)! > (await limitsOf(d.orgId)).minIncreaseMs
    )
      candidates.push(d.id);
  }
  const baselines = new Map<string, number | null>();
  if (candidates.length) {
    const hourly = await db.latencyHour.findMany({
      where: {
        deviceId: { in: candidates },
        bucket: { gte: new Date(now.getTime() - BASELINE_DAYS * DAY) },
      },
    });
    const perDevice = new Map<string, number[]>();
    for (const h of hourly) {
      // Hours with few answers (a device mostly off) are no basis for a usual time.
      if (h.ok < 10) continue;
      perDevice.set(h.deviceId, [...(perDevice.get(h.deviceId) ?? []), h.sumMs / h.ok]);
    }
    for (const id of candidates) {
      const xs = perDevice.get(id) ?? [];
      baselines.set(id, xs.length >= MIN_BASELINE_HOURS ? median(xs) : null);
    }
  }

  interface Verdict {
    device: (typeof devices)[number];
    reason: Reason | null;
    avgMs: number | null;
    lossPct: number;
    baselineMs: number | null;
  }
  const verdicts: Verdict[] = [];
  for (const d of devices) {
    const s = byDevice.get(d.id);
    // An offline device has its own incident; its missing pings are not a network reading.
    const judged =
      s && d.online !== false
        ? judge(s, baselines.get(d.id) ?? null, await limitsOf(d.orgId))
        : { reason: null, avgMs: null, lossPct: 0 };
    verdicts.push({ device: d, ...judged, baselineMs: baselines.get(d.id) ?? null });
  }

  // A site where several devices are slow together has one incident of its own.
  const bySite = new Map<string, { probed: number; slow: Verdict[] }>();
  for (const v of verdicts) {
    const s = byDevice.get(v.device.id);
    if (!s || s.sent < MIN_PINGS || v.device.online === false) continue;
    const g = bySite.get(v.device.siteId) ?? { probed: 0, slow: [] };
    g.probed++;
    if (v.reason) g.slow.push(v);
    bySite.set(v.device.siteId, g);
  }
  const siteIncidentSites = new Set<string>();
  const siteIds = [
    ...new Set([
      ...bySite.keys(),
      ...open
        .filter((i) => i.kind === 'network_degraded')
        .map((i) => i.subject.replace('site:', '')),
    ]),
  ];
  const sites = siteIds.length
    ? new Map((await db.site.findMany({ where: { id: { in: siteIds } } })).map((s) => [s.id, s]))
    : new Map();
  for (const siteId of siteIds) {
    const g = bySite.get(siteId) ?? { probed: 0, slow: [] };
    const site = sites.get(siteId);
    const orgId = site?.orgId ?? open.find((i) => i.subject === `site:${siteId}`)?.orgId;
    if (!orgId) continue;
    const together =
      g.slow.length >= SITE_MIN_DEVICES && g.slow.length / g.probed >= SITE_MIN_SHARE;
    const key = { orgId, kind: 'network_degraded' as const, subject: `site:${siteId}` };
    if (together) {
      siteIncidentSites.add(siteId);
      const gw = await db.gateway.findFirst({ where: { siteId, orgId } });
      const names = g.slow.slice(0, 5).map((v) => v.device.name);
      push(
        await openIncident(
          db,
          {
            ...key,
            siteId,
            gatewayId: gw?.id ?? null,
            severity: 'warning',
            title: `The network at ${site?.name ?? 'a site'} is slow or dropping pings`,
            detail: `${g.slow.length} of ${g.probed} devices are affected, including ${names.join(', ')}${g.slow.length > 5 ? ' and others' : ''}. Look at the switches and links they share.`,
          },
          now,
        ),
      );
    } else push(await resolveIncident(db, key, now));
  }

  // One incident per slow device, unless the site's own incident already covers them.
  for (const v of verdicts) {
    const key = {
      orgId: v.device.orgId,
      kind: 'latency_high' as const,
      subject: `device:${v.device.id}`,
    };
    if (v.reason && !siteIncidentSites.has(v.device.siteId))
      push(
        await openIncident(
          db,
          {
            ...key,
            roomId: v.device.roomId,
            siteId: v.device.siteId,
            severity: 'warning',
            title:
              v.reason === 'loss'
                ? `${v.device.name} is dropping pings`
                : `${v.device.name} is responding slowly`,
            detail: describe(v.reason, v.avgMs, v.lossPct, v.baselineMs),
          },
          now,
        ),
      );
    else if (!v.reason || siteIncidentSites.has(v.device.siteId))
      push(await resolveIncident(db, key, now));
  }
  return jobs;
}

let lastEvaluate = 0;
let lastRollup = 0;
/** The sweep's share: rolls hours up and judges the last 15 minutes, each at its own pace. */
export async function latencyJob(
  db: LatencyDb,
  now = new Date(),
  every = { evaluateMs: 5 * MIN, rollupMs: 45 * MIN },
): Promise<AlertJob[]> {
  if (now.getTime() - lastRollup >= every.rollupMs) {
    lastRollup = now.getTime();
    await rollupHours(db, now).catch((e: unknown) => console.error('[latency] rollup failed', e));
  }
  if (now.getTime() - lastEvaluate < every.evaluateMs) return [];
  lastEvaluate = now.getTime();
  return evaluateLatency(db, now).catch((e: unknown) => {
    console.error('[latency] evaluation failed', e);
    return [];
  });
}

// ---- Graphs --------------------------------------------------------------------------------------

export type Range = '24h' | '7d' | '30d';
export const RANGE_MS: Record<Range, number> = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };

export interface Point {
  /** Start of the bucket, ISO. */
  t: string;
  avgMs: number | null;
  maxMs: number | null;
  lossPct: number;
  sent: number;
}

const toPoint = (t: Date, s: Sums): Point => ({
  t: t.toISOString(),
  avgMs: avgOf(s) === null ? null : Math.round(avgOf(s)! * 10) / 10,
  maxMs: s.maxMs === null ? null : Math.round(s.maxMs * 10) / 10,
  lossPct: Math.round(lossOf(s) * 10) / 10,
  sent: s.sent,
});

type Where = { deviceId?: string; siteId?: string };

/**
 * Response times over a range: 5-minute points for a day, hourly for longer. The hours not yet
 * rolled up are built from the buckets, so the graph runs up to now.
 */
export async function latencySeries(
  db: Pick<LatencyDb, 'latencyBucket' | 'latencyHour'>,
  orgId: string,
  where: Where,
  range: Range,
  now = new Date(),
): Promise<Point[]> {
  const from = new Date(now.getTime() - RANGE_MS[range]);
  const q = { orgId, ...where, bucket: { gte: from } };
  const group = (rows: (Sums & { bucket: Date })[], size: number) => {
    const m = new Map<number, Sums>();
    for (const r of rows) {
      const k = bucketStart(r.bucket, size).getTime();
      const s = m.get(k) ?? empty();
      add(s, r);
      m.set(k, s);
    }
    return m;
  };
  if (range === '24h') {
    const m = group(await db.latencyBucket.findMany({ where: q }), 5 * MIN);
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, s]) => toPoint(new Date(t), s));
  }
  const hours = group(await db.latencyHour.findMany({ where: q }), HOUR);
  const lastRolled = Math.max(0, ...hours.keys());
  const fresh = (await db.latencyBucket.findMany({ where: q })).filter(
    (r) => bucketStart(r.bucket, HOUR).getTime() > lastRolled,
  );
  for (const [k, s] of group(fresh, HOUR)) hours.set(k, s);
  return [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([t, s]) => toPoint(new Date(t), s));
}

export interface Summary {
  avgMs: number | null;
  maxMs: number | null;
  lossPct: number;
  /** The previous days' usual (median hour), or null before there is a week of it. */
  usualMs: number | null;
  /** How far the last 24 hours are from the usual, in percent. Null when either is unknown. */
  changePct: number | null;
}

/** The last 24 hours against the days before them. */
export async function latencySummary(
  db: Pick<LatencyDb, 'latencyBucket' | 'latencyHour'>,
  orgId: string,
  where: Where,
  now = new Date(),
): Promise<Summary> {
  const day = empty();
  for (const r of await db.latencyBucket.findMany({
    where: { orgId, ...where, bucket: { gte: new Date(now.getTime() - DAY) } },
  }))
    add(day, r);
  const older = await db.latencyHour.findMany({
    where: {
      orgId,
      ...where,
      bucket: {
        gte: new Date(now.getTime() - (BASELINE_DAYS + 1) * DAY),
        lt: new Date(now.getTime() - DAY),
      },
    },
  });
  const perHour = new Map<number, Sums>();
  for (const r of older) {
    const k = r.bucket.getTime();
    const s = perHour.get(k) ?? empty();
    add(s, r);
    perHour.set(k, s);
  }
  const usualMs = median(
    [...perHour.values()].filter((s) => s.ok >= 10).map((s) => s.sumMs / s.ok),
  );
  const avgMs = avgOf(day);
  return {
    avgMs: avgMs === null ? null : Math.round(avgMs * 10) / 10,
    maxMs: day.maxMs === null ? null : Math.round(day.maxMs * 10) / 10,
    lossPct: Math.round(lossOf(day) * 10) / 10,
    usualMs:
      usualMs === null || perHour.size < MIN_BASELINE_HOURS ? null : Math.round(usualMs * 10) / 10,
    changePct:
      avgMs !== null && usualMs !== null && perHour.size >= MIN_BASELINE_HOURS && usualMs > 0
        ? Math.round(((avgMs - usualMs) / usualMs) * 100)
        : null,
  };
}

/** The devices at a site with the worst answers in the last 24 hours (slowest or most lost). */
export async function worstDevices(
  db: Pick<LatencyDb, 'latencyBucket' | 'device' | 'room'>,
  orgId: string,
  siteId: string,
  now = new Date(),
  take = 5,
) {
  const rows = await db.latencyBucket.findMany({
    where: { orgId, siteId, bucket: { gte: new Date(now.getTime() - DAY) } },
  });
  const per = new Map<string, Sums>();
  for (const r of rows) {
    const s = per.get(r.deviceId) ?? empty();
    add(s, r);
    per.set(r.deviceId, s);
  }
  const ranked = [...per.entries()]
    .filter(([, s]) => s.sent >= MIN_PINGS)
    .map(([deviceId, s]) => ({ deviceId, avgMs: avgOf(s), maxMs: s.maxMs, lossPct: lossOf(s) }))
    // Dropped pings first (a lost ping is worse than a slow one), then slowest.
    .sort((a, b) => b.lossPct - a.lossPct || (b.avgMs ?? 0) - (a.avgMs ?? 0))
    .slice(0, take);
  if (ranked.length === 0) return [];
  const devices = await db.device.findMany({
    where: { orgId, id: { in: ranked.map((r) => r.deviceId) } },
  });
  const rooms = await db.room.findMany({
    where: {
      orgId,
      id: { in: devices.flatMap((d) => (d.roomId ? [d.roomId] : [])) },
    },
  });
  return ranked.flatMap((r) => {
    const d = devices.find((x) => x.id === r.deviceId);
    if (!d) return [];
    return [
      {
        deviceId: d.id,
        name: d.name,
        roomId: d.roomId,
        roomName: rooms.find((x) => x.id === d.roomId)?.name ?? null,
        avgMs: r.avgMs === null ? null : Math.round(r.avgMs * 10) / 10,
        maxMs: r.maxMs === null ? null : Math.round(r.maxMs * 10) / 10,
        lossPct: Math.round(r.lossPct * 10) / 10,
      },
    ];
  });
}

/** Deletes buckets past their keep time (the hourly rows go with the main retention window). */
export async function pruneLatency(
  db: Partial<Pick<LatencyDb, 'latencyBucket' | 'latencyHour'>>,
  now: Date,
  days: number,
) {
  // A database without the tables (older tests) has nothing to prune.
  if (!db.latencyBucket || !db.latencyHour) return { buckets: 0, hours: 0 };
  const [b, h] = await Promise.all([
    db.latencyBucket.deleteMany({
      where: { bucket: { lt: new Date(now.getTime() - BUCKET_KEEP_DAYS * DAY) } },
    }),
    db.latencyHour.deleteMany({ where: { bucket: { lt: new Date(now.getTime() - days * DAY) } } }),
  ]);
  return { buckets: b.count, hours: h.count };
}
