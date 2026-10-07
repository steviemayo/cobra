import { describe, expect, it } from 'vitest';
import { generateKeyPair, verifyDocument } from '@kestrel/crypto';
import { LOCAL_ACCESS_PURPOSE, LocalAccessGrant } from '@kestrel/model';
import { checkSignin, issueGrant, localRoleFor, type SigninDb } from './gateway-signin';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const MSP = '33333333-3333-4333-8333-333333333333';
const SITE = '22222222-2222-4222-8222-222222222222';
const OTHER_SITE = '55555555-5555-4555-8555-555555555555';
const GW = '99999999-9999-4999-8999-999999999999';
const STATE = 'state-state-state-state-1234';
const keys = generateKeyPair();
const signing = { keyId: 'k1', privateKeyPem: keys.privateKeyPem, publicKeyPem: keys.publicKeyPem };

function world(over: { members?: Record<string, unknown>[]; grants?: Record<string, unknown>[]; localUrls?: string[]; deletedAt?: Date | null } = {}) {
  const member = table(over.members ?? [{ orgId: ORG, userId: 'u1', role: 'dev' }]);
  const mspGrant = table(over.grants ?? []);
  const auditLog = table([]);
  const orgs = [
    { id: ORG, name: 'Acme', gatewayLocalEpoch: 3 },
    { id: MSP, name: 'Provider Co', gatewayLocalEpoch: 0 },
  ];
  const gateway = {
    findFirst: async ({ where }: { where: { id: string } }) =>
      where.id === GW
        ? {
            id: GW,
            name: 'Level 2 gateway',
            orgId: ORG,
            siteId: SITE,
            localUrls: over.localUrls ?? ['http://10.0.0.5:8080', 'https://gw01.corp.example:8080'],
            org: { name: 'Acme', deletedAt: over.deletedAt ?? null },
            site: { name: 'Head office' },
          }
        : null,
  };
  const org = {
    findFirst: async ({ where }: { where: { id: string } }) => orgs.find((o) => o.id === where.id) ?? null,
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      orgs.filter((o) => where.id.in.includes(o.id)),
  };
  return { db: { gateway, member, mspGrant, org, auditLog } as unknown as SigninDb, auditLog };
}

const req = (over: Partial<{ gatewayId: string; state: string; returnOrigin: string }> = {}) => ({
  gatewayId: GW,
  state: STATE,
  returnOrigin: 'http://10.0.0.5:8080',
  ...over,
});

