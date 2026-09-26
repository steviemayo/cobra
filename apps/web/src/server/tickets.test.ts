import { describe, expect, it } from 'vitest';
import {
  STAFF_LABEL,
  TicketError,
  escalateTicket,
  handBack,
  slaForTicket,
  staffComment,
  staffQueue,
  staffTicket,
  staffUpdate,
  visibleComments,
  type TicketDb,
} from './tickets';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG2 = '11111111-1111-4111-8111-111111111112';
const USER = '44444444-4444-4444-8444-444444444441';
const STAFF = '55555555-5555-4555-8555-555555555551';
const STAFF2 = '55555555-5555-4555-8555-555555555552';
const NOW = new Date('2026-09-25T00:00:00Z');
const mins = (n: number) => new Date(NOW.getTime() + n * 60_000);
const staff = { userId: STAFF, email: 'steve@kestrel.test' };
const owner = { userId: USER, email: 'owner@acme.test' };

function world() {
  let n = 0;
  const withIds = <T extends ReturnType<typeof table>>(t: T, p: string): T => {
    const create = t.create;
    t.create = async (args: { data: Record<string, unknown> }) =>
      create({
        data: { id: `${p}-${++n}`, createdAt: new Date(NOW.getTime() + n * 1000), ...args.data },
      });
    return t;
  };
  const t = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    orgId: ORG,
    title: `Ticket ${id}`,
    body: 'Something is wrong',
    status: 'open',
    priority: 'normal',
    routedTo: 'org',
    roomId: null,
    createdByEmail: 'sam@acme.test',
    createdAt: mins(0),
    updatedAt: mins(0),
    escalatedAt: null,
    staffAssignee: null,
    ...extra,
  });
  const ticket = table([
    t('org-only'),
    t('closed', { status: 'closed' }),
    t('low', { routedTo: 'kestrel', priority: 'low', escalatedAt: mins(1) }),
    t('urgent-late', { routedTo: 'kestrel', priority: 'urgent', escalatedAt: mins(30) }),
    t('urgent-early', { routedTo: 'kestrel', priority: 'urgent', escalatedAt: mins(10) }),
    t('other-org', { orgId: ORG2, routedTo: 'kestrel', priority: 'high', escalatedAt: mins(5) }),
    t('done', { routedTo: 'kestrel', status: 'resolved', escalatedAt: mins(2) }),
  ]);
  const ticketComment = withIds(table([]), 'c');
  const org = table([
    { id: ORG, name: 'Acme' },
    { id: ORG2, name: 'Beta' },
  ]);
  const room = table([]);
  const auditLog = withIds(table([]), 'a');
  const staffAudit = withIds(table([]), 's');
  const staffUser = table([
    { userId: STAFF, email: 'steve@kestrel.test' },
    { userId: STAFF2, email: 'pat@kestrel.test' },
  ]);
  return {
    db: {
      ticket,
      ticketComment,
      org,
      room,
      auditLog,
      staffAudit,
      staffUser,
    } as unknown as TicketDb,
    ticket,
    ticketComment,
    auditLog,
    staffAudit,
  };
}

const row = (w: ReturnType<typeof world>, id: string) => w.ticket.rows.find((r) => r.id === id)!;

