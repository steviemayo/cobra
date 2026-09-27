import { describe, expect, it } from 'vitest';
import {
  SignupError,
  attachTrialClaim,
  cancelRequest,
  claimTrial,
  decideRequest,
  findSimilar,
  myRequests,
  pendingRequests,
  personOf,
  releaseTrialClaim,
  requestToJoin,
  type Person,
  type SignupDb,
} from './org-signup';
import { table } from './test-db';

const NOW = new Date('2026-09-27T00:00:00Z');
const DAY = 86_400_000;

const ACME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'; // customer owned by alice@acme.com
const ACME_MSP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'; // provider owned by alice@acme.com
const GMAILER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'; // customer owned by someone on gmail
const OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'; // "Acme Audio", owned by bob@other.com
const ALICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const CAROL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
const DAVE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4';

const person = (userId: string, email: string, emailConfirmed = true): Person => ({
  userId,
  email,
  emailConfirmed,
});

function world() {
  let n = 0;
  const org = table([
    { id: ACME, name: 'Acme AV Pty Ltd', kind: 'customer', createdAt: new Date(NOW.getTime() + 1) },
    { id: ACME_MSP, name: 'Acme Services', kind: 'msp', createdAt: new Date(NOW.getTime() + 2) },
    { id: GMAILER, name: 'Sam Events', kind: 'customer', createdAt: new Date(NOW.getTime() + 3) },
    { id: OTHER, name: 'Acme Audio', kind: 'customer', createdAt: new Date(NOW.getTime() + 4) },
  ]);
  const member = table([
    { id: 'm1', orgId: ACME, userId: ALICE, email: 'alice@acme.com', role: 'owner' },
    { id: 'm2', orgId: ACME_MSP, userId: ALICE, email: 'alice@acme.com', role: 'owner' },
    { id: 'm3', orgId: GMAILER, userId: DAVE, email: 'sam@gmail.com', role: 'owner' },
    { id: 'm4', orgId: OTHER, userId: BOB, email: 'bob@other.com', role: 'owner' },
  ]);
  const joinRequest = table([]);
  const create = joinRequest.create;
  joinRequest.create = async (args: { data: Record<string, unknown> }) =>
    create({ data: { id: `r${++n}`, status: 'pending', ...args.data } });
  const trialClaim = table([]);
  const auditLog = table([]);
  const db = { org, member, joinRequest, trialClaim, auditLog } as unknown as SignupDb;
  return { db, org, member, joinRequest, trialClaim, auditLog };
}

describe('finding an organisation that may already be theirs', () => {
  it('lists colleagues’ organisations of the same kind by company domain', async () => {
    const { db } = world();
    const r = await findSimilar(db, {
      name: 'Anything',
      kind: 'customer',
      person: person(CAROL, 'carol@acme.com'),
    });
    expect(r.colleagues).toEqual([{ id: ACME, name: 'Acme AV Pty Ltd', requested: false }]);
  });

  it('keeps providers and customers apart', async () => {
    const { db } = world();
    const r = await findSimilar(db, {
      name: 'Anything',
      kind: 'msp',
      person: person(CAROL, 'carol@acme.com'),
    });
    expect(r.colleagues.map((c) => c.id)).toEqual([ACME_MSP]);
  });

  it('never matches on a free mail domain', async () => {
    const { db } = world();
    const r = await findSimilar(db, {
      name: 'Anything',
      kind: 'customer',
      person: person(CAROL, 'carol@gmail.com'),
    });
    expect(r.colleagues).toEqual([]);
  });

  it('ignores an address that is not confirmed', async () => {
    const { db } = world();
    const r = await findSimilar(db, {
      name: 'Anything',
      kind: 'customer',
      person: person(CAROL, 'carol@acme.com', false),
    });
    expect(r.colleagues).toEqual([]);
  });

  it('leaves out organisations the person already belongs to', async () => {
    const { db } = world();
    const r = await findSimilar(db, {
      name: 'Anything',
      kind: 'customer',
      person: person(ALICE, 'alice@acme.com'),
    });
    expect(r.colleagues).toEqual([]);
  });

  it('marks a colleague’s organisation the person has already asked to join', async () => {
    const { db, joinRequest } = world();
    await joinRequest.create({ data: { orgId: ACME, userId: CAROL, email: 'carol@acme.com' } });
    const r = await findSimilar(db, {
      name: 'Anything',
      kind: 'customer',
      person: person(CAROL, 'carol@acme.com'),
    });
    expect(r.colleagues[0]?.requested).toBe(true);
  });

  it('warns about a similar name without revealing which organisation', async () => {
    const { db } = world();
    const r = await findSimilar(db, {
      name: 'ACME  Audio, Inc.',
      kind: 'customer',
      person: person(CAROL, 'carol@gmail.com'),
    });
    expect(r).toEqual({ colleagues: [], similarName: true });
  });

  it('does not warn for a different name', async () => {
    const { db } = world();
    const r = await findSimilar(db, {
      name: 'Acme Lighting',
      kind: 'customer',
      person: person(CAROL, 'carol@gmail.com'),
    });
    expect(r.similarName).toBe(false);
  });
});