describe('who may sign in to a gateway', () => {
  it('maps owners and developers to admin and everyone else to viewer', () => {
    expect(localRoleFor('owner')).toBe('admin');
    expect(localRoleFor('dev')).toBe('admin');
    expect(localRoleFor('support')).toBe('viewer');
    expect(localRoleFor('customer_viewer')).toBe('viewer');
  });

  it('lets a member in, with their role', async () => {
    const { db } = world();
    const r = await checkSignin(db, 'u1', req());
    expect(r).toMatchObject({ ok: true, role: 'admin', returnOrigin: 'http://10.0.0.5:8080' });
  });

  it('refuses someone who is not in the gateway’s organisation', async () => {
    const { db } = world();
    expect(await checkSignin(db, 'stranger', req())).toEqual({ ok: false, reason: 'not_a_member' });
  });

  it('lets a service provider in through its grant, but only for the sites it covers', async () => {
    const grants = [
      { mspOrgId: MSP, customerOrgId: ORG, status: 'active', role: 'manage', siteIds: [SITE] },
    ];
    const members = [{ orgId: MSP, userId: 'pro', role: 'support' }];
    const { db } = world({ members, grants });
    expect(await checkSignin(db, 'pro', req())).toMatchObject({ ok: true });
    const scoped = world({
      members,
      grants: [{ mspOrgId: MSP, customerOrgId: ORG, status: 'active', role: 'manage', siteIds: [OTHER_SITE] }],
    });
    expect(await checkSignin(scoped.db, 'pro', req())).toEqual({ ok: false, reason: 'not_a_member' });
  });

  it('only sends a person back to an address the gateway reported', async () => {
    const { db } = world();
    expect(await checkSignin(db, 'u1', req({ returnOrigin: 'https://evil.example' }))).toEqual({
      ok: false,
      reason: 'bad_return',
    });
    // Same host, different port or scheme, is a different origin.
    expect(await checkSignin(db, 'u1', req({ returnOrigin: 'http://10.0.0.5:9090' }))).toMatchObject({ ok: false });
    expect(await checkSignin(db, 'u1', req({ returnOrigin: 'https://10.0.0.5:8080' }))).toMatchObject({ ok: false });
    expect(await checkSignin(db, 'u1', req({ returnOrigin: 'https://gw01.corp.example:8080' }))).toMatchObject({ ok: true });
  });

  it('refuses a link with anything odd in it', async () => {
    const { db } = world();
    for (const bad of [
      req({ state: 'short' }),
      req({ state: 'has spaces and is long enough ok' }),
      req({ gatewayId: 'not-a-uuid' }),
      req({ returnOrigin: 'javascript:alert(1)' }),
      req({ returnOrigin: 'http://user:pass@10.0.0.5:8080' }),
      req({ returnOrigin: '' }),
    ])
      expect(await checkSignin(db, 'u1', bad)).toEqual({ ok: false, reason: 'bad_request' });
  });

  it('refuses an unknown gateway and one in an organisation being deleted', async () => {
    const { db } = world();
    expect(
      await checkSignin(db, 'u1', req({ gatewayId: '00000000-0000-4000-8000-000000000000' })),
    ).toEqual({ ok: false, reason: 'unknown_gateway' });
    const gone = world({ deletedAt: new Date() });
    expect(await checkSignin(gone.db, 'u1', req())).toEqual({ ok: false, reason: 'unknown_gateway' });
  });
});

describe('the grant', () => {
  const user = { id: 'u1', email: 'dev@acme.example', name: 'Dev Person' };

  it('is signed with this key, for this gateway and sign-in, and short-lived', async () => {
    const { db } = world();
    const now = new Date('2026-10-07T10:00:00Z');
    const r = await issueGrant(db, signing, user, req(), now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const url = new URL(r.url);
    expect(url.origin).toBe('http://10.0.0.5:8080');
    expect(url.pathname).toBe('/auth/callback');
    const doc = JSON.parse(Buffer.from(url.searchParams.get('grant')!, 'base64url').toString());
    const checked = verifyDocument(doc, LOCAL_ACCESS_PURPOSE, [{ keyId: 'k1', publicKeyPem: keys.publicKeyPem }]);
    expect(checked.ok).toBe(true);
    const grant = LocalAccessGrant.parse(doc.payload);
    expect(grant).toMatchObject({
      gatewayId: GW,
      orgId: ORG,
      userId: 'u1',
      email: 'dev@acme.example',
      role: 'admin',
      state: STATE,
      epoch: 3,
    });
    expect(grant.expiresAt - grant.issuedAt).toBe(120);
    // Not valid for any other purpose.
    expect(verifyDocument(doc, 'pm_report', [{ keyId: 'k1', publicKeyPem: keys.publicKeyPem }]).ok).toBe(false);
  });

  it('is recorded in the audit trail', async () => {
    const w = world();
    await issueGrant(w.db, signing, user, req());
    expect(w.auditLog.rows).toHaveLength(1);
    expect(w.auditLog.rows[0]).toMatchObject({
      orgId: ORG,
      actorId: 'u1',
      action: 'gateway.local_signin',
      target: GW,
    });
  });

  it('is never made when the checks fail', async () => {
    const w = world();
    const r = await issueGrant(w.db, signing, { ...user, id: 'stranger' }, req());
    expect(r.ok).toBe(false);
    expect(w.auditLog.rows).toHaveLength(0);
  });
});
