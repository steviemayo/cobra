import { describe, expect, it } from 'vitest';
import { canAddRoom, getEntitlements } from './billing';
import {
  LicenceError,
  addNote,
  describeOverride,
  licenceState,
  listNotes,
  revokeOverride,
  setOverride,
  type LicenceDb,
} from './staff-licences';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const STAFF = '55555555-5555-4555-8555-555555555551';
const NOW = new Date('2026-09-25T00:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function world(billing: Record<string, unknown> = {}) {
  let n = 0;
  const withIds = <T extends ReturnType<typeof table>>(t: T, prefix: string): T => {
    const create = t.create;
    t.create = async (args: { data: Record<string, unknown> }) =>
      create({
        data: {
          id: `${prefix}-${++n}`,
          createdAt: new Date(NOW.getTime() + n * 1000),
          ...args.data,
        },
      });
    return t;
  };
  const org = table([{ id: ORG, name: 'Acme', createdAt: new Date('2026-01-01') }]);
  const orgBilling = withIds(
    table([
      {
        id: 'b1',
        orgId: ORG,
        plan: 'trial',
        status: 'none',
        trialEndsAt: days(-3),
        stripeCustomerId: null,
        ...billing,
      },
    ]),
    'b',
  );
  const orgLicenseOverride = withIds(table([]), 'o');
  const orgNote = withIds(table([]), 'n');
  const auditLog = withIds(table([]), 'a');
  const staffAudit = withIds(table([]), 's');
  const staffUser = table([{ userId: STAFF, email: 'steve@kestrel.test', roles: ['admin'] }]);
  return {
    db: {
      org,
      orgBilling,
      orgLicenseOverride,
      orgNote,
      auditLog,
      staffAudit,
      staffUser,
    } as unknown as LicenceDb,
    orgLicenseOverride,
    orgNote,
    auditLog,
    staffAudit,
  };
}

const set = (w: ReturnType<typeof world>, input: Parameters<typeof setOverride>[1]['input']) =>
  setOverride(w.db, { orgId: ORG, staffUserId: STAFF, input, now: NOW });

describe('adjusting a licence', () => {
  it('extends an ended trial and the organisation gets monitoring back', async () => {
    const w = world();
    expect((await getEntitlements(w.db, ORG, NOW)).plan).toBe('trial_expired');
    await set(w, { trialEndsAt: days(14), reason: 'Pilot ran late while site works finished' });
    const e = await getEntitlements(w.db, ORG, NOW);
    expect(e).toMatchObject({ plan: 'trial', monitoring: true, trialDaysLeft: 14 });
    expect(e.adjusted).toEqual({ until: null });
  });

  it('lifts the room limit, which the room-adding check then honours', async () => {
    const w = world();
    expect(canAddRoom(await getEntitlements(w.db, ORG, NOW), 5)).toBe(false);
    await set(w, { maxRooms: 8, reason: 'Comped for the launch week' });
    expect(canAddRoom(await getEntitlements(w.db, ORG, NOW), 5)).toBe(true);
    expect(canAddRoom(await getEntitlements(w.db, ORG, NOW), 8)).toBe(false);
  });

  it('stops applying at its end date, without anyone doing anything', async () => {
    const w = world();
    await set(w, { plan: 'pro', expiresAt: days(7), reason: 'Two week pilot of Pro' });
    expect((await getEntitlements(w.db, ORG, NOW)).plan).toBe('pro');
    expect((await getEntitlements(w.db, ORG, days(8))).plan).toBe('trial_expired');
  });

  it('a new adjustment replaces the old one', async () => {
    const w = world();
    await set(w, { plan: 'pro', reason: 'First reason here' });
    await set(w, { maxRooms: 3, reason: 'Second reason here' });
    const e = await getEntitlements(w.db, ORG, NOW);
    expect(e.plan).toBe('trial_expired'); // the pro comp was replaced, not stacked
    expect(e.maxRooms).toBe(3);
    expect(w.orgLicenseOverride.rows.filter((r) => !r.revokedAt)).toHaveLength(1);
  });

  it('removing it puts the organisation back to what it pays for', async () => {
    const w = world();
    const { id } = await set(w, { plan: 'pro', reason: 'Trying something out' });
    await revokeOverride(w.db, { orgId: ORG, overrideId: id, staffUserId: STAFF, now: NOW });
    expect((await getEntitlements(w.db, ORG, NOW)).plan).toBe('trial_expired');
    await expect(
      revokeOverride(w.db, { orgId: ORG, overrideId: id, staffUserId: STAFF, now: NOW }),
    ).rejects.toThrow(/already removed/);
  });

  it('cannot touch another organisation’s adjustment', async () => {
    const w = world();
    const { id } = await set(w, { plan: 'pro', reason: 'Some good reason' });
    await expect(
      revokeOverride(w.db, {
        orgId: '11111111-1111-4111-8111-1111111111ff',
        overrideId: id,
        staffUserId: STAFF,
      }),
    ).rejects.toThrow(LicenceError);
  });
});

