import { describe, expect, it } from 'vitest';
import { generateSealKey, seal } from '@kestrel/crypto';
import { clearTokenCache, meetingsBetween, type Deps } from './calendar';
import {
  FRESH_MS,
  REFRESH_AFTER_MS,
  refreshSchedules,
  schedulesForGateway,
  type ScheduleDb,
} from './room-schedule';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '11111111-1111-4111-8111-111111111112';
const GW = '99999999-9999-4999-8999-999999999991';
const ROOM = '33333333-3333-4333-8333-333333333331';
const REL = '44444444-4444-4444-8444-444444444441';
const NOW = new Date('2026-09-28T09:30:00Z');
const key = generateSealKey();
const graph = { tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'shh' };
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function fakeFetch(events: unknown[], provider: 'graph' | 'google' = 'graph', status = 200) {
  const calls: string[] = [];
  const f = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const reply = (body: unknown, code = 200) =>
      new Response(JSON.stringify(body), { status: code });
    if (url.includes('login.microsoftonline.com') || url.includes('oauth2.googleapis.com'))
      return reply({ access_token: 't', expires_in: 3600 });
    if (status !== 200) return reply({}, status);
    return provider === 'graph' ? reply({ value: events }) : reply({ items: events });
  }) as typeof fetch;
  return { f, calls };
}
const deps = (f: typeof fetch): Deps => ({ fetch: f, secretsKey: key });

const graphEvent = (id: string, from: number, to: number, extra: Record<string, unknown> = {}) => ({
  id,
  subject: `Subject ${id}`,
  organizer: { emailAddress: { name: 'Sam Lee', address: 'sam@example.com' } },
  isCancelled: false,
  isAllDay: false,
  sensitivity: 'normal',
  start: { dateTime: at(from).replace('Z', '0000') },
  end: { dateTime: at(to).replace('Z', '0000') },
  ...extra,
});

describe('reading a room’s bookings', () => {
  const creds = { provider: 'graph' as const, ...graph };

  it('reads title, organiser and times from Microsoft 365, in UTC', async () => {
    clearTokenCache();
    const { f, calls } = fakeFetch([graphEvent('a', -10 * 60_000, 20 * 60_000)]);
    const out = await meetingsBetween(
      creds,
      'room@example.com',
      NOW,
      new Date(NOW.getTime() + 3_600_000),
      deps(f),
      NOW.getTime(),
    );
    expect(out).toEqual([
      {
        id: 'a',
        title: 'Subject a',
        organiser: 'Sam Lee',
        start: at(-10 * 60_000),
        end: at(20 * 60_000),
        private: false,
      },
    ]);
    const url = new URL(calls.find((c) => c.includes('calendarView'))!);
    expect(url.searchParams.get('$select')).toContain('sensitivity');
  });

  it('removes the title and organiser of a private meeting before anything leaves', async () => {
    clearTokenCache();
    const { f } = fakeFetch([
      graphEvent('p', 0, 3_600_000, { sensitivity: 'private' }),
      graphEvent('c', 3_600_000, 7_200_000, { sensitivity: 'confidential' }),
    ]);
    const out = await meetingsBetween(
      creds,
      'room@example.com',
      NOW,
      new Date(NOW.getTime() + 9_000_000),
      deps(f),
      NOW.getTime(),
    );
    expect(out).toHaveLength(2);
    for (const m of out) {
      expect(m).toMatchObject({ title: '', private: true });
      expect(m.organiser).toBeUndefined();
    }
    expect(JSON.stringify(out)).not.toContain('Subject');
    expect(JSON.stringify(out)).not.toContain('Sam');
  });

  it('leaves out cancelled and all-day entries', async () => {
    clearTokenCache();
    const { f } = fakeFetch([
      graphEvent('x', 0, 1000, { isCancelled: true }),
      graphEvent('y', 0, 1000, { isAllDay: true }),
      graphEvent('z', 0, 3_600_000),
    ]);
    const out = await meetingsBetween(
      creds,
      'room@example.com',
      NOW,
      new Date(NOW.getTime() + 3_600_000),
      deps(f),
      NOW.getTime(),
    );
    expect(out.map((m) => m.id)).toEqual(['z']);
  });

  it('reads Google Calendar the same way, hiding private events', async () => {
    clearTokenCache();
    const g = {
      provider: 'google' as const,
      clientEmail: 'k@proj.iam.gserviceaccount.com',
      privateKey: 'x'.repeat(60),
    };
    // Signing needs a real key, so use the token path of a fake that never checks it.
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const { f } = fakeFetch(
      [
        {
          id: 'g1',
          summary: 'Board',
          organizer: { displayName: 'Ann', email: 'ann@example.com' },
          start: { dateTime: at(0) },
          end: { dateTime: at(3_600_000) },
        },
        {
          id: 'g2',
          summary: 'Secret',
          visibility: 'private',
          organizer: { email: 'x@example.com' },
          start: { dateTime: at(3_600_000) },
          end: { dateTime: at(7_200_000) },
        },
      ],
      'google',
    );
    const out = await meetingsBetween(
      { ...g, privateKey },
      'room@example.com',
      NOW,
      new Date(NOW.getTime() + 9_000_000),
      deps(f),
      NOW.getTime(),
    );
    expect(out[0]).toMatchObject({ title: 'Board', organiser: 'Ann', private: false });
    expect(out[1]).toMatchObject({ title: '', private: true });
    expect(out[1]!.organiser).toBeUndefined();
  });
});

const calendarTrigger = {
  id: 'meeting',
  type: 'calendar',
  enabled: true,
  provider: 'graph',
  resourceId: 'boardroom@example.com',
};