describe('escalating a ticket', () => {
  it('puts it in the staff queue, says so on the ticket, and logs it', async () => {
    const w = world();
    await escalateTicket(w.db, {
      orgId: ORG,
      ticketId: 'org-only',
      by: owner,
      note: 'Room 2 will not start',
      now: NOW,
    });
    expect(row(w, 'org-only')).toMatchObject({
      routedTo: 'kestrel',
      escalatedAt: NOW,
      escalatedBy: USER,
    });
    expect(w.ticketComment.rows[0]).toMatchObject({
      visibility: 'public',
      body: 'Escalated to Kestrel support: Room 2 will not start',
    });
    expect(w.auditLog.rows[0]).toMatchObject({ action: 'ticket.escalate', actorId: USER });
    expect((await staffQueue(w.db)).map((q) => q.id)).toContain('org-only');
  });

  it('cannot escalate another organisation’s ticket, or one already with Kestrel, or a closed one', async () => {
    const w = world();
    await expect(
      escalateTicket(w.db, { orgId: ORG, ticketId: 'other-org', by: owner }),
    ).rejects.toThrow(/not found/);
    await expect(escalateTicket(w.db, { orgId: ORG, ticketId: 'low', by: owner })).rejects.toThrow(
      /already with Kestrel/,
    );
    await expect(
      escalateTicket(w.db, { orgId: ORG, ticketId: 'closed', by: owner }),
    ).rejects.toThrow(/Reopen/);
  });

  it('a resolved ticket that is escalated is open again', async () => {
    const w = world();
    row(w, 'org-only').status = 'resolved';
    await escalateTicket(w.db, { orgId: ORG, ticketId: 'org-only', by: owner });
    expect(row(w, 'org-only').status).toBe('open');
  });
});

describe('the staff queue', () => {
  it('shows only tickets with Kestrel, most urgent first, then the longest waiting', async () => {
    const q = await staffQueue(world().db);
    expect(q.map((r) => r.id)).toEqual(['urgent-early', 'urgent-late', 'other-org', 'low']);
    expect(q.find((r) => r.id === 'other-org')!.orgName).toBe('Beta');
  });

  it('hides finished tickets unless asked, and can filter by status, priority or organisation', async () => {
    const w = world();
    expect((await staffQueue(w.db)).map((r) => r.id)).not.toContain('done');
    expect((await staffQueue(w.db, { status: 'all' })).map((r) => r.id)).toContain('done');
    expect((await staffQueue(w.db, { status: 'resolved' })).map((r) => r.id)).toEqual(['done']);
    expect((await staffQueue(w.db, { priority: 'urgent' })).map((r) => r.id)).toEqual([
      'urgent-early',
      'urgent-late',
    ]);
    expect((await staffQueue(w.db, { orgId: ORG2 })).map((r) => r.id)).toEqual(['other-org']);
  });

  it('says who has to answer next', async () => {
    const w = world();
    await staffComment(w.db, {
      ticketId: 'low',
      staff,
      body: 'We are looking',
      visibility: 'public',
    });
    expect((await staffQueue(w.db)).find((r) => r.id === 'low')!.awaiting).toBe('org');
    w.ticketComment.rows.push({
      id: 'cx',
      ticketId: 'low',
      orgId: ORG,
      visibility: 'public',
      fromStaff: false,
      createdAt: mins(60),
    });
    expect((await staffQueue(w.db)).find((r) => r.id === 'low')!.awaiting).toBe('kestrel');
  });

  it('an internal note does not change who is waiting', async () => {
    const w = world();
    await staffComment(w.db, {
      ticketId: 'low',
      staff,
      body: 'Note to self',
      visibility: 'internal',
    });
    expect((await staffQueue(w.db)).find((r) => r.id === 'low')!.awaiting).toBe('kestrel');
  });
});

