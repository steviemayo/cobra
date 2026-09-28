import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_NOT_IN_PLAN,
  MAX_ALERTS_PER_CHANNEL_HOUR,
  MAX_EMAIL_ALERTS_PER_ORG_PER_DAY,
  deliverAlerts,
  deliverToChannel,
  type AlertDb,
  type AlertMessage,
  type Senders,
} from './alerts';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const ROOM = '33333333-3333-4333-8333-333333333331';
const INC = '77777777-7777-4777-8777-777777777771';
const T0 = new Date('2026-09-24T10:00:00Z');

const publicDns = async () => ['93.184.216.34'];
function senders(status = 200, env: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const s: Senders = {
    fetch: (async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('{}', { status });
    }) as typeof fetch,
    resolve: publicDns,
    env,
  };
  return { s, calls };
}

const msg: AlertMessage = {
  event: 'opened',
  incident: {
    id: INC,
    kind: 'device_offline',
    severity: 'warning',
    title: 'DSP is offline',
    detail: 'DSP in Boardroom has not answered.',
    room: 'Boardroom',
    openedAt: T0.toISOString(),
    resolvedAt: null,
  },
  portalUrl: 'https://kestrel.example/o/x/incidents',
};

function world(channels: Record<string, unknown>[] = [], severity = 'warning') {
  const alertChannel = table(
    channels.map((c, i) => ({
      id: `c${i}`,
      orgId: ORG,
      enabled: true,
      minSeverity: 'warning',
      ...c,
    })),
  );
  const alertDelivery = table([]);
  const incident = table([
    {
      id: INC,
      orgId: ORG,
      roomId: ROOM,
      kind: 'device_offline',
      severity,
      title: 'DSP is offline',
      detail: 'x',
      openedAt: T0,
      resolvedAt: null,
    },
  ]);
  const room = table([{ id: ROOM, orgId: ORG, name: 'Boardroom' }]);
  return {
    db: { alertChannel, alertDelivery, incident, room } as unknown as AlertDb,
    alertChannel,
    alertDelivery,
  };
}