function world(triggers: unknown[] = [calendarTrigger]) {
  const calendarConnection = table([
    {
      id: 'c1',
      orgId: ORG,
      provider: 'graph',
      name: 'Co',
      sealed: seal(JSON.stringify(graph), key),
    },
  ]);
  const room = table([
    { id: ROOM, orgId: ORG, gatewayId: GW, name: 'Boardroom', desiredReleaseId: REL },
  ]);
  const release = table([{ id: REL, manifest: { manifest: { model: { triggers } } } }]);
  const roomSchedule = table([]);
  return {
    db: { calendarConnection, room, release, roomSchedule } as unknown as ScheduleDb,
    roomSchedule,
    room,
  };
}

describe('keeping the copy', () => {
  it('stores the day’s bookings for a room that has a calendar', async () => {
    clearTokenCache();
    const w = world();
    const { f } = fakeFetch([
      graphEvent('b', 3_600_000, 7_200_000),
      graphEvent('a', -600_000, 600_000),
    ]);
    const res = await refreshSchedules(w.db, NOW, deps(f));
    expect(res).toMatchObject({ checked: 1, fired: 1, errors: [] });
    expect(w.roomSchedule.rows).toHaveLength(1);
    const stored = w.roomSchedule.rows[0]!;
    expect(stored).toMatchObject({ roomId: ROOM, orgId: ORG, fetchedAt: NOW });
    // In start order.
    expect((stored.meetings as { id: string }[]).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('does not read again until the copy is a few minutes old, then replaces it', async () => {
    clearTokenCache();
    const w = world();
    const { f, calls } = fakeFetch([graphEvent('a', 0, 600_000)]);
    await refreshSchedules(w.db, NOW, deps(f));
    const reads = () => calls.filter((c) => c.includes('calendarView')).length;
    expect(reads()).toBe(1);
    await refreshSchedules(w.db, new Date(NOW.getTime() + 60_000), deps(f));
    expect(reads()).toBe(1);
    const later = new Date(NOW.getTime() + REFRESH_AFTER_MS + 1000);
    await refreshSchedules(w.db, later, deps(f));
    expect(reads()).toBe(2);
    expect(w.roomSchedule.rows).toHaveLength(1);
    expect(w.roomSchedule.rows[0]!.fetchedAt).toEqual(later);
  });

  it('keeps the last copy and reports it when the calendar cannot be read', async () => {
    clearTokenCache();
    const w = world();
    await refreshSchedules(w.db, NOW, deps(fakeFetch([graphEvent('a', 0, 600_000)]).f));
    const res = await refreshSchedules(
      w.db,
      new Date(NOW.getTime() + REFRESH_AFTER_MS + 1000),
      deps(fakeFetch([], 'graph', 503).f),
    );
    expect(res.errors).toHaveLength(1);
    expect(w.roomSchedule.rows[0]!.fetchedAt).toEqual(NOW);
  });

  it('skips rooms with no calendar, or with no connection for their provider', async () => {
    clearTokenCache();
    const none = world([]);
    const { f, calls } = fakeFetch([]);
    expect((await refreshSchedules(none.db, NOW, deps(f))).checked).toBe(0);
    const google = world([{ ...calendarTrigger, provider: 'google' }]);
    expect((await refreshSchedules(google.db, NOW, deps(f))).checked).toBe(0);
    expect(calls.filter((c) => c.includes('calendarView'))).toHaveLength(0);
  });

  it('does nothing without a secrets key', async () => {
    const w = world();
    const res = await refreshSchedules(w.db, NOW, { fetch, secretsKey: undefined });
    expect(res.checked).toBe(0);
  });
});

describe('what a gateway is sent', () => {
  const meeting = (id: string, from: number, to: number) => ({
    id,
    title: id,
    start: at(from),
    end: at(to),
    private: false,
  });

  it('sends its own rooms’ recent bookings and drops meetings that are over', async () => {
    const w = world();
    w.roomSchedule.rows.push({
      roomId: ROOM,
      orgId: ORG,
      fetchedAt: NOW,
      meetings: [meeting('over', -7_200_000, -3_600_000), meeting('now', -600_000, 600_000)],
    });
    const out = await schedulesForGateway(w.db, { id: GW, orgId: ORG }, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.meetings.map((m) => m.id)).toEqual(['now']);
  });

  it('sends nothing that is stale, that belongs to another gateway, or to another organisation', async () => {
    const w = world();
    w.roomSchedule.rows.push({
      roomId: ROOM,
      orgId: ORG,
      fetchedAt: new Date(NOW.getTime() - FRESH_MS - 1000),
      meetings: [meeting('x', 0, 600_000)],
    });
    expect(await schedulesForGateway(w.db, { id: GW, orgId: ORG }, NOW)).toEqual([]);
    w.roomSchedule.rows[0]!.fetchedAt = NOW;
    expect(
      await schedulesForGateway(
        w.db,
        { id: '99999999-9999-4999-8999-999999999992', orgId: ORG },
        NOW,
      ),
    ).toEqual([]);
    expect(await schedulesForGateway(w.db, { id: GW, orgId: OTHER_ORG }, NOW)).toEqual([]);
  });

  it('skips a stored copy that is not valid', async () => {
    const w = world();
    w.roomSchedule.rows.push({ roomId: ROOM, orgId: ORG, fetchedAt: NOW, meetings: 'nonsense' });
    expect(await schedulesForGateway(w.db, { id: GW, orgId: ORG }, NOW)).toEqual([]);
  });
});