describe('working a ticket as staff', () => {
  it('a reply is written as Kestrel support, and the first reply takes the ticket', async () => {
    const w = world();
    await staffComment(w.db, {
      ticketId: 'low',
      staff,
      body: '  Restarting the gateway.  ',
      visibility: 'public',
    });
    expect(w.ticketComment.rows[0]).toMatchObject({
      fromStaff: true,
      visibility: 'public',
      body: 'Restarting the gateway.',
    });
    expect(row(w, 'low').staffAssignee).toBe(STAFF);
    await staffComment(w.db, {
      ticketId: 'low',
      staff: { userId: STAFF2, email: 'pat@kestrel.test' },
      body: 'Second',
      visibility: 'public',
    });
    expect(row(w, 'low').staffAssignee).toBe(STAFF); // not taken over by a later reply
  });

  it('cannot comment on a ticket that is with the organisation, or say nothing', async () => {
    const w = world();
    await expect(
      staffComment(w.db, { ticketId: 'org-only', staff, body: 'Hi', visibility: 'public' }),
    ).rejects.toThrow(/organisation’s team/);
    await expect(
      staffComment(w.db, { ticketId: 'low', staff, body: '   ', visibility: 'public' }),
    ).rejects.toThrow(/Write something/);
    await expect(
      staffComment(w.db, { ticketId: 'low', staff, body: 'x'.repeat(5001), visibility: 'public' }),
    ).rejects.toThrow(TicketError);
  });

  it('changing status or priority is shown to the organisation; taking a ticket is not', async () => {
    const w = world();
    await staffUpdate(w.db, { ticketId: 'low', staff, assignToMe: true, now: NOW });
    expect(w.auditLog.rows).toHaveLength(0);
    expect(row(w, 'low').staffAssignee).toBe(STAFF);

    const r = await staffUpdate(w.db, {
      ticketId: 'low',
      staff,
      status: 'resolved',
      priority: 'high',
      now: NOW,
    });
    expect(r.statusChanged).toBe(true);
    expect(row(w, 'low')).toMatchObject({ status: 'resolved', priority: 'high', closedAt: NOW });
    expect(w.auditLog.rows[0]).toMatchObject({
      orgId: ORG,
      actorId: null,
      action: 'ticket.update',
    });
    expect((w.auditLog.rows[0]!.meta as { staff: boolean }).staff).toBe(true);
    expect(w.staffAudit.rows.map((s) => s.action)).toEqual(['ticket.update', 'ticket.update']);
  });

  it('letting go clears the assignee; reopening clears the closed time', async () => {
    const w = world();
    await staffUpdate(w.db, { ticketId: 'low', staff, assignToMe: true });
    await staffUpdate(w.db, { ticketId: 'low', staff, assignToMe: false });
    expect(row(w, 'low').staffAssignee).toBeNull();
    await staffUpdate(w.db, { ticketId: 'done', staff, status: 'open' });
    expect(row(w, 'done').closedAt).toBeNull();
  });
});

describe('handing it back', () => {
  it('returns it to the organisation with a public note, and it leaves the queue', async () => {
    const w = world();
    await staffComment(w.db, { ticketId: 'low', staff, body: 'On it', visibility: 'public' });
    await handBack(w.db, { ticketId: 'low', staff, note: 'It was a local network problem' });
    expect(row(w, 'low')).toMatchObject({ routedTo: 'org', staffAssignee: null });
    expect(w.ticketComment.rows.at(-1)).toMatchObject({
      fromStaff: true,
      visibility: 'public',
      body: 'Kestrel support handed this back to your team: It was a local network problem',
    });
    expect((await staffQueue(w.db)).map((r) => r.id)).not.toContain('low');
    expect(w.auditLog.rows.at(-1)).toMatchObject({ action: 'ticket.handback', actorId: null });
  });

  it('only a ticket that is with Kestrel can be handed back', async () => {
    await expect(handBack(world().db, { ticketId: 'org-only', staff })).rejects.toThrow(
      /organisation’s team/,
    );
  });
});

describe('who sees which comments', () => {
  const comments = [
    { id: 1, visibility: 'public' },
    { id: 2, visibility: 'internal' },
  ];
  it('the organisation’s team and staff see internal notes; customer viewers do not', () => {
    for (const role of ['owner', 'dev', 'support'] as const)
      expect(visibleComments(comments, role)).toHaveLength(2);
    expect(visibleComments(comments, 'customer_viewer').map((c) => c.id)).toEqual([1]);
  });

  it('staff see everything on a ticket, with staff named only to each other', async () => {
    const w = world();
    await staffComment(w.db, {
      ticketId: 'low',
      staff,
      body: 'Public reply',
      visibility: 'public',
    });
    await staffComment(w.db, {
      ticketId: 'low',
      staff,
      body: 'Internal note',
      visibility: 'internal',
    });
    const t = (await staffTicket(w.db, 'low', STAFF))!;
    expect(t.comments.map((c) => c.visibility)).toEqual(['public', 'internal']);
    expect(t.comments[0]!.author).toBe('steve@kestrel.test');
    expect(t.assignedToMe).toBe(true);
    expect(STAFF_LABEL).toBe('Kestrel support');
    expect(await staffTicket(w.db, 'missing', STAFF)).toBeNull();
  });
});

