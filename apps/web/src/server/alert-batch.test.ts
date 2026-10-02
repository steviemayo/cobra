import { describe, expect, it } from 'vitest';
import { deliverBatched, planGroups, queueAlerts } from './alert-batch';
import type { AlertDb, Senders } from './alerts';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const GW = '44444444-4444-4444-8444-444444444444';
const T0 = new Date('2026-10-02T10:00:00Z');
const room = (n: number) => `33333333-3333-4333-8333-33333333333${n}`;
const inc = (n: number, roomN: number | null, extra: Record<string, unknown> = {}) => ({
  id: `77777777-7777-4777-8777-77777777777${n}`,
  orgId: ORG,
  roomId: roomN === null ? null : room(roomN),
  roomIds: [],
  gatewayId: GW,
  kind: 'device_offline',
  severity: 'warning',
  title: `Device ${n} is offline`,
  detail: null,
  openedAt: T0,
  resolvedAt: null,
  acknowledgedAt: null,
  ...extra,
});

function world(incidents: ReturnType<typeof inc>[], rooms = 4) {
  const alertChannel = table([
    {
      id: 'c0',
      orgId: ORG,
      enabled: true,
      minSeverity: 'warning',
      type: 'webhook',
      config: { url: 'https://hooks.example.com/x' },
    },
  ]);
  const alertDelivery = table([]);
  interface Body {
    event: string;
    incident: { title: string; severity: string; room: string | null };
    batch?: { count: number };
  }
  const calls: { url: string; body: Body }[] = [];
  const s: Senders = {
    fetch: (async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) as Body });
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
    resolve: async () => ['93.184.216.34'],
    env: {},
  };
  const db = {
    alertChannel,
    alertDelivery,
    incident: table(incidents),
    room: table(
      Array.from({ length: rooms }, (_, i) => ({
        id: room(i + 1),
        orgId: ORG,
        siteId: SITE,
        name: `Room ${i + 1}`,
      })),
    ),
    site: table([{ id: SITE, orgId: ORG, name: 'Sydney HQ' }]),
  } as unknown as AlertDb;
  return { db, s, calls, alertDelivery };
}

const opened = (...ns: number[]) =>
  ns.map((n) => ({ incidentId: inc(n, null).id, event: 'opened' as const }));

describe('batched alerts', () => {
  it('sends a problem on its own exactly as before', async () => {
    const w = world([inc(1, 1)]);
    await deliverBatched(w.db, opened(1), w.s, T0);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.body.incident.title).toBe('Device 1 is offline');
    expect(w.calls[0]!.body.batch).toBeUndefined();
  });

  it('tells several problems in one room as one message and records each', async () => {
    const w = world([inc(1, 1), inc(2, 1, { severity: 'critical' }), inc(3, 1)]);
    await deliverBatched(w.db, opened(1, 2, 3), w.s, T0);
    expect(w.calls).toHaveLength(1);
    const body = w.calls[0]!.body;
    expect(body.incident).toMatchObject({
      title: 'Room 1: 3 problems',
      severity: 'critical',
      room: 'Room 1',
    });
    expect(body.batch?.count).toBe(3);
    expect(w.alertDelivery.rows.map((r) => r.status).sort()).toEqual([
      'batched',
      'batched',
      'sent',
    ]);
  });

  it('keeps rooms apart until enough rooms at one site have trouble', async () => {
    const two = world([inc(1, 1), inc(2, 2)]);
    await deliverBatched(two.db, opened(1, 2), two.s, T0);
    expect(two.calls).toHaveLength(2);

    const three = world([inc(1, 1), inc(2, 2), inc(3, 3)]);
    await deliverBatched(three.db, opened(1, 2, 3), three.s, T0);
    expect(three.calls).toHaveLength(1);
    expect(three.calls[0]!.body.incident.title).toBe('Sydney HQ: 3 problems in 3 rooms');
  });

  it('tells recoveries together too', async () => {
    const w = world([
      inc(1, 1, { status: 'resolved', resolvedAt: T0 }),
      inc(2, 1, { status: 'resolved', resolvedAt: T0 }),
    ]);
    // The channel has been told of both, one by one, earlier.
    await deliverBatched(
      w.db,
      [1, 2].map((n) => ({ incidentId: inc(n, null).id, event: 'resolved' as const })),
      w.s,
      T0,
    );
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.body).toMatchObject({
      event: 'resolved',
      incident: { title: 'Room 1: 2 problems' },
    });
  });

  it('collects jobs from separate requests into one send', async () => {
    const w = world([inc(1, 1), inc(2, 1)]);
    const windows = { critical: 20, normal: 20 };
    await Promise.all([
      queueAlerts(w.db, opened(1), w.s, windows),
      queueAlerts(w.db, opened(2), w.s, windows),
    ]);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.body.batch?.count).toBe(2);
  });

  it('plans one group of one for anything left alone', async () => {
    const w = world([inc(1, null, { gatewayId: null })]);
    const groups = await planGroups(w.db, await w.db.incident.findMany({}));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.incidents).toHaveLength(1);
  });
});