describe('asking to join', () => {
  it('lets a colleague ask, and records it', async () => {
    const { db, joinRequest, auditLog } = world();
    const r = await requestToJoin(db, { person: person(CAROL, 'Carol@Acme.com'), orgId: ACME }, NOW);
    expect(r).toMatchObject({ created: true, orgName: 'Acme AV Pty Ltd' });
    expect(joinRequest.rows).toHaveLength(1);
    expect(joinRequest.rows[0]).toMatchObject({ email: 'carol@acme.com', status: 'pending' });
    expect(auditLog.rows[0]).toMatchObject({ orgId: ACME, action: 'member.join_request' });
  });

  it('refuses someone from another company, with nothing about the organisation', async () => {
    const { db } = world();
    await expect(
      requestToJoin(db, { person: person(CAROL, 'carol@elsewhere.com'), orgId: ACME }, NOW),
    ).rejects.toThrow('You can’t ask to join that organisation.');
  });

  it('refuses a free mail address, an unconfirmed one and an unknown organisation the same way', async () => {
    const { db } = world();
    for (const [p, orgId] of [
      [person(CAROL, 'carol@gmail.com'), GMAILER],
      [person(CAROL, 'carol@acme.com', false), ACME],
      [person(CAROL, 'carol@acme.com'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaff'],
    ] as const)
      await expect(requestToJoin(db, { person: p, orgId }, NOW)).rejects.toThrow(
        'You can’t ask to join that organisation.',
      );
  });

  it('does not notify twice for the same waiting request', async () => {
    const { db, joinRequest } = world();
    const p = person(CAROL, 'carol@acme.com');
    const first = await requestToJoin(db, { person: p, orgId: ACME }, NOW);
    const second = await requestToJoin(db, { person: p, orgId: ACME }, NOW);
    expect(second).toMatchObject({ id: first.id, created: false });
    expect(joinRequest.rows).toHaveLength(1);
  });

  it('refuses someone who is already a member', async () => {
    const { db } = world();
    await expect(
      requestToJoin(db, { person: person(ALICE, 'alice@acme.com'), orgId: ACME }, NOW),
    ).rejects.toThrow('already a member');
  });

  it('blocks a new request for 30 days after a decline, then allows it', async () => {
    const { db } = world();
    const p = person(CAROL, 'carol@acme.com');
    const r = await requestToJoin(db, { person: p, orgId: ACME }, NOW);
    await decideRequest(db, { orgId: ACME, requestId: r.id, by: ALICE, decision: { approve: false } }, NOW);
    await expect(
      requestToJoin(db, { person: p, orgId: ACME }, new Date(NOW.getTime() + 5 * DAY)),
    ).rejects.toThrow('declined your request recently');
    const later = await requestToJoin(db, { person: p, orgId: ACME }, new Date(NOW.getTime() + 31 * DAY));
    expect(later.created).toBe(true);
  });

  it('limits how many organisations one person can ask in a day', async () => {
    const { db, org, member } = world();
    for (let i = 0; i < 6; i++) {
      org.rows.push({ id: `org-${i}`, name: `Org ${i}`, kind: 'customer' });
      member.rows.push({ orgId: `org-${i}`, userId: ALICE, email: 'alice@acme.com', role: 'owner' });
    }
    const p = person(CAROL, 'carol@acme.com');
    for (let i = 0; i < 5; i++)
      await requestToJoin(db, { person: p, orgId: `org-${i}` }, NOW);
    await expect(requestToJoin(db, { person: p, orgId: 'org-5' }, NOW)).rejects.toThrow(
      'several requests today',
    );
    // A day later it works again.
    await expect(
      requestToJoin(db, { person: p, orgId: 'org-5' }, new Date(NOW.getTime() + DAY + 1)),
    ).resolves.toMatchObject({ created: true });
  });
});

describe('deciding a request', () => {
  it('approving adds the person at the chosen role', async () => {
    const { db, member, joinRequest, auditLog } = world();
    const r = await requestToJoin(db, { person: person(CAROL, 'carol@acme.com'), orgId: ACME }, NOW);
    await decideRequest(
      db,
      { orgId: ACME, requestId: r.id, by: ALICE, decision: { approve: true, role: 'support' } },
      NOW,
    );
    expect(member.rows.find((m) => m.userId === CAROL)).toMatchObject({
      orgId: ACME,
      role: 'support',
      email: 'carol@acme.com',
    });
    expect(joinRequest.rows[0]).toMatchObject({ status: 'approved', role: 'support', decidedBy: ALICE });
    expect(auditLog.rows.map((a) => a.action)).toContain('member.join_approve');
  });

  it('declining adds nobody', async () => {
    const { db, member, joinRequest } = world();
    const r = await requestToJoin(db, { person: person(CAROL, 'carol@acme.com'), orgId: ACME }, NOW);
    await decideRequest(db, { orgId: ACME, requestId: r.id, by: ALICE, decision: { approve: false } }, NOW);
    expect(member.rows.some((m) => m.userId === CAROL)).toBe(false);
    expect(joinRequest.rows[0]).toMatchObject({ status: 'declined' });
  });

  it('cannot decide a request twice or one from another organisation', async () => {
    const { db } = world();
    const r = await requestToJoin(db, { person: person(CAROL, 'carol@acme.com'), orgId: ACME }, NOW);
    await expect(
      decideRequest(db, { orgId: OTHER, requestId: r.id, by: BOB, decision: { approve: false } }),
    ).rejects.toBeInstanceOf(SignupError);
    await decideRequest(db, { orgId: ACME, requestId: r.id, by: ALICE, decision: { approve: false } });
    await expect(
      decideRequest(db, { orgId: ACME, requestId: r.id, by: ALICE, decision: { approve: true, role: 'dev' } }),
    ).rejects.toBeInstanceOf(SignupError);
  });

  it('lists only waiting requests for the organisation', async () => {
    const { db } = world();
    await requestToJoin(db, { person: person(CAROL, 'carol@acme.com'), orgId: ACME }, NOW);
    const done = await requestToJoin(db, { person: person(DAVE, 'dave@acme.com'), orgId: ACME }, NOW);
    await decideRequest(db, { orgId: ACME, requestId: done.id, by: ALICE, decision: { approve: false } });
    expect(await pendingRequests(db, ACME)).toMatchObject([{ email: 'carol@acme.com' }]);
    expect(await pendingRequests(db, OTHER)).toEqual([]);
  });
});

describe('a person’s own requests', () => {
  it('can be withdrawn only by the person who made them', async () => {
    const { db } = world();
    const r = await requestToJoin(db, { person: person(CAROL, 'carol@acme.com'), orgId: ACME }, NOW);
    await expect(cancelRequest(db, { userId: DAVE, requestId: r.id })).rejects.toBeInstanceOf(SignupError);
    await cancelRequest(db, { userId: CAROL, requestId: r.id });
    expect(await myRequests(db, CAROL, NOW)).toEqual([]);
  });

  it('shows waiting requests and recent declines, with the organisation’s name', async () => {
    const { db } = world();
    const p = person(CAROL, 'carol@acme.com');
    const r = await requestToJoin(db, { person: p, orgId: ACME }, NOW);
    expect(await myRequests(db, CAROL, NOW)).toMatchObject([
      { orgName: 'Acme AV Pty Ltd', status: 'pending' },
    ]);
    await decideRequest(db, { orgId: ACME, requestId: r.id, by: ALICE, decision: { approve: false } }, NOW);
    expect(await myRequests(db, CAROL, NOW)).toMatchObject([{ status: 'declined' }]);
    expect(await myRequests(db, CAROL, new Date(NOW.getTime() + 40 * DAY))).toEqual([]);
  });
});

describe('one free trial each', () => {
  it('gives the first sign-up a trial and records who took it', async () => {
    const { db, trialClaim } = world();
    expect(await claimTrial(db, person(CAROL, 'carol@acme.com'))).toBe(true);
    expect(trialClaim.rows[0]).toMatchObject({
      userId: CAROL,
      emailKey: 'carol@acme.com',
      domainKey: 'acme.com',
    });
  });

  it('refuses a second organisation for the same person', async () => {
    const { db } = world();
    const p = person(CAROL, 'carol@acme.com');
    await claimTrial(db, p);
    expect(await claimTrial(db, p)).toBe(false);
  });

  it('refuses a colleague at the same company', async () => {
    const { db } = world();
    await claimTrial(db, person(CAROL, 'carol@acme.com'));
    expect(await claimTrial(db, person(DAVE, 'dave@acme.com'))).toBe(false);
  });

  it('refuses the same mailbox under a new account, including +labels and Gmail dots', async () => {
    const { db } = world();
    await claimTrial(db, person(CAROL, 'car.ol@gmail.com'));
    expect(await claimTrial(db, person(DAVE, 'carol+again@gmail.com'))).toBe(false);
  });

  it('lets different people on free mail each have one', async () => {
    const { db } = world();
    await claimTrial(db, person(CAROL, 'carol@gmail.com'));
    expect(await claimTrial(db, person(DAVE, 'dave@gmail.com'))).toBe(true);
  });

  it('counts a lost race as no trial', async () => {
    const { db, trialClaim } = world();
    trialClaim.create = async () => {
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    };
    expect(await claimTrial(db, person(CAROL, 'carol@acme.com'))).toBe(false);
  });

  it('gives a trial back only if the organisation was never created', async () => {
    const { db, trialClaim } = world();
    await claimTrial(db, person(CAROL, 'carol@acme.com'));
    await releaseTrialClaim(db, CAROL);
    expect(trialClaim.rows).toHaveLength(0);

    await claimTrial(db, person(CAROL, 'carol@acme.com'));
    await attachTrialClaim(db, CAROL, ACME);
    await releaseTrialClaim(db, CAROL);
    expect(trialClaim.rows).toHaveLength(1);
    expect(trialClaim.rows[0]).toMatchObject({ orgId: ACME });
  });
});

describe('the person behind a request', () => {
  it('trusts an address only once it is confirmed', () => {
    expect(personOf({ id: CAROL, email: 'Carol@Acme.com', email_confirmed_at: null })).toEqual({
      userId: CAROL,
      email: 'carol@acme.com',
      emailConfirmed: false,
    });
    expect(
      personOf({ id: CAROL, email: 'carol@acme.com', email_confirmed_at: '2026-09-27' }).emailConfirmed,
    ).toBe(true);
  });
});