describe('delivery', () => {
  it('signs webhooks so the receiver can check they came from Kestrel', async () => {
    const w = world([
      {
        type: 'webhook',
        config: { url: 'https://hooks.example.com/kestrel', secret: 'topsecret1' },
      },
    ]);
    const { s, calls } = senders();
    await deliverAlerts(w.db, [{ incidentId: INC, event: 'opened' }], s, T0);
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    const body = String(calls[0]!.init.body);
    const expected = createHmac('sha256', 'topsecret1')
      .update(`${headers['x-kestrel-timestamp']}.${body}`)
      .digest('hex');
    expect(headers['x-kestrel-signature']).toBe(`sha256=${expected}`);
    expect(JSON.parse(body)).toMatchObject({
      event: 'opened',
      incident: { title: 'DSP is offline', room: 'Boardroom' },
    });
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(w.alertDelivery.rows[0]).toMatchObject({
      status: 'sent',
      event: 'opened',
      incidentId: INC,
    });
  });

  it('posts an adaptive card to Teams', async () => {
    const w = world([{ type: 'teams', config: { url: 'https://example.webhook.office.com/x' } }]);
    const { s, calls } = senders();
    await deliverAlerts(w.db, [{ incidentId: INC, event: 'resolved' }], s, T0);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(JSON.stringify(body)).toContain('Resolved: DSP is offline');
  });

  it('sends email through the configured provider, and skips it when email is not set up', async () => {
    const w = world([{ type: 'email', config: { to: ['ops@example.com'] } }]);
    const on = senders(200, { RESEND_API_KEY: 'k', ALERT_FROM_EMAIL: 'alerts@example.com' });
    await deliverAlerts(w.db, [{ incidentId: INC, event: 'opened' }], on.s, T0);
    expect(on.calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(String(on.calls[0]!.init.body))).toMatchObject({
      to: ['ops@example.com'],
      subject: '[Kestrel] DSP is offline',
    });
    expect(w.alertDelivery.rows[0]!.status).toBe('sent');

    const off = senders();
    await deliverAlerts(w.db, [{ incidentId: INC, event: 'opened' }], off.s, T0);
    expect(off.calls).toHaveLength(0);
    expect(w.alertDelivery.rows[1]).toMatchObject({ status: 'skipped' });
  });

  it('treats the ITSM channel as a placeholder until it has an address', async () => {
    const w = world([{ type: 'itsm', config: { system: 'servicenow' } }]);
    const { s, calls } = senders();
    await deliverAlerts(w.db, [{ incidentId: INC, event: 'opened' }], s, T0);
    expect(calls).toHaveLength(0);
    expect(w.alertDelivery.rows[0]!.status).toBe('skipped');

    const w2 = world([
      { type: 'itsm', config: { system: 'servicenow', url: 'https://desk.example.com/api' } },
    ]);
    await deliverAlerts(w2.db, [{ incidentId: INC, event: 'opened' }], s, T0);
    expect(JSON.parse(String(calls[0]!.init.body)).ticket).toMatchObject({
      urgency: 2,
      state: 'new',
      correlation_id: INC,
    });
  });

  it('skips a channel the plan does not allow, and never sends to it', async () => {
    const w = world([
      { type: 'email', config: { to: ['ops@example.com'] } },
      { type: 'teams', config: { url: 'https://teams.example.com/x' } },
    ]);
    const { s, calls } = senders(200, {
      RESEND_API_KEY: 'k',
      ALERT_FROM_EMAIL: 'alerts@example.com',
    });
    // Basic: email only.
    const basic = {
      ...s,
      allowed: async (_db: unknown, _org: string, type: string) => type === 'email',
    };
    await deliverAlerts(w.db, [{ incidentId: INC, event: 'opened' }], basic, T0);
    expect(w.alertDelivery.rows.map((d) => d.status)).toEqual(['sent', 'skipped']);
    expect(w.alertDelivery.rows[1]!.error).toBe(CHANNEL_NOT_IN_PLAN);
    expect(calls.filter((c) => String(c.url).includes('teams.example.com'))).toHaveLength(0);
  });

  it('records failures, including destinations that refuse and destinations that are not allowed', async () => {
    const w = world([
      { type: 'webhook', config: { url: 'https://hooks.example.com/x' } },
      { type: 'webhook', config: { url: 'https://10.0.0.5/x' } },
    ]);
    await deliverAlerts(w.db, [{ incidentId: INC, event: 'opened' }], senders(500).s, T0);
    expect(w.alertDelivery.rows.map((d) => d.status)).toEqual(['failed', 'failed']);
    expect(w.alertDelivery.rows[0]!.error).toContain('HTTP 500');
    expect(w.alertDelivery.rows[1]!.error).toContain('public');
  });

  it('only alerts channels whose minimum severity the incident reaches, and skips disabled ones', async () => {
    const w = world(
      [
        { type: 'webhook', config: { url: 'https://a.example.com/x' }, minSeverity: 'critical' },
        { type: 'webhook', config: { url: 'https://b.example.com/x' }, minSeverity: 'info' },
        { type: 'webhook', config: { url: 'https://c.example.com/x' }, enabled: false },
      ],
      'warning',
    );
    const { s, calls } = senders();
    await deliverAlerts(w.db, [{ incidentId: INC, event: 'opened' }], s, T0);
    expect(calls.map((c) => c.url)).toEqual(['https://b.example.com/x']);
  });

  it('caps how many alerts one channel sends an hour', async () => {
    const w = world([{ type: 'webhook', config: { url: 'https://hooks.example.com/x' } }]);
    for (let i = 0; i < MAX_ALERTS_PER_CHANNEL_HOUR; i++)
      w.alertDelivery.rows.push({
        channelId: 'c0',
        status: 'sent',
        at: new Date(T0.getTime() - 60_000),
      });
    const { s, calls } = senders();
    await deliverAlerts(w.db, [{ incidentId: INC, event: 'opened' }], s, T0);
    expect(calls).toHaveLength(0);
    expect(w.alertDelivery.rows.at(-1)).toMatchObject({ status: 'suppressed' });
  });

  it('caps how many alert emails one organisation sends a day, across every email channel it has', async () => {
    // c1 is nowhere near its own hourly cap; the org's other email channel (c0) has already used
    // up the daily one, spread out enough that c0 is not over its own hourly cap either.
    const w = world([
      { type: 'email', config: { to: ['ops@acme.test'] } },
      { type: 'email', config: { to: ['it@acme.test'] } },
    ]);
    for (let i = 0; i < MAX_EMAIL_ALERTS_PER_ORG_PER_DAY; i++)
      w.alertDelivery.rows.push({
        channelId: 'c0',
        // Spread across the last ~23 hours, at most a handful per hour, so c0 stays under its own
        // hourly cap while the org-wide total for the day is exactly at the daily one.
        at: new Date(T0.getTime() - 3_600_000 - i * 400_000),
        status: 'sent',
      });
    const { s, calls } = senders(200, { RESEND_API_KEY: 'k', ALERT_FROM_EMAIL: 'alerts@kestrel.example' });
    const ch = w.alertChannel.rows[1] as { id: string; orgId: string; type: string; config: unknown };
    expect(await deliverToChannel(w.db, ch, msg, null, s, T0)).toEqual({ status: 'suppressed' });
    expect(calls).toHaveLength(0);
    expect(w.alertDelivery.rows.at(-1)).toMatchObject({
      status: 'suppressed',
      error: expect.stringContaining('organisation'),
    });
  });

  it('does not let an email channel’s test send bypass the daily cap', async () => {
    const w = world([{ type: 'email', config: { to: ['ops@acme.test'] } }]);
    for (let i = 0; i < MAX_EMAIL_ALERTS_PER_ORG_PER_DAY; i++)
      w.alertDelivery.rows.push({ channelId: 'c0', status: 'sent', at: T0 });
    const { s, calls } = senders(200, { RESEND_API_KEY: 'k', ALERT_FROM_EMAIL: 'alerts@kestrel.example' });
    const ch = w.alertChannel.rows[0] as { id: string; orgId: string; type: string; config: unknown };
    expect(await deliverToChannel(w.db, ch, { ...msg, event: 'test' }, null, s, T0)).toEqual({
      status: 'suppressed',
    });
    expect(calls).toHaveLength(0);
  });

  it('does not count a webhook or Teams channel’s sends against another organisation’s email cap', async () => {
    const w = world([
      { type: 'webhook', config: { url: 'https://hooks.example.com/x' } },
      { type: 'email', config: { to: ['ops@acme.test'] } },
    ]);
    // The webhook channel is well past what would be the email cap, if it were shared.
    for (let i = 0; i < MAX_EMAIL_ALERTS_PER_ORG_PER_DAY + 10; i++)
      w.alertDelivery.rows.push({ channelId: 'c0', status: 'sent', at: new Date(T0.getTime() - 60_000) });
    const { s } = senders(200, { RESEND_API_KEY: 'k', ALERT_FROM_EMAIL: 'alerts@kestrel.example' });
    const ch = w.alertChannel.rows[1] as { id: string; orgId: string; type: string; config: unknown };
    expect((await deliverToChannel(w.db, ch, msg, null, s, T0)).status).toBe('sent');
  });

  it('never throws, and test messages ignore the hourly cap', async () => {
    const w = world([{ type: 'webhook', config: { url: 'https://hooks.example.com/x' } }]);
    for (let i = 0; i < MAX_ALERTS_PER_CHANNEL_HOUR; i++)
      w.alertDelivery.rows.push({ channelId: 'c0', status: 'sent', at: T0 });
    const { s } = senders();
    const ch = w.alertChannel.rows[0] as {
      id: string;
      orgId: string;
      type: string;
      config: unknown;
    };
    expect(await deliverToChannel(w.db, ch, { ...msg, event: 'test' }, null, s, T0)).toEqual({
      status: 'sent',
    });
    const broken = { ...s, fetch: vi.fn().mockRejectedValue(new Error('socket hang up')) };
    expect(
      (await deliverToChannel(w.db, ch, { ...msg, event: 'test' }, null, broken, T0)).status,
    ).toBe('failed');
  });

  it('marks a channel with corrupt settings as failed instead of crashing', async () => {
    const w = world([{ type: 'webhook', config: { nope: true } }]);
    await deliverAlerts(w.db, [{ incidentId: INC, event: 'opened' }], senders().s, T0);
    expect(w.alertDelivery.rows[0]).toMatchObject({ status: 'failed' });
  });
});