describe('targets on tickets', () => {
  const HOUR = 3_600_000;
  const at = (hoursAgo: number, now: Date) => new Date(now.getTime() - hoursAgo * HOUR);
  const base = (now: Date, extra: Record<string, unknown> = {}) => ({
    priority: 'urgent',
    createdAt: at(10, now),
    escalatedAt: null as Date | null,
    closedAt: null as Date | null,
    createdBy: 'cust',
    routedTo: 'org',
    ...extra,
  });
  const reply = (when: Date, over: Record<string, unknown> = {}) => ({
    authorId: 'someone',
    fromStaff: false,
    visibility: 'public',
    createdAt: when,
    ...over,
  });

  it('a ticket with the organisation runs from when it was raised, and any team reply answers it', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    const t = base(now);
    expect(slaForTicket(t, [], now).response.state).toBe('overdue');
    const answered = slaForTicket(t, [reply(at(9.5, now))], now);
    expect(answered.response.state).toBe('met');
    expect(answered.next?.kind).toBe('resolution');
    // The person who raised it talking does not count as an answer.
    expect(slaForTicket(t, [reply(at(9, now), { authorId: 'cust' })], now).response.state).toBe(
      'overdue',
    );
  });

  it('a ticket with Kestrel runs from the escalation, and only a Kestrel reply answers it', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    const t = base(now, { routedTo: 'kestrel', escalatedAt: at(0.8, now) });
    // Escalated 48 minutes ago: an urgent reply is due within the hour, with 12 minutes left.
    expect(slaForTicket(t, [], now).response.state).toBe('due_soon');
    expect(slaForTicket({ ...t, escalatedAt: at(0.3, now) }, [], now).response.state).toBe('ok');
    // The organisation's own earlier reply does not stop Kestrel's clock.
    expect(slaForTicket(t, [reply(at(5, now))], now).response.doneAt).toBeNull();
    const kestrel = slaForTicket(
      t,
      [reply(at(0.2, now), { fromStaff: true, authorId: 'staff' })],
      now,
    );
    expect(kestrel.response.state).toBe('met');
  });

  it('a resolved ticket is done', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    const s = slaForTicket(base(now, { closedAt: at(8, now) }), [], now);
    expect(s.next).toBeNull();
  });

  it('puts what is overdue ahead of what is not, within a priority, in the staff queue', async () => {
    const w = world();
    const now = new Date('2026-09-26T12:00:00Z');
    w.ticket.rows.length = 0;
    const kestrelTicket = (id: string, escalatedHoursAgo: number) => ({
      id,
      orgId: ORG,
      title: id,
      body: 'x',
      status: 'open',
      priority: 'urgent',
      routedTo: 'kestrel',
      roomId: null,
      createdBy: 'cust',
      createdByEmail: 'sam@acme.test',
      createdAt: at(escalatedHoursAgo + 1, now),
      updatedAt: now,
      closedAt: null,
      escalatedAt: at(escalatedHoursAgo, now),
      staffAssignee: null,
    });
    // Older, but Kestrel has already replied: its resolution is coming up, nothing is late.
    w.ticket.rows.push(kestrelTicket('answered', 3), kestrelTicket('waiting', 2));
    w.ticketComment.rows.push({
      id: 'c1',
      ticketId: 'answered',
      orgId: ORG,
      authorId: 'staff',
      fromStaff: true,
      visibility: 'public',
      createdAt: at(2.9, now),
    });
    const q = await staffQueue(w.db, {}, now);
    expect(q.map((r) => [r.id, r.sla.next?.clock.state])).toEqual([
      ['waiting', 'overdue'],
      ['answered', 'due_soon'],
    ]);
  });
});
