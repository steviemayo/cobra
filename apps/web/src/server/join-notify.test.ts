import { describe, expect, it } from 'vitest';
import { notifyJoinRequest, type JoinNotifyDb } from './join-notify';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const event = { orgId: ORG, orgName: 'Acme', requesterEmail: 'carol@acme.com' };

interface Call {
  url: string;
  body: Record<string, unknown>;
}
function fakeFetch(status = 200) {
  const calls: Call[] = [];
  const f = (async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
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
const world = (channels: Record<string, unknown>[], members: Record<string, unknown>[] = []) =>
  ({ alertChannel: table(channels), member: table(members) }) as unknown as JoinNotifyDb;

const EMAIL_ENV = {
  RESEND_API_KEY: 'key',
  ALERT_FROM_EMAIL: 'Kestrel <no-reply@example.com>',
  NEXT_PUBLIC_APP_URL: 'https://app.example.com',
};

describe('telling owners about a request to join', () => {
  it('posts to the organisation’s Teams channel with who asked and a link to the Team page', async () => {
    const { f, calls } = fakeFetch();
    const db = world([
      { orgId: ORG, enabled: true, type: 'teams', config: { url: 'https://hooks.example.com/t' } },
    ]);
    const sent = await notifyJoinRequest(db, event, deps(f, { NEXT_PUBLIC_APP_URL: 'https://app.example.com' }));
    expect(sent).toBe(1);
    expect(calls[0]!.body.text).toBe(
      `carol@acme.com (same company email domain) asked to join Acme on Kestrel\nApprove or decline it under Team.\nhttps://app.example.com/o/${ORG}/team`,
    );
    expect(calls[0]!.body).toMatchObject({
      event: 'member.join_request',
      requester: { email: 'carol@acme.com' },
    });
  });

  it('emails each owner directly, and only owners', async () => {
    const { f, calls } = fakeFetch();
    const db = world(
      [],
      [
        { orgId: ORG, role: 'owner', email: 'alice@acme.com' },
        { orgId: ORG, role: 'owner', email: 'bob@acme.com' },
        { orgId: ORG, role: 'dev', email: 'dev@acme.com' },
      ],
    );
    const sent = await notifyJoinRequest(db, event, deps(f, EMAIL_ENV));
    expect(sent).toBe(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.body.to).toEqual(['alice@acme.com', 'bob@acme.com']);
    expect(String(calls[0]!.body.subject)).toContain('carol@acme.com');
  });

  it('quietly sends nothing when email is not set up and there are no channels', async () => {
    const { f, calls } = fakeFetch();
    const db = world([], [{ orgId: ORG, role: 'owner', email: 'alice@acme.com' }]);
    expect(await notifyJoinRequest(db, event, deps(f))).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('carries on past a channel that fails', async () => {
    const { f, calls } = fakeFetch(500);
    const db = world(
      [{ orgId: ORG, enabled: true, type: 'webhook', config: { url: 'https://hooks.example.com/w' } }],
      [{ orgId: ORG, role: 'owner', email: 'alice@acme.com' }],
    );
    const sent = await notifyJoinRequest(db, event, deps(f, EMAIL_ENV));
    expect(sent).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it('skips disabled channels', async () => {
    const { f, calls } = fakeFetch();
    const db = world([
      { orgId: ORG, enabled: false, type: 'teams', config: { url: 'https://hooks.example.com/t' } },
    ]);
    expect(await notifyJoinRequest(db, event, deps(f))).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
