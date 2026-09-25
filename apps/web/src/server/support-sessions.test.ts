import { describe, expect, it } from 'vitest';
import {
  SessionError,
  activeSession,
  currentSession,
  endSession,
  logSessionAction,
  openTickets,
  sessionGate,
  setStaffAccessBlocked,
  startSession,
  type SessionDb,
} from './support-sessions';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '11111111-1111-4111-8111-111111111112';
const STAFF = '55555555-5555-4555-8555-555555555551';
const STAFF2 = '55555555-5555-4555-8555-555555555552';
const NOW = new Date('2026-09-25T00:00:00Z');
const mins = (n: number) => new Date(NOW.getTime() + n * 60_000);
const admin = { userId: STAFF, roles: ['admin'] };
const readonly = { userId: STAFF2, roles: ['readonly'] };

function world({ blocked = false }: { blocked?: boolean } = {}) {
  let n = 0;
  const withIds = <T extends ReturnType<typeof table>>(t: T, p: string): T => {
    const create = t.create;
    t.create = async (args: { data: Record<string, unknown> }) =>
      create({
        data: { id: `${p}-${++n}`, createdAt: new Date(NOW.getTime() + n * 1000), ...args.data },
      });
    return t;
  };
  const org = table([
    { id: ORG, name: 'Acme', staffAccessBlocked: blocked },
    { id: OTHER_ORG, name: 'Other', staffAccessBlocked: false },
  ]);
  const ticket = table([
    { id: 't-open', orgId: ORG, status: 'open', title: 'Room 2 will not start', createdAt: NOW },
    { id: 't-closed', orgId: ORG, status: 'closed', title: 'Old one', createdAt: NOW },
    { id: 't-other', orgId: OTHER_ORG, status: 'open', title: 'Someone else', createdAt: NOW },
  ]);
  const supportSession = withIds(table([]), 'ss');
  const auditLog = withIds(table([]), 'al');
  const staffAudit = withIds(table([]), 'sa');
  return {
    db: { org, ticket, supportSession, auditLog, staffAudit } as unknown as SessionDb,
    org,
    supportSession,
    auditLog,
    staffAudit,
  };
}

const start = (
  w: ReturnType<typeof world>,
  input: Partial<Parameters<typeof startSession>[1]['input']> = {},
  staff = admin,
) =>
  startSession(w.db, {
    staff,
    now: NOW,
    input: {
      orgId: ORG,
      mode: 'read',
      reason: 'Investigating a support ticket',
      minutes: 30,
      ...input,
    },
  });

describe('starting a session', () => {
  it('opens a read-only session that ends by itself', async () => {
    const w = world();
    const { endsAt } = await start(w);
    expect(endsAt).toEqual(mins(30));
    expect(await activeSession(w.db, STAFF, ORG, NOW)).toMatchObject({ mode: 'read', orgId: ORG });
    expect(await activeSession(w.db, STAFF, ORG, mins(31))).toBeNull();
  });

  it('is only for the organisation it was opened in, and only for that person', async () => {
    const w = world();
    await start(w);
    expect(await activeSession(w.db, STAFF, OTHER_ORG, NOW)).toBeNull();
    expect(await activeSession(w.db, STAFF2, ORG, NOW)).toBeNull();
  });

  it('needs a reason, a sensible length, and a real organisation', async () => {
    const w = world();
    await expect(start(w, { reason: '  ok ' })).rejects.toThrow(/reason/);
    await expect(start(w, { minutes: 999 })).rejects.toThrow(/15, 30, 60 or 120/);
    await expect(start(w, { orgId: '11111111-1111-4111-8111-1111111111ff' })).rejects.toThrow(
      /not found/,
    );
    expect(w.supportSession.rows).toHaveLength(0);
  });

  it('acting inside an organisation needs the support role; looking only needs to be staff', async () => {
    const w = world();
    await expect(start(w, { mode: 'act' }, readonly)).rejects.toThrow(/support role/);
    await expect(start(w, { mode: 'read' }, readonly)).resolves.toBeTruthy();
    await expect(
      start(w, { mode: 'act' }, { userId: STAFF, roles: ['support'] }),
    ).resolves.toBeTruthy();
    await expect(start(w, {}, { userId: STAFF, roles: [] })).rejects.toThrow(SessionError);
  });

  it('opening a second session ends the first', async () => {
    const w = world();
    await start(w);
    await start(w, { orgId: OTHER_ORG });
    expect(await activeSession(w.db, STAFF, ORG, NOW)).toBeNull();
    expect((await currentSession(w.db, STAFF, NOW))!.orgId).toBe(OTHER_ORG);
  });
});

