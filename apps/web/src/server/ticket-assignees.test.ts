import { describe, expect, it } from 'vitest';
import {
  assigneeLabel,
  assigneesFor,
  clearStaleAssignees,
  findAssignee,
  type AssigneeDb,
} from './ticket-assignees';
import { table } from './test-db';

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const MSP = '22222222-2222-4222-8222-222222222221';
const OTHER_MSP = '22222222-2222-4222-8222-222222222222';
const [CAROL, DAN, ALICE, BOB, VIC, ZED] = Array.from(
  { length: 6 },
  (_, i) => `44444444-4444-4444-8444-44444444444${i + 1}`,
) as [string, string, string, string, string, string];

function world(grants: Record<string, unknown>[] = []) {
  const member = table([
    { orgId: CUSTOMER, userId: CAROL, role: 'owner', email: 'carol@acme.test' },
    { orgId: CUSTOMER, userId: DAN, role: 'support', email: 'dan@acme.test' },
    { orgId: CUSTOMER, userId: VIC, role: 'customer_viewer', email: 'vic@acme.test' },
    { orgId: MSP, userId: ALICE, role: 'owner', email: 'alice@avpartners.test' },
    { orgId: MSP, userId: BOB, role: 'support', email: 'bob@avpartners.test' },
    { orgId: MSP, userId: VIC, role: 'customer_viewer', email: 'vic@avpartners.test' },
    { orgId: OTHER_MSP, userId: ZED, role: 'dev', email: 'zed@other.test' },
  ]);
  const mspGrant = table(grants);
  const org = table([
    { id: MSP, name: 'AV Partners' },
    { id: OTHER_MSP, name: 'Other MSP' },
  ]);
  const room = table([
    { id: 'r1', orgId: CUSTOMER, siteId: 'site-a' },
    { id: 'r2', orgId: CUSTOMER, siteId: 'site-b' },
  ]);
  const ticket = table([]);
  return { db: { member, mspGrant, org, room, ticket } as unknown as AssigneeDb, ticket, mspGrant };
}
const grant = (over: Record<string, unknown> = {}) => ({
  id: 'g1',
  mspOrgId: MSP,
  customerOrgId: CUSTOMER,
  status: 'active',
  role: 'manage',
  siteIds: [],
  ...over,
});
const ids = (list: { userId: string }[]) => list.map((a) => a.userId);

describe('who a ticket can be assigned to', () => {
  it('is the organisation’s own team when there is no provider, never customer viewers', async () => {
    const list = await assigneesFor(world().db, CUSTOMER, { roomId: null });
    expect(ids(list)).toEqual([CAROL, DAN]);
    expect(list[0]).toMatchObject({ label: 'carol@acme.test', provider: null });
  });

  it('adds people from a provider that takes tickets, named with the provider', async () => {
    const list = await assigneesFor(world([grant({ role: 'support' })]).db, CUSTOMER, {
      roomId: null,
    });
    expect(ids(list)).toEqual([CAROL, DAN, ALICE, BOB]);
    expect(list.find((a) => a.userId === BOB)).toMatchObject({
      label: 'bob@avpartners.test (AV Partners)',
      provider: 'AV Partners',
    });
  });

  it('leaves out a provider that is view only, pending or ended, and other providers’ people', async () => {
    for (const over of [{ role: 'view' }, { status: 'pending' }, { status: 'ended' }]) {
      const list = await assigneesFor(world([grant(over)]).db, CUSTOMER, { roomId: null });
      expect(ids(list), JSON.stringify(over)).toEqual([CAROL, DAN]);
    }
    expect(ids(await assigneesFor(world([grant()]).db, CUSTOMER, { roomId: null }))).not.toContain(
      ZED,
    );
  });

  it('leaves out provider staff who are only viewers in their own organisation', async () => {
    expect(ids(await assigneesFor(world([grant()]).db, CUSTOMER, { roomId: null }))).not.toContain(
      VIC,
    );
  });

  it('a provider limited to a site appears only for a request about a room there', async () => {
    const w = world([grant({ siteIds: ['site-a'] })]);
    expect(ids(await assigneesFor(w.db, CUSTOMER, { roomId: 'r1' }))).toContain(BOB);
    expect(ids(await assigneesFor(w.db, CUSTOMER, { roomId: 'r2' }))).not.toContain(BOB);
    expect(ids(await assigneesFor(w.db, CUSTOMER, { roomId: null }))).not.toContain(BOB);
  });

  it('checks one person the same way', async () => {
    const w = world([grant()]);
    expect(await findAssignee(w.db, CUSTOMER, { roomId: null }, BOB)).toMatchObject({
      provider: 'AV Partners',
    });
    expect(await findAssignee(w.db, CUSTOMER, { roomId: null }, ZED)).toBeNull();
    expect(await findAssignee(w.db, CUSTOMER, { roomId: null }, VIC)).toBeNull();
  });
});

describe('showing the assignee', () => {
  it('names team members and provider staff, and a stranger as a former member', async () => {
    const w = world([grant()]);
    expect(await assigneeLabel(w.db, CUSTOMER, DAN)).toBe('dan@acme.test');
    expect(await assigneeLabel(w.db, CUSTOMER, BOB)).toBe('bob@avpartners.test (AV Partners)');
    expect(await assigneeLabel(w.db, CUSTOMER, ZED)).toBe('Former member');
  });

  it('a provider person reads as a former member once the connection ends', async () => {
    const w = world([grant({ status: 'ended' })]);
    expect(await assigneeLabel(w.db, CUSTOMER, BOB)).toBe('Former member');
  });
});

describe('when the connection ends', () => {
  it('clears tickets assigned to provider staff, and only those', async () => {
    const w = world([grant({ status: 'ended' })]);
    w.ticket.rows.push(
      { id: 't1', orgId: CUSTOMER, assignedTo: BOB },
      { id: 't2', orgId: CUSTOMER, assignedTo: DAN },
      { id: 't3', orgId: CUSTOMER, assignedTo: null },
      { id: 't4', orgId: 'another-org', assignedTo: BOB },
    );
    expect(await clearStaleAssignees(w.db, CUSTOMER)).toBe(1);
    expect(w.ticket.rows.map((t) => t.assignedTo)).toEqual([null, DAN, null, BOB]);
  });

  it('keeps provider staff who are still covered by another live connection', async () => {
    const w = world([
      grant({ status: 'ended' }),
      grant({ id: 'g2', mspOrgId: MSP, role: 'support' }),
    ]);
    w.ticket.rows.push({ id: 't1', orgId: CUSTOMER, assignedTo: BOB });
    expect(await clearStaleAssignees(w.db, CUSTOMER)).toBe(0);
    expect(w.ticket.rows[0]!.assignedTo).toBe(BOB);
  });

  it('does nothing when nothing is assigned', async () => {
    expect(await clearStaleAssignees(world().db, CUSTOMER)).toBe(0);
  });
});
