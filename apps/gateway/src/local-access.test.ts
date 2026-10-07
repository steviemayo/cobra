import { randomUUID } from 'node:crypto';
import { generateKeyPair, signDocument } from '@kestrel/crypto';
import { LOCAL_ACCESS_PURPOSE, type LocalAccessGrant, type LocalAccessPolicy } from '@kestrel/model';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAccess } from './local-access';
import { silentLogger } from './log';
import { createLocalServer } from './local-server';

const GATEWAY = '99999999-9999-4999-8999-999999999999';
const ORG = '11111111-1111-4111-8111-111111111111';
const keys = generateKeyPair();
const other = generateKeyPair();
const KEY_ID = 'test-key';

describe('signing in to the local page with a Kestrel account', () => {
  let time: number;
  let policy: LocalAccessPolicy;
  let enrolled: boolean;
  let access: LocalAccess;

  beforeEach(() => {
    time = Date.parse('2026-10-07T10:00:00Z');
    policy = { breakGlass: true, epoch: 0 };
    enrolled = true;
    access = new LocalAccess(
      () => ({
        gatewayId: enrolled ? GATEWAY : null,
        keys: [{ keyId: KEY_ID, publicKeyPem: keys.publicKeyPem }],
        policy,
        cloudUrl: 'https://kestrel.example',
      }),
      silentLogger,
      () => time,
    );
  });

  const grantFor = (
    state: string,
    over: Partial<LocalAccessGrant> = {},
    opts: { key?: typeof keys; purpose?: string } = {},
  ) => {
    const nowS = Math.floor(time / 1000);
    const payload: LocalAccessGrant = {
      id: randomUUID(),
      gatewayId: GATEWAY,
      orgId: ORG,
      userId: 'user-1',
      email: 'dev@example.com',
      name: 'Dev Person',
      role: 'admin',
      state,
      issuedAt: nowS,
      expiresAt: nowS + 120,
      epoch: 0,
      ...over,
    };
    const doc = signDocument(opts.purpose ?? LOCAL_ACCESS_PURPOSE, payload, {
      privateKeyPem: (opts.key ?? keys).privateKeyPem,
      keyId: KEY_ID,
    });
    return Buffer.from(JSON.stringify(doc)).toString('base64url');
  };

  const start = () => access.startSignin('10.0.0.9', 'http://10.0.0.5:8080')!;

  it('sends the person to the portal with this gateway, the state and where to come back to', () => {
    const flow = start();
    const url = new URL(flow.url);
    expect(url.origin + url.pathname).toBe('https://kestrel.example/gateway-signin');
    expect(url.searchParams.get('gateway')).toBe(GATEWAY);
    expect(url.searchParams.get('state')).toBe(flow.state);
    expect(url.searchParams.get('return')).toBe('http://10.0.0.5:8080');
  });

  it('opens a session for a good grant, with the role the portal gave', () => {
    const { state } = start();
    const r = access.redeem(grantFor(state, { role: 'viewer' }), state, '10.0.0.9');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.role).toBe('viewer');
      expect(r.session.who).toBe('dev@example.com');
      expect(access.sessionFor(r.session.id)?.who).toBe('dev@example.com');
    }
  });

  it('cannot sign in before the gateway has joined an organisation', () => {
    enrolled = false;
    expect(access.startSignin('10.0.0.9', 'http://x')).toBeNull();
    expect(access.kestrelSigninAvailable()).toBe(false);
    // ...which is when the admin code on the machine is the only way in.
    expect(access.breakGlassAllowed()).toBe(true);
  });

  it('refuses a grant that was not asked for by this browser', () => {
    const { state } = start();
    const g = grantFor(state);
    expect(access.redeem(g, null, 'x')).toMatchObject({ ok: false, reason: 'no_flow' });
    expect(access.redeem(g, 'some-other-state-value-1234', 'x')).toMatchObject({ ok: false });
  });

  it('refuses a grant made for a different sign-in, even from a real flow', () => {
    const mine = start();
    const theirs = start();
    // Signed for `theirs`, presented with the cookie of `mine`.
    const r = access.redeem(grantFor(theirs.state), mine.state, 'x');
    expect(r).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('uses each flow once, so a refused grant cannot be tried again', () => {
    const { state } = start();
    expect(access.redeem('garbage', state, 'x').ok).toBe(false);
    expect(access.redeem(grantFor(state), state, 'x')).toMatchObject({ ok: false, reason: 'no_flow' });
  });

  it('refuses a replayed grant', () => {
    const a = start();
    const id = randomUUID();
    const g = grantFor(a.state, { id });
    expect(access.redeem(g, a.state, 'x').ok).toBe(true);
    const b = start();
    // Same grant id re-signed for a new flow: still the same use.
    expect(access.redeem(grantFor(b.state, { id }), b.state, 'x')).toMatchObject({
      ok: false,
      reason: 'replayed',
    });
  });

  it('refuses a grant signed by a key this gateway does not trust, or for another purpose', () => {
    const a = start();
    expect(access.redeem(grantFor(a.state, {}, { key: other }), a.state, 'x')).toMatchObject({
      ok: false,
    });
    const b = start();
    expect(access.redeem(grantFor(b.state, {}, { purpose: 'pm_report' }), b.state, 'x')).toMatchObject({
      ok: false,
    });
  });

  it('refuses a grant for another gateway, and one that has expired', () => {
    const a = start();
    expect(
      access.redeem(grantFor(a.state, { gatewayId: randomUUID() }), a.state, 'x'),
    ).toMatchObject({ ok: false, reason: 'wrong_gateway' });
    const b = start();
    const g = grantFor(b.state);
    time += 4 * 60_000;
    expect(access.redeem(g, b.state, 'x')).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('refuses a tampered grant', () => {
    const { state } = start();
    const doc = JSON.parse(Buffer.from(grantFor(state), 'base64url').toString()) as {
      payload: { role: string };
    };
    doc.payload.role = 'admin';
    doc.payload = { ...doc.payload, role: 'admin', email: 'attacker@example.com' } as never;
    const forged = Buffer.from(JSON.stringify(doc)).toString('base64url');
    expect(access.redeem(forged, state, 'x')).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('ends sign-ins made before the portal raised its epoch, and refuses old grants', () => {
    const a = start();
    const r = access.redeem(grantFor(a.state), a.state, 'x');
    expect(r.ok).toBe(true);
    const id = r.ok ? r.session.id : '';
    expect(access.sessionFor(id)).not.toBeNull();
    policy = { breakGlass: true, epoch: 1 };
    expect(access.sessionFor(id)).toBeNull();
    const b = start();
    expect(access.redeem(grantFor(b.state, { epoch: 0 }), b.state, 'x')).toMatchObject({
      ok: false,
      reason: 'revoked',
    });
    const c = start();
    expect(access.redeem(grantFor(c.state, { epoch: 1 }), c.state, 'x').ok).toBe(true);
  });

  it('times a session out after half an hour idle and eight hours in all', () => {
    const a = start();
    const r = access.redeem(grantFor(a.state), a.state, 'x');
    const id = r.ok ? r.session.id : '';
    time += 29 * 60_000;
    expect(access.sessionFor(id)).not.toBeNull();
    time += 29 * 60_000;
    expect(access.sessionFor(id)).not.toBeNull();
    time += 31 * 60_000;
    expect(access.sessionFor(id)).toBeNull();

    const b = start();
    const r2 = access.redeem(grantFor(b.state), b.state, 'x');
    const id2 = r2.ok ? r2.session.id : '';
    for (let i = 0; i < 16; i++) {
      time += 29 * 60_000;
      expect(access.sessionFor(id2)).not.toBeNull();
    }
    time += 29 * 60_000;
    expect(access.sessionFor(id2)).toBeNull();
  });

  it('switches the admin code off when the organisation says so, and ends code sessions', () => {
    const s = access.openWithCode('10.0.0.9');
    expect(s?.role).toBe('admin');
    policy = { breakGlass: false, epoch: 0 };
    expect(access.sessionFor(s!.id)).toBeNull();
    expect(access.openWithCode('10.0.0.9')).toBeNull();
    expect(access.breakGlassAllowed()).toBe(false);
    // An unenrolled gateway can always be reached from the machine, whatever the last policy said.
    enrolled = false;
    expect(access.breakGlassAllowed()).toBe(true);
  });
});

describe('the local page routes for signing in', () => {
  let app: FastifyInstance;
  let time: number;
  const gateway = {
    status: vi.fn(),
    enrolWithToken: vi.fn(),
    reset: vi.fn(),
    record: vi.fn(),
  };
  let access: LocalAccess;

  beforeEach(async () => {
    time = Date.parse('2026-10-07T10:00:00Z');
    vi.clearAllMocks();
    gateway.status.mockReturnValue({
      version: '1.0.0',
      cloudHost: 'kestrel.example',
      installId: 'abc',
      enrolment: 'enrolled',
      name: 'Site gateway',
      lastContactAt: new Date(time).toISOString(),
      problem: null,
      bufferedEvents: 0,
      devices: 2,
      update: null,
    });
    access = new LocalAccess(
      () => ({
        gatewayId: GATEWAY,
        keys: [{ keyId: KEY_ID, publicKeyPem: keys.publicKeyPem }],
        policy: { breakGlass: true, epoch: 0 },
        cloudUrl: 'https://kestrel.example',
      }),
      silentLogger,
      () => time,
    );
    app = await createLocalServer({
      log: silentLogger,
      admin: { gateway, log: silentLogger, adminCode: 'ABCD-2345', access, now: () => time },
    });
  });
  afterEach(async () => {
    await app.close();
  });

  async function signIn(role: 'admin' | 'viewer') {
    const go = await app.inject({ url: '/signin', headers: { host: '10.0.0.5:8080' } });
    expect(go.statusCode).toBe(303);
    const target = new URL(String(go.headers.location));
    expect(target.origin).toBe('https://kestrel.example');
    expect(target.searchParams.get('return')).toBe('http://10.0.0.5:8080');
    const flowCookie = String(go.headers['set-cookie']).split(';')[0]!;
    expect(String(go.headers['set-cookie'])).toContain('HttpOnly');
    const state = target.searchParams.get('state')!;
    const nowS = Math.floor(time / 1000);
    const doc = signDocument(
      LOCAL_ACCESS_PURPOSE,
      {
        id: randomUUID(),
        gatewayId: GATEWAY,
        orgId: ORG,
        userId: 'u1',
        email: 'owner@example.com',
        name: null,
        role,
        state,
        issuedAt: nowS,
        expiresAt: nowS + 120,
        epoch: 0,
      } satisfies LocalAccessGrant,
      { privateKeyPem: keys.privateKeyPem, keyId: KEY_ID },
    );
    const grant = Buffer.from(JSON.stringify(doc)).toString('base64url');
    const back = await app.inject({
      url: `/auth/callback?grant=${grant}`,
      headers: { cookie: flowCookie },
    });
    return { back, flowCookie, grant };
  }

  it('lets a signed-in owner in and records who did', async () => {
    const { back } = await signIn('admin');
    expect(back.statusCode).toBe(303);
    expect(back.headers.location).toBe('/');
    const cookies = ([] as string[]).concat(back.headers['set-cookie'] as string[]);
    const session = cookies.find((c) => c.startsWith('kestrel_gw='))!;
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
    const page = await app.inject({ url: '/admin', headers: { cookie: session.split(';')[0]! } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('owner@example.com');
    expect(gateway.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'local.signin', data: expect.objectContaining({ who: 'owner@example.com' }) }),
    );
  });

  it('shows a viewer the status but not the admin page', async () => {
    const { back } = await signIn('viewer');
    const cookies = ([] as string[]).concat(back.headers['set-cookie'] as string[]);
    const cookie = cookies.find((c) => c.startsWith('kestrel_gw='))!.split(';')[0]!;
    const status = await app.inject({ url: '/', headers: { cookie } });
    expect(status.body).toContain('Site gateway');
    expect(status.body).toContain('view only');
    const admin = await app.inject({ url: '/admin', headers: { cookie } });
    expect(admin.statusCode).toBe(403);
    const reset = await app.inject({
      method: 'POST',
      url: '/admin/reset',
      payload: 'confirm=RESET',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(reset.statusCode).toBe(303);
    expect(gateway.reset).not.toHaveBeenCalled();
  });

  it('will not accept the same grant link twice, or without the browser that started it', async () => {
    const { back, flowCookie, grant } = await signIn('admin');
    expect(back.statusCode).toBe(303);
    const again = await app.inject({
      url: `/auth/callback?grant=${grant}`,
      headers: { cookie: flowCookie },
    });
    expect(again.headers.location).toBe('/?msg=signin_failed');
    const noCookie = await app.inject({ url: `/auth/callback?grant=${grant}` });
    expect(noCookie.headers.location).toBe('/?msg=signin_failed');
  });

  it('shows strangers nothing but whether it works', async () => {
    const page = await app.inject({ url: '/' });
    expect(page.body).toContain('Connected to Kestrel');
    expect(page.body).toContain('Sign in with Kestrel');
    expect(page.body).not.toContain('Site gateway');
    expect(page.body).not.toContain('1.0.0');
  });
});
