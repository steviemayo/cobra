import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateSealKey, seal } from '@kestrel/crypto';
import {
  CalendarCredentials,
  clearTokenCache,
  LOOKAHEAD_MS,
  LOOKBACK_MS,
  meetingsStarting,
  pollCalendars,
  testCredentials,
  type CalendarDb,
  type Deps,
} from './calendar';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const GW = '99999999-9999-4999-8999-999999999991';
const ROOM = '33333333-3333-4333-8333-333333333331';
const REL = '44444444-4444-4444-8444-444444444441';
const NOW = new Date('2026-09-24T08:30:20Z');
const key = generateSealKey();
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

beforeEach(clearTokenCache);

const graph = {
  provider: 'graph' as const,
  tenantId: 'tenant-1',
  clientId: 'client-1',
  clientSecret: 'shh',
};
const google = {
  provider: 'google' as const,
  clientEmail: 'kestrel@proj.iam.gserviceaccount.com',
  privateKey,
};

interface Call {
  url: string;
  init?: RequestInit;
}
function fakeFetch(handlers: {
  graphEvents?: unknown[];
  googleEvents?: unknown[];
  tokenStatus?: number;
}) {
  const calls: Call[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes('login.microsoftonline.com'))
      return handlers.tokenStatus
        ? reply({}, handlers.tokenStatus)
        : reply({ access_token: 'graph-token', expires_in: 3600 });
    if (url.includes('oauth2.googleapis.com'))
      return handlers.tokenStatus
        ? reply({}, handlers.tokenStatus)
        : reply({ access_token: 'google-token', expires_in: 3600 });
    if (url.includes('graph.microsoft.com')) return reply({ value: handlers.graphEvents ?? [] });
    if (url.includes('googleapis.com/calendar'))
      return reply({ items: handlers.googleEvents ?? [] });
    return reply({}, 404);
  }) as typeof fetch;
  return { f, calls };
}
const deps = (f: typeof fetch): Deps => ({ fetch: f, secretsKey: key });

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const graphEvent = (id: string, offsetMs: number, extra: Record<string, unknown> = {}) => ({
  id,
  isCancelled: false,
  isAllDay: false,
  start: { dateTime: at(offsetMs).replace('Z', '0000') },
  ...extra,
});
const window = () =>
  [new Date(NOW.getTime() - LOOKBACK_MS), new Date(NOW.getTime() + LOOKAHEAD_MS)] as const;

describe('reading calendars', () => {
  it('reads Microsoft 365 meetings with an app-only token, and treats the times as UTC', async () => {
    const { f, calls } = fakeFetch({
      graphEvents: [
        graphEvent('a', -20_000),
        graphEvent('gone', -20_000, { isCancelled: true }),
        graphEvent('allday', -20_000, { isAllDay: true }),
      ],
    });
    const [from, to] = window();
    const out = await meetingsStarting(
      graph,
      'boardroom@example.com',
      from,
      to,
      deps(f),
      NOW.getTime(),
    );
    expect(out.map((e) => e.id)).toEqual(['a']);
    expect(out[0]!.start.toISOString()).toBe(at(-20_000));
    const token = calls.find((c) => c.url.includes('login.microsoftonline.com'))!;
    expect(String(token.init!.body)).toContain('grant_type=client_credentials');
    expect(String(token.init!.body)).toContain('client_secret=shh');
    const view = calls.find((c) => c.url.includes('/calendarView'))!;
    expect(view.url).toContain('users/boardroom%40example.com/calendarView');
    expect((view.init!.headers as Record<string, string>).authorization).toBe('Bearer graph-token');
  });

  it('reads Google Calendar with a signed service-account assertion', async () => {
    const { f, calls } = fakeFetch({
      googleEvents: [
        { id: 'g1', status: 'confirmed', start: { dateTime: at(-10_000) } },
        { id: 'g2', status: 'cancelled', start: { dateTime: at(-10_000) } },
        { id: 'g3', start: { date: '2026-09-24' } },
      ],
    });
    const [from, to] = window();
    const out = await meetingsStarting(
      google,
      'room@group.calendar.google.com',
      from,
      to,
      deps(f),
      NOW.getTime() + 1000,
    );
    expect(out.map((e) => e.id)).toEqual(['g1']);
    const body = new URLSearchParams(
      String(calls.find((c) => c.url.includes('oauth2.googleapis.com'))!.init!.body),
    );
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, sig] = body.get('assertion')!.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toMatchObject({
      iss: google.clientEmail,
      aud: 'https://oauth2.googleapis.com/token',
    });
    const valid = createVerify('RSA-SHA256')
      .update(`${h}.${c}`)
      .verify(createPublicKey(publicKey), Buffer.from(sig!, 'base64url'));
    expect(valid).toBe(true);
  });

  it('reports sign-in problems in words', async () => {
    const { f } = fakeFetch({ tokenStatus: 401 });
    await expect(testCredentials(graph, deps(f))).rejects.toThrow(
      'Microsoft sign-in answered HTTP 401',
    );
    await expect(testCredentials(google, deps(f))).rejects.toThrow(
      'Google sign-in answered HTTP 401',
    );
  });

  it('checks credentials before they are accepted', () => {
    expect(CalendarCredentials.safeParse(graph).success).toBe(true);
    expect(CalendarCredentials.safeParse({ ...graph, clientSecret: '' }).success).toBe(false);
    expect(
      CalendarCredentials.safeParse({ provider: 'google', clientEmail: 'not-an-email', privateKey })
        .success,
    ).toBe(false);
    expect(CalendarCredentials.safeParse({ provider: 'other' }).success).toBe(false);
  });
});

