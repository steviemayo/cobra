import { describe, expect, it } from 'vitest';
import {
  notifyOrg,
  notifyStaff,
  parseAddresses,
  type NotifyDb,
  type TicketEvent,
} from './ticket-notify';
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
const publicDns = async () => ['93.184.216.34'];
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

describe('email', () => {
  const mail = { RESEND_API_KEY: 'key', ALERT_FROM_EMAIL: 'kestrel@example.com' };
  const sentMail = (calls: Call[]) =>
    calls.filter((c) => c.url === 'https://api.resend.com/emails');

  it('reads a list of addresses, keeping the good ones', () => {
    expect(parseAddresses('a@b.test, c@d.test;e@f.test,  ,not-an-address,a@b.test')).toEqual([
      'a@b.test',
      'c@d.test',
      'e@f.test',
    ]);
    expect(parseAddresses(undefined)).toEqual([]);
    expect(parseAddresses('x@y.test,\nz@y.test')).toEqual(['x@y.test', 'z@y.test']);
    expect(
      parseAddresses(Array.from({ length: 30 }, (_, i) => `p${i}@y.test`).join(',')),
    ).toHaveLength(10);
  });

  it('an escalation emails the staff address, with a readable subject and a link', async () => {
    const { f, calls } = fakeFetch();
    const ok = await notifyStaff(
      event,
      deps(f, {
        ...mail,
        STAFF_TICKET_EMAIL: 'support@kestrel.test, oncall@kestrel.test',
        NEXT_PUBLIC_APP_URL: 'https://app.example.com',
      }),
    );
    expect(ok).toBe(true);
    const [m] = sentMail(calls);
    expect(m!.headers.authorization).toBe('Bearer key');
    expect(m!.body).toMatchObject({
      from: 'kestrel@example.com',
      to: ['support@kestrel.test', 'oncall@kestrel.test'],
      subject: '[Kestrel] Acme escalated a ticket to Kestrel (high): Room 2 will not start',
    });
    expect(String(m!.body.text)).toContain('https://app.example.com/staff/tickets/tkt-1');
  });

  it('sends to the webhook and the email address both when both are set', async () => {
    const { f, calls } = fakeFetch();
    await notifyStaff(
      event,
      deps(f, {
        ...mail,
        STAFF_TICKET_EMAIL: 'support@kestrel.test',
        STAFF_TICKET_WEBHOOK_URL: 'https://hooks.example.com/staff',
      }),
    );
    expect(calls.map((c) => c.url)).toEqual([
      'https://hooks.example.com/staff',
      'https://api.resend.com/emails',
    ]);
  });

  it('quietly does nothing when email is not set up on the server, or no address is given', async () => {
    const a = fakeFetch();
    expect(
      await notifyStaff(event, deps(a.f, { STAFF_TICKET_EMAIL: 'support@kestrel.test' })),
    ).toBe(false);
    const b = fakeFetch();
    expect(await notifyStaff(event, deps(b.f, mail))).toBe(false);
    expect(a.calls.length + b.calls.length).toBe(0);
  });

  it('a failing email service does not stop the webhook, and never throws', async () => {
    const calls: string[] = [];
    const f = (async (url: URL | string) => {
      calls.push(String(url));
      return new Response(null, { status: String(url).includes('resend') ? 500 : 200 });
    }) as typeof fetch;
    const ok = await notifyStaff(
      event,
      deps(f, {
        ...mail,
        STAFF_TICKET_EMAIL: 'support@kestrel.test',
        STAFF_TICKET_WEBHOOK_URL: 'https://hooks.example.com/staff',
      }),
    );
    expect(ok).toBe(true); // the webhook got through
    expect(calls).toHaveLength(2);
    const onlyEmail = await notifyStaff(
      event,
      deps(f, { ...mail, STAFF_TICKET_EMAIL: 'support@kestrel.test' }),
    );
    expect(onlyEmail).toBe(false);
  });

  it('a subject cannot be split across lines by a ticket title', async () => {
    const { f, calls } = fakeFetch();
    await notifyStaff(
      { ...event, ticket: { ...event.ticket, title: 'Line one\r\nBcc: attacker@evil.test' } },
      deps(f, { ...mail, STAFF_TICKET_EMAIL: 'support@kestrel.test' }),
    );
    expect(String(sentMail(calls)[0]!.body.subject)).not.toMatch(/[\r\n]/);
  });

  it('an organisation’s own email channel is told about Kestrel’s reply, with the other channels', async () => {
    const world = () => {
      const alertChannel = table([
        {
          id: 'e1',
          orgId: ORG,
          type: 'email',
          enabled: true,
          config: { to: ['ops@acme.test', 'bad', 'it@acme.test'] },
        },
        { id: 'e2', orgId: ORG, type: 'email', enabled: false, config: { to: ['off@acme.test'] } },
        {
          id: 'e3',
          orgId: 'other',
          type: 'email',
          enabled: true,
          config: { to: ['them@other.test'] },
        },
        {
          id: 't1',
          orgId: ORG,
          type: 'teams',
          enabled: true,
          config: { url: 'https://teams.example.com/h' },
        },
      ]);
      return { alertChannel, org: table([]) } as unknown as NotifyDb;
    };
    const { f, calls } = fakeFetch();
    const sent = await notifyOrg(world(), { ...event, kind: 'staff_reply' }, deps(f, mail));
    expect(sent).toBe(2);
    const [m] = sentMail(calls);
    expect(m!.body.to).toEqual(['ops@acme.test', 'it@acme.test']);
    expect(m!.body.subject).toBe('[Kestrel] Kestrel support replied to “Room 2 will not start”');
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain('them@other.test');
    // Without email set up on the server, an email channel is skipped and the rest still go out.
    const again = fakeFetch();
    expect(await notifyOrg(world(), event, deps(again.f))).toBe(1);
  });
});