describe('an organisation that blocks staff access', () => {
  it('refuses a session without a ticket, and accepts one of its own open tickets', async () => {
    const w = world({ blocked: true });
    await expect(start(w)).rejects.toThrow(/blocked staff access/);
    await expect(start(w, { ticketId: 't-open' })).resolves.toBeTruthy();
    expect((await activeSession(w.db, STAFF, ORG, NOW))!.ticketId).toBe('t-open');
  });

  it('a ticket from another organisation, or a closed one, does not count', async () => {
    const w = world({ blocked: true });
    await expect(start(w, { ticketId: 't-other' })).rejects.toThrow(/not one of this organisation/);
    await expect(start(w, { ticketId: 't-closed' })).rejects.toThrow(/not open/);
  });

  it('an open organisation does not need a ticket, but a bad one is still refused', async () => {
    const w = world();
    await expect(start(w)).resolves.toBeTruthy();
    await expect(start(w, { ticketId: 't-other' })).rejects.toThrow(/not one of this organisation/);
  });

  it('the owner can switch it on and off, and it is written to their activity log', async () => {
    const w = world();
    await setStaffAccessBlocked(w.db, { orgId: ORG, blocked: true, actorId: 'owner-1' });
    expect(w.org.rows.find((o) => o.id === ORG)!.staffAccessBlocked).toBe(true);
    expect(w.auditLog.rows[0]).toMatchObject({ action: 'org.staff_access', actorId: 'owner-1' });
    await setStaffAccessBlocked(w.db, { orgId: ORG, blocked: false, actorId: 'owner-1' });
    expect(w.org.rows.find((o) => o.id === ORG)!.staffAccessBlocked).toBe(false);
  });

  it('lists only the organisation’s open tickets', async () => {
    const w = world();
    expect((await openTickets(w.db, ORG)).map((t) => t.id)).toEqual(['t-open']);
  });
});

describe('what everyone can see', () => {
  it('the organisation is told when a session starts and ends, and why', async () => {
    const w = world();
    const { id } = await start(w, { reason: 'Room 2 will not start', ticketId: 't-open' });
    await endSession(w.db, { sessionId: id, staffUserId: STAFF, now: mins(10) });
    const [started, ended] = w.auditLog.rows;
    expect(started).toMatchObject({ orgId: ORG, actorId: null, action: 'staff.session.start' });
    expect(started!.meta).toMatchObject({
      staff: true,
      mode: 'read',
      reason: 'Room 2 will not start',
      ticketId: 't-open',
    });
    expect(ended).toMatchObject({ action: 'staff.session.end' });
  });

  it('staff audit records the same, with who', async () => {
    const w = world();
    const { id } = await start(w);
    await endSession(w.db, { sessionId: id, staffUserId: STAFF, now: mins(5) });
    expect(w.staffAudit.rows.map((r) => `${r.action}:${r.staffUserId}`)).toEqual([
      `session.start:${STAFF}`,
      `session.end:${STAFF}`,
    ]);
  });

  it('every action in a session can be logged against it', async () => {
    const w = world();
    const { id } = await start(w, { mode: 'act' });
    await logSessionAction(
      w.db,
      { id, staffUserId: STAFF, orgId: ORG },
      'session.act',
      'room.update',
    );
    await logSessionAction(
      w.db,
      { id, staffUserId: STAFF, orgId: ORG },
      'session.blocked',
      'room.delete',
    );
    expect(
      w.staffAudit.rows.map((r) => `${r.action}:${(r.meta as { procedure: string }).procedure}`),
    ).toEqual([
      'session.start:undefined',
      'session.act:room.update',
      'session.blocked:room.delete',
    ]);
  });
});

describe('ending a session', () => {
  it('ends it at once, so access stops', async () => {
    const w = world();
    const { id } = await start(w);
    await endSession(w.db, { sessionId: id, staffUserId: STAFF, now: mins(1) });
    expect(await activeSession(w.db, STAFF, ORG, mins(2))).toBeNull();
  });

  it('cannot be ended by someone else, and ending twice does nothing more', async () => {
    const w = world();
    const { id } = await start(w);
    await endSession(w.db, { sessionId: id, staffUserId: STAFF2, now: mins(1) });
    expect(await activeSession(w.db, STAFF, ORG, mins(2))).not.toBeNull();
    await endSession(w.db, { sessionId: id, staffUserId: STAFF, now: mins(3) });
    await endSession(w.db, { sessionId: id, staffUserId: STAFF, now: mins(4) });
    expect(w.auditLog.rows.filter((r) => r.action === 'staff.session.end')).toHaveLength(1);
  });
});

describe('what a session may do', () => {
  it('reading is always allowed', () => {
    expect(sessionGate('read', 'query')).toBe('allow');
    expect(sessionGate('act', 'query')).toBe('allow');
    expect(sessionGate('read', 'subscription')).toBe('allow');
  });

  it('a view-only session can never change anything', () => {
    expect(sessionGate('read', 'mutation')).toBe('deny');
  });

  it('an act session can, and every change is logged', () => {
    expect(sessionGate('act', 'mutation')).toBe('log');
  });
});