function world(triggers: unknown[], creds: unknown = graph) {
  const { provider, ...secret } = creds as { provider: string };
  const calendarConnection = table([
    { id: 'c1', orgId: ORG, provider, name: 'Company', sealed: seal(JSON.stringify(secret), key) },
  ]);
  const calendarFire = table([]);
  // The in-memory table reports a duplicate the way the database does.
  const create = calendarFire.create;
  calendarFire.create = async (args: { data: Record<string, unknown> }) => {
    const d = args.data;
    const dup = calendarFire.rows.some(
      (r) => r.roomId === d.roomId && r.triggerId === d.triggerId && r.eventKey === d.eventKey,
    );
    if (dup) throw Object.assign(new Error('unique'), { code: 'P2002' });
    return create(args);
  };
  const room = table([
    { id: ROOM, orgId: ORG, gatewayId: GW, name: 'Boardroom', desiredReleaseId: REL },
  ]);
  const release = table([{ id: REL, manifest: { manifest: { model: { triggers } } } }]);
  const controlIntent = table([]);
  const auditLog = table([]);
  return {
    db: {
      calendarConnection,
      calendarFire,
      room,
      release,
      controlIntent,
      auditLog,
    } as unknown as CalendarDb,
    calendarFire,
    controlIntent,
    room,
  };
}
const trig = (over: Record<string, unknown> = {}) => ({
  id: 'meeting',
  type: 'calendar',
  enabled: true,
  provider: 'graph',
  resourceId: 'boardroom@example.com',
  run: { type: 'activity', activityId: 'present' },
  ...over,
});

describe('calendar trigger job', () => {
  it('starts a room whose meeting has just begun, once, however often it looks', async () => {
    const w = world([trig()]);
    const { f } = fakeFetch({ graphEvents: [graphEvent('m1', -15_000)] });
    const first = await pollCalendars(w.db, NOW, deps(f));
    expect(first).toMatchObject({ checked: 1, fired: 1, errors: [] });
    expect(w.controlIntent.rows[0]).toMatchObject({
      gatewayId: GW,
      roomId: ROOM,
      intent: { type: 'trigger', triggerId: 'meeting' },
    });
    const again = await pollCalendars(w.db, new Date(NOW.getTime() + 20_000), deps(f));
    expect(again.fired).toBe(0);
    expect(w.controlIntent.rows).toHaveLength(1);
  });

  it('starts a meeting that began between runs, but not one long over or a long way off', async () => {
    const w = world([trig()]);
    const { f } = fakeFetch({
      graphEvents: [
        graphEvent('recent', -2 * 60_000),
        graphEvent('old', -20 * 60_000),
        graphEvent('later', 10 * 60_000),
      ],
    });
    const res = await pollCalendars(w.db, NOW, deps(f));
    expect(res.fired).toBe(1);
    expect(w.calendarFire.rows[0]!.eventKey).toContain('recent@');
  });

  it('treats a rescheduled meeting as a new one', async () => {
    const w = world([trig()]);
    await pollCalendars(w.db, NOW, deps(fakeFetch({ graphEvents: [graphEvent('m1', -15_000)] }).f));
    const later = new Date(NOW.getTime() + 60 * 60_000);
    const moved = graphEvent('m1', 60 * 60_000 - 15_000);
    expect(
      (await pollCalendars(w.db, later, deps(fakeFetch({ graphEvents: [moved] }).f))).fired,
    ).toBe(1);
  });

  it('ignores disabled triggers, providers without a connection, and rooms with no gateway', async () => {
    const { f, calls } = fakeFetch({ graphEvents: [graphEvent('m1', -15_000)] });
    const disabled = world([trig({ enabled: false })]);
    expect((await pollCalendars(disabled.db, NOW, deps(f))).checked).toBe(0);
    const wrong = world([trig({ provider: 'google' })]);
    expect((await pollCalendars(wrong.db, NOW, deps(f))).checked).toBe(0);
    expect(calls).toHaveLength(0);
    const noGateway = world([trig()]);
    noGateway.room.rows[0]!.gatewayId = null;
    expect((await pollCalendars(noGateway.db, NOW, deps(f))).checked).toBe(0);
  });

  it('reports a calendar it cannot read, and does nothing without the secrets key', async () => {
    const w = world([trig()]);
    const broken = fakeFetch({ tokenStatus: 500 });
    const res = await pollCalendars(w.db, NOW, deps(broken.f));
    expect(res.fired).toBe(0);
    expect(res.errors[0]).toContain('Microsoft sign-in answered HTTP 500');
    expect(await pollCalendars(w.db, NOW, { ...deps(broken.f), secretsKey: undefined })).toEqual({
      checked: 0,
      fired: 0,
      errors: [],
    });
  });

  it('works for Google rooms too, with credentials that only this server can open', async () => {
    const w = world(
      [trig({ provider: 'google', resourceId: 'room@group.calendar.google.com' })],
      google,
    );
    const { f } = fakeFetch({ googleEvents: [{ id: 'g1', start: { dateTime: at(-5_000) } }] });
    expect((await pollCalendars(w.db, NOW, deps(f))).fired).toBe(1);
    const wrongKey = await pollCalendars(w.db, NOW, { fetch: f, secretsKey: generateSealKey() });
    expect(wrongKey.errors[0]).toContain('could not be read');
  });
});
