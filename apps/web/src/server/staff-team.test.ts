import { describe, expect, it } from 'vitest';
import {
  TeamError,
  describeStaffAudit,
  listStaffAudit,
  listTeam,
  removeStaff,
  setStaff,
  type AccountLookup,
  type TeamDb,
} from './staff-team';
import { table } from './test-db';

const [ME, SAM, KIM, NEWBIE] = Array.from(
  { length: 4 },
  (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${i + 1}`,
);
const ORG = '11111111-1111-4111-8111-111111111111';
const at = (day: number) => new Date(Date.UTC(2026, 8, day));

const accounts: AccountLookup = {
  async findByEmail(email) {
    const known: Record<string, string> = {
      'new@kestrel.test': NEWBIE!,
      'sam@kestrel.test': SAM!,
      'me@kestrel.test': ME!,
    };
    return known[email] ? { id: known[email]!, email } : null;
  },
};

function world() {
  const staffUser = table([
    { id: 's1', userId: ME, email: 'me@kestrel.test', roles: ['admin'], createdAt: at(1) },
    { id: 's2', userId: SAM, email: 'sam@kestrel.test', roles: ['support'], createdAt: at(2) },
  ]);
  const staffAudit = table([]);
  const org = table([{ id: ORG, name: 'Acme' }]);
  return { db: { staffUser, staffAudit, org } as unknown as TeamDb, staffUser, staffAudit };
}

describe('managing the staff team', () => {
  it('lists staff oldest first', async () => {
    expect((await listTeam(world().db)).map((t) => t.email)).toEqual([
      'me@kestrel.test',
      'sam@kestrel.test',
    ]);
  });

  it('gives an existing account staff access, and records who did it', async () => {
    const w = world();
    const row = await setStaff(w.db, accounts, {
      email: ' New@Kestrel.test ',
      roles: ['support', 'billing'],
      by: ME!,
    });
    expect(row).toMatchObject({
      userId: NEWBIE,
      email: 'new@kestrel.test',
      roles: ['support', 'billing'],
    });
    expect(w.staffUser.rows).toHaveLength(3);
    expect(w.staffUser.rows[2]).toMatchObject({ createdBy: ME });
    expect(w.staffAudit.rows[0]).toMatchObject({ staffUserId: ME, action: 'staff.add' });
  });

  it('needs a real account, a known role and at least one role', async () => {
    const w = world();
    await expect(
      setStaff(w.db, accounts, { email: 'nobody@kestrel.test', roles: ['support'], by: ME! }),
    ).rejects.toThrow(/sign up first/);
    await expect(
      setStaff(w.db, accounts, { email: 'new@kestrel.test', roles: ['owner'], by: ME! }),
    ).rejects.toThrow(/Unknown role/);
    await expect(
      setStaff(w.db, accounts, { email: 'new@kestrel.test', roles: [], by: ME! }),
    ).rejects.toThrow(/at least one role/);
    expect(w.staffUser.rows).toHaveLength(2);
    expect(w.staffAudit.rows).toHaveLength(0);
  });

  it('changes someone’s roles without adding a second row', async () => {
    const w = world();
    await setStaff(w.db, accounts, { email: 'sam@kestrel.test', roles: ['billing'], by: ME! });
    expect(w.staffUser.rows).toHaveLength(2);
    expect(w.staffUser.rows[1]!.roles).toEqual(['billing']);
    expect(w.staffAudit.rows[0]).toMatchObject({
      action: 'staff.set_roles',
      meta: { before: ['support'] },
    });
  });

  it('never lets the only admin be demoted or removed', async () => {
    const w = world();
    await expect(
      setStaff(w.db, accounts, { email: 'me@kestrel.test', roles: ['support'], by: ME! }),
    ).rejects.toThrow(/only admin/);
    await expect(removeStaff(w.db, { userId: ME!, by: ME! })).rejects.toBeInstanceOf(TeamError);
    // With a second admin it is fine.
    await setStaff(w.db, accounts, { email: 'sam@kestrel.test', roles: ['admin'], by: ME! });
    await setStaff(w.db, accounts, { email: 'me@kestrel.test', roles: ['support'], by: ME! });
    await removeStaff(w.db, { userId: ME!, by: SAM! });
    expect(w.staffUser.rows.map((r) => r.userId)).toEqual([SAM]);
  });

  it('removes someone, and says so in the trail', async () => {
    const w = world();
    await removeStaff(w.db, { userId: SAM!, by: ME! });
    expect(w.staffUser.rows.map((r) => r.userId)).toEqual([ME]);
    expect(w.staffAudit.rows[0]).toMatchObject({
      staffUserId: ME,
      action: 'staff.remove',
      meta: { email: 'sam@kestrel.test' },
    });
    await expect(removeStaff(w.db, { userId: KIM!, by: ME! })).rejects.toThrow(/not staff/);
  });
});

describe('browsing the staff trail', () => {
  function trail() {
    const w = world();
    const rows = [
      { id: 't1', staffUserId: SAM, action: 'org.view', orgId: ORG, createdAt: at(10), meta: {} },
      {
        id: 't2',
        staffUserId: SAM,
        action: 'session.start',
        orgId: ORG,
        createdAt: at(11),
        meta: { mode: 'read', reason: 'Panel dead' },
      },
      {
        id: 't3',
        staffUserId: ME,
        action: 'staff.add',
        orgId: null,
        createdAt: at(12),
        meta: { email: 'x@y.z', roles: ['support'] },
      },
      { id: 't4', staffUserId: KIM, action: 'org.view', orgId: ORG, createdAt: at(13), meta: {} },
      {
        id: 't5',
        staffUserId: SAM,
        action: 'org.view',
        orgId: '99999999-9999-4999-8999-999999999999',
        createdAt: at(14),
        meta: {},
      },
    ];
    w.staffAudit.rows.push(...rows);
    return w;
  }

  it('shows the newest first, with staff and organisation names', async () => {
    const { rows } = await listStaffAudit(trail().db);
    expect(rows.map((r) => r.id)).toEqual(['t5', 't4', 't3', 't2', 't1']);
    expect(rows.find((r) => r.id === 't2')).toMatchObject({
      staff: 'sam@kestrel.test',
      orgName: 'Acme',
    });
    expect(rows.find((r) => r.id === 't4')!.staff).toBe('Former staff');
    expect(rows.find((r) => r.id === 't5')!.orgName).toBe('Deleted organisation');
    expect(rows.find((r) => r.id === 't3')!.orgName).toBeNull();
  });

  it('filters by staff member, organisation and the start of the action', async () => {
    const w = trail();
    expect((await listStaffAudit(w.db, { staffUserId: SAM })).rows.map((r) => r.id)).toEqual([
      't5',
      't2',
      't1',
    ]);
    expect((await listStaffAudit(w.db, { orgId: ORG })).rows.map((r) => r.id)).toEqual([
      't4',
      't2',
      't1',
    ]);
    expect((await listStaffAudit(w.db, { action: 'session.' })).rows.map((r) => r.id)).toEqual([
      't2',
    ]);
    expect(
      (await listStaffAudit(w.db, { staffUserId: SAM, orgId: ORG, action: 'org.' })).rows.map(
        (r) => r.id,
      ),
    ).toEqual(['t1']);
  });

  it('pages back through older rows', async () => {
    const w = trail();
    const first = await listStaffAudit(w.db, { limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual(['t5', 't4']);
    expect(first.more).toBe(true);
    const next = await listStaffAudit(w.db, { limit: 2, before: first.rows.at(-1)!.at });
    expect(next.rows.map((r) => r.id)).toEqual(['t3', 't2']);
    const last = await listStaffAudit(w.db, { limit: 2, before: next.rows.at(-1)!.at });
    expect(last.rows.map((r) => r.id)).toEqual(['t1']);
    expect(last.more).toBe(false);
  });

  it('describes rows in words, and falls back to the action name', () => {
    expect(describeStaffAudit('org.view', {})).toBe('opened the organisation page');
    expect(describeStaffAudit('session.start', { mode: 'act', reason: 'Fix' })).toContain(
      '(act): “Fix”',
    );
    expect(describeStaffAudit('staff.set_roles', { email: 'a@b.c', roles: ['admin'] })).toContain(
      'a@b.c to admin',
    );
    expect(describeStaffAudit('something.new_thing', {})).toBe('something new thing');
  });
});