describe('what is asked of staff', () => {
  const bad = async (
    input: Parameters<typeof setOverride>[1]['input'],
    message: RegExp,
  ): Promise<void> => {
    const w = world();
    await expect(set(w, input)).rejects.toThrow(message);
    expect(w.orgLicenseOverride.rows).toHaveLength(0);
    expect(w.auditLog.rows).toHaveLength(0);
  };

  it('needs a reason, and something to change', async () => {
    await bad({ plan: 'pro', reason: '   ' }, /reason/);
    await bad({ plan: 'pro', reason: 'ok' }, /reason/);
    await bad({ reason: 'A fine reason' }, /Choose something/);
  });

  it('refuses dates in the past and nonsense limits', async () => {
    await bad({ trialEndsAt: days(-1), reason: 'A fine reason' }, /in the future/);
    await bad({ plan: 'pro', expiresAt: days(-1), reason: 'A fine reason' }, /in the future/);
    await bad({ maxRooms: 0, reason: 'A fine reason' }, /1 to 1000/);
    await bad({ maxRooms: 5, unlimitedRooms: true, reason: 'A fine reason' }, /not both/);
    await bad(
      { plan: 'pro', trialEndsAt: days(3), reason: 'A fine reason' },
      /only applies to a trial/,
    );
  });

  it('refuses an organisation that does not exist', async () => {
    const w = world();
    await expect(
      setOverride(w.db, {
        orgId: '11111111-1111-4111-8111-1111111111ff',
        staffUserId: STAFF,
        input: { plan: 'pro', reason: 'A fine reason' },
        now: NOW,
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('who can see what', () => {
  it('the customer is told what changed but never why; staff see the reason', async () => {
    const w = world();
    await set(w, {
      maxRooms: 8,
      expiresAt: days(30),
      reason: 'Confidential: they are a friend of the CEO',
    });

    const customer = w.auditLog.rows[0]!;
    expect(customer).toMatchObject({ orgId: ORG, actorId: null, action: 'license.adjust' });
    expect(JSON.stringify(customer)).not.toMatch(/Confidential|CEO/);
    expect(JSON.stringify(customer)).toMatch(/up to 8 rooms/);
    expect((customer.meta as { staff: boolean }).staff).toBe(true);

    const staff = w.staffAudit.rows[0]!;
    expect(staff).toMatchObject({ action: 'license.set', orgId: ORG, staffUserId: STAFF });
    expect((staff.meta as { reason: string }).reason).toMatch(/Confidential/);
  });

  it('removing one is also visible to the customer', async () => {
    const w = world();
    const { id } = await set(w, { plan: 'pro', reason: 'A fine reason' });
    await revokeOverride(w.db, { orgId: ORG, overrideId: id, staffUserId: STAFF, now: NOW });
    expect(w.auditLog.rows.map((r) => r.action)).toEqual(['license.adjust', 'license.revoke']);
  });

  it('describes an adjustment in words', () => {
    expect(describeOverride({ trialEndsAt: days(14), reason: 'x' })).toBe(
      'trial extended to 2026-10-09',
    );
    expect(describeOverride({ plan: 'pro', expiresAt: days(7), reason: 'x' })).toBe(
      'pro plan, until 2026-10-02',
    );
    expect(describeOverride({ unlimitedRooms: true, monitoring: true, reason: 'x' })).toBe(
      'no room limit, monitoring on',
    );
  });
});

describe('the licence page for an organisation', () => {
  it('shows what it pays for, what it may do now, and the history with who set each', async () => {
    const w = world();
    await set(w, { plan: 'pro', reason: 'First pilot round' });
    await set(w, { trialEndsAt: days(10), reason: 'Second, smaller adjustment' });
    const s = await licenceState(w.db, ORG, NOW);
    expect(s.billing).toMatchObject({ plan: 'trial', status: 'none', managedByStripe: false });
    expect(s.base.plan).toBe('trial_expired');
    expect(s.effective.plan).toBe('trial');
    expect(s.overrides).toHaveLength(2);
    expect(s.overrides[0]).toMatchObject({ active: true, setBy: 'steve@kestrel.test' });
    expect(s.overrides[1]).toMatchObject({ active: false });
  });
});

describe('notes', () => {
  it('are kept per organisation, newest first, with who wrote them', async () => {
    const w = world();
    await addNote(w.db, { orgId: ORG, authorId: STAFF, body: '  Called about the trial.  ' });
    await addNote(w.db, { orgId: ORG, authorId: STAFF, body: 'Sent the pricing sheet.' });
    const notes = await listNotes(w.db, ORG);
    expect(notes.map((n) => n.body)).toEqual([
      'Sent the pricing sheet.',
      'Called about the trial.',
    ]);
    expect(notes[0]!.author).toBe('steve@kestrel.test');
    expect(w.staffAudit.rows.map((r) => r.action)).toEqual(['note.add', 'note.add']);
  });

  it('cannot be empty or huge', async () => {
    const w = world();
    await expect(addNote(w.db, { orgId: ORG, authorId: STAFF, body: '   ' })).rejects.toThrow(
      /Write something/,
    );
    await expect(
      addNote(w.db, { orgId: ORG, authorId: STAFF, body: 'x'.repeat(2001) }),
    ).rejects.toThrow(/2000/);
  });
});
