import { describe, expect, it } from 'vitest';
import { notifyOrg, notifyStaff, type NotifyDb, type TicketEvent } from './ticket-notify';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const event: TicketEvent = {
  kind: 'escalated',
  orgId: ORG,
  orgName: 'Acme',
  ticket: { id: 'tkt-1', title: 'Room 2 will not start', priority: 'high', status: 'open' },
  snippet: 'The displays stay black\n after   power on',
};

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}
function fakeFetch(status = 200) {
  const calls: Call[] = [];
  const f = (async (url: URL | string, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    return new Response(null, { status });
  }) as typeof fetch;
  return { f, calls };
}
const publicDns = async () => ['203.0.113.10'];
const deps = (f: typeof fetch, env: Record<string, string | undefined> = {}) => ({
  fetch: f,
  resolve: publicDns,
  env,
});

describe('telling Kestrel staff', () => {
  it('posts to the staff webhook with a readable message and a link', async () => {
    const { f, calls } = fakeFetch();
    const ok = await notifyStaff(
      event,
      deps(f, {
        STAFF_TICKET_WEBHOOK_URL: 'https://hooks.example.com/staff',
        NEXT_PUBLIC_APP_URL: 'https://app.example.com',
      }),
    );
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.text).toBe(
      'Acme escalated a ticket to Kestrel (high): Room 2 will not start\nThe displays stay black after power on\nhttps://app.example.com/staff/tickets/tkt-1',
    );
    expect(calls[0]!.body).toMatchObject({
      event: 'ticket.escalated',
      organisation: { name: 'Acme' },
    });
  });

  it('does nothing when no staff webhook is set', async () => {
    const { f, calls } = fakeFetch();
    expect(await notifyStaff(event, deps(f))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('never throws when the destination fails or is not a public address', async () => {
    const bad = fakeFetch(500);
    expect(
      await notifyStaff(
        event,
        deps(bad.f, { STAFF_TICKET_WEBHOOK_URL: 'https://hooks.example.com/x' }),
      ),
    ).toBe(false);
    const priv = fakeFetch();
    expect(
      await notifyStaff(event, {
        fetch: priv.f,
        resolve: async () => ['10.0.0.5'],
        env: { STAFF_TICKET_WEBHOOK_URL: 'https://internal.example.com/x' },
      }),
    ).toBe(false);
    expect(priv.calls).toHaveLength(0);
  });
});

describe('telling the organisation', () => {
  const world = () => {
    const alertChannel = table([
      {
        id: 'c1',
        orgId: ORG,
        type: 'teams',
        enabled: true,
        config: { url: 'https://teams.example.com/h' },
      },
      {
        id: 'c2',
        orgId: ORG,
        type: 'webhook',
        enabled: true,
        config: { url: 'https://hook.example.com/h', secret: 'supersecret1' },
      },
      { id: 'c3', orgId: ORG, type: 'email', enabled: true, config: { to: ['a@b.test'] } },
      {
        id: 'c4',
        orgId: ORG,
        type: 'teams',
        enabled: false,
        config: { url: 'https://teams.example.com/off' },
      },
      {
        id: 'c5',
        orgId: 'other',
        type: 'teams',
        enabled: true,
        config: { url: 'https://teams.example.com/other' },
      },
    ]);
    return { alertChannel, org: table([]) } as unknown as NotifyDb;
  };

  it('reaches only its own enabled Teams and webhook channels', async () => {
    const { f, calls } = fakeFetch();
    const sent = await notifyOrg(
      world(),
      { ...event, kind: 'staff_reply' },
      deps(f, { NEXT_PUBLIC_APP_URL: 'https://app.example.com' }),
    );
    expect(sent).toBe(2);
    expect(calls.map((c) => c.url)).toEqual([
      'https://teams.example.com/h',
      'https://hook.example.com/h',
    ]);
    expect(calls[0]!.body.text).toContain('Kestrel support replied to “Room 2 will not start”');
    expect(calls[0]!.body.url).toBe(`https://app.example.com/o/${ORG}/tickets/tkt-1`);
  });

  it('signs a webhook that has a secret, and only that one', async () => {
    const { f, calls } = fakeFetch();
    await notifyOrg(world(), event, deps(f));
    expect(calls[0]!.headers['x-kestrel-signature']).toBeUndefined();
    expect(calls[1]!.headers['x-kestrel-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('keeps going when one channel fails', async () => {
    let n = 0;
    const flaky = (async () =>
      new Response(null, { status: n++ === 0 ? 500 : 200 })) as typeof fetch;
    expect(await notifyOrg(world(), event, deps(flaky))).toBe(1);
  });
});
