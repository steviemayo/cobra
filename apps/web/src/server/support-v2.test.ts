import { beforeAll, describe, expect, it } from 'vitest';
import { generateSealKey } from '@kestrel/crypto';
import {
  autoTicket,
  createRule,
  deleteRule,
  updateRule,
  type AutomationDb,
} from './ticket-automation';
import {
  createConnector,
  handleEmailIn,
  handleInbound,
  mapStatus,
  mirrorTicket,
  rotateInboundSecret,
  simulateDemoReply,
  type ItsmDb,
} from './itsm-service';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const MSP = '77777777-7777-4777-8777-777777777771';
const SITE = '22222222-2222-4222-8222-222222222222';
const ROOM = '33333333-3333-4333-8333-333333333331';
const ROOM2 = '33333333-3333-4333-8333-333333333332';
const GW = '99999999-9999-4999-8999-999999999991';
const DEV = '44444444-4444-4444-8444-444444444441';
const NOW = new Date('2026-09-30T10:00:00Z');
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);

beforeAll(() => {
  process.env.KESTREL_SECRETS_KEY = generateSealKey();
});

function world() {
  const ticketRule = table([]);
  const incident = table([]);
  const ticket = table([]);
  const ticketComment = table([]);
  const room = table([
    { id: ROOM, orgId: ORG, siteId: SITE, name: 'Boardroom' },
    { id: ROOM2, orgId: ORG, siteId: SITE, name: 'Studio' },
  ]);
  const mspGrant = table([{ id: 'g1', mspOrgId: MSP, customerOrgId: ORG, status: 'active' }]);
  const itsmConnector = table([]);
  const itsmLink = table([]);
  const itsmSyncLog = table([]);
  const db = {
    ticketRule,
    incident,
    ticket,
    ticketComment,
    room,
    mspGrant,
    itsmConnector,
    itsmLink,
    itsmSyncLog,
  } as unknown as AutomationDb & ItsmDb;
  return { db, ticketRule, incident, ticket, ticketComment, itsmConnector, itsmLink, itsmSyncLog };
}

const inc = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  orgId: ORG,
  roomId: ROOM,
  gatewayId: null,
  kind: 'device_offline',
  subject: `device:${DEV}`,
  severity: 'warning',
  status: 'open',
  title: 'Projector is offline',
  detail: 'No answer.',
  openedAt: at(0),
  ...over,
});

describe('auto-ticket rules', () => {
  it('raises a ticket once an incident has been open long enough, with the rule priority and route', async () => {
    const w = world();
    await createRule(w.db, ORG, {
      name: 'Offline devices',
      kinds: ['device_offline'],
      afterMinutes: 10,
      priority: 'high',
      routeTo: 'kestrel',
    });
    const i = inc();
    w.incident.rows.push(i);
    expect((await autoTicket(w.db, at(5))).created).toHaveLength(0);
    const r = await autoTicket(w.db, at(11));
    expect(r.created).toHaveLength(1);
    expect(w.ticket.rows[0]).toMatchObject({
      incidentId: i.id,
      deviceId: DEV,
      priority: 'high',
      routedTo: 'kestrel',
      title: 'Projector is offline',
    });
    expect(w.ticket.rows[0]!.escalatedAt).toEqual(at(11));
    // A second pass does not raise it again.
    expect((await autoTicket(w.db, at(20))).created).toHaveLength(0);
    expect(w.ticket.rows).toHaveLength(1);
  });

  it('respects severity, kind and site, and takes the first rule that matches', async () => {
    const w = world();
    await createRule(w.db, ORG, {
      name: 'Critical only',
      minSeverity: 'critical',
      afterMinutes: 0,
      priority: 'urgent',
    });
    await createRule(w.db, ORG, {
      name: 'Anything at another site',
      siteIds: ['99999999-9999-4999-8999-999999999999'],
      afterMinutes: 0,
    });
    await createRule(w.db, ORG, {
      name: 'Warnings',
      kinds: ['device_offline'],
      afterMinutes: 0,
      priority: 'low',
    });
    w.incident.rows.push(inc());
    await autoTicket(w.db, at(1));
    expect(w.ticket.rows[0]).toMatchObject({ priority: 'low' });
  });

  it('raises one ticket for a gateway outage, not one for every device behind it', async () => {
    const w = world();
    await createRule(w.db, ORG, { name: 'All', afterMinutes: 0 });
    w.incident.rows.push(
      inc({
        id: 'gw',
        kind: 'gateway_offline',
        roomId: null,
        gatewayId: GW,
        subject: GW,
        title: 'Gateway offline',
      }),
      inc({ id: 'd1', gatewayId: GW }),
      inc({ id: 'd2', gatewayId: GW, roomId: ROOM2, subject: `device:${crypto.randomUUID()}` }),
    );
    const r = await autoTicket(w.db, at(1));
    expect(r.created).toHaveLength(1);
    expect(r.grouped).toBe(2);
    expect(w.ticket.rows[0]!.title).toBe('Gateway offline');
  });

  it('raises one ticket for a group outage, not one for every device in it', async () => {
    const w = world();
    await createRule(w.db, ORG, { name: 'All', afterMinutes: 0 });
    w.incident.rows.push(
      inc({
        id: 'grp',
        kind: 'group_outage',
        roomId: null,
        gatewayId: GW,
        subject: `group:${GW}:10.0.1.0/24`,
        severity: 'critical',
        title: '2 devices on 10.0.1.0/24 stopped answering together',
      }),
      inc({ id: 'd1', gatewayId: GW, parentId: 'grp' }),
      inc({
        id: 'd2',
        gatewayId: GW,
        roomId: ROOM2,
        subject: `device:${crypto.randomUUID()}`,
        parentId: 'grp',
      }),
    );
    const r = await autoTicket(w.db, at(1));
    expect(r.created).toHaveLength(1);
    expect(r.grouped).toBe(2);
    expect(w.ticket.rows[0]).toMatchObject({ incidentId: 'grp' });
  });

  it('adds a second fault in the same room to the open ticket instead of raising another', async () => {
    const w = world();
    await createRule(w.db, ORG, { name: 'All', afterMinutes: 0 });
    w.incident.rows.push(inc({ id: 'a' }));
    await autoTicket(w.db, at(1));
    w.incident.rows.push(
      inc({ id: 'b', title: 'Display is offline', subject: `device:${crypto.randomUUID()}` }),
    );
    const r = await autoTicket(w.db, at(2));
    expect(r.created).toHaveLength(0);
    expect(w.ticket.rows).toHaveLength(1);
    expect(w.ticketComment.rows[0]).toMatchObject({ visibility: 'internal' });
    expect(String(w.ticketComment.rows[0]!.body)).toContain('Display is offline');
    // Not added twice.
    await autoTicket(w.db, at(3));
    expect(w.ticketComment.rows).toHaveLength(1);
  });

  it('escalates a ticket nobody has answered, once, and leaves an answered one alone', async () => {
    const w = world();
    await createRule(w.db, ORG, {
      name: 'Offline',
      afterMinutes: 0,
      priority: 'normal',
      escalateAfterMinutes: 30,
      escalatePriority: 'urgent',
      escalateTo: 'kestrel',
    });
    w.incident.rows.push(inc());
    await autoTicket(w.db, at(1));
    expect((await autoTicket(w.db, at(20))).escalated).toHaveLength(0);
    const seen: string[] = [];
    const r = await autoTicket(w.db, at(40), async (t, e) => void seen.push(`${e}:${t.priority}`));
    expect(r.escalated).toHaveLength(1);
    expect(w.ticket.rows[0]).toMatchObject({
      priority: 'urgent',
      routedTo: 'kestrel',
      ruleEscalated: true,
    });
    expect(seen).toEqual(['ticket.updated:urgent']);
    expect((await autoTicket(w.db, at(90))).escalated).toHaveLength(0);

    const w2 = world();
    await createRule(w2.db, ORG, { name: 'Offline', afterMinutes: 0, escalateAfterMinutes: 30 });
    w2.incident.rows.push(inc());
    await autoTicket(w2.db, at(1));
    await w2.ticketComment.create({
      data: { orgId: ORG, ticketId: w2.ticket.rows[0]!.id, body: 'On it', visibility: 'public' },
    });
    expect((await autoTicket(w2.db, at(60))).escalated).toHaveLength(0);
  });

  it('only routes to a provider the organisation is connected to', async () => {
    const w = world();
    expect((await createRule(w.db, ORG, { name: 'To provider', routeTo: `msp:${MSP}` })).ok).toBe(
      true,
    );
    expect(
      (
        await createRule(w.db, ORG, {
          name: 'To a stranger',
          routeTo: 'msp:99999999-9999-4999-8999-999999999999',
        })
      ).ok,
    ).toBe(false);
    expect((await createRule(w.db, ORG, { name: 'Odd', routeTo: 'somewhere' })).ok).toBe(false);
    expect((await createRule(w.db, ORG, { name: 'Bad priority', priority: 'panic' })).ok).toBe(
      false,
    );
  });

  it('updates and deletes only its own organisation rules', async () => {
    const w = world();
    const r = await createRule(w.db, ORG, { name: 'One' });
    if (!r.ok) throw new Error(r.message);
    expect((await updateRule(w.db, ORG, r.value.id, { enabled: false })).ok).toBe(true);
    expect(w.ticketRule.rows[0]!.enabled).toBe(false);
    expect((await deleteRule(w.db, '99999999-9999-4999-8999-999999999999', r.value.id)).ok).toBe(
      false,
    );
    expect((await deleteRule(w.db, ORG, r.value.id)).ok).toBe(true);
  });
});

describe('status names', () => {
  it('maps what outside desks call things onto the four Kestrel statuses', () => {
    expect(mapStatus('New')).toBe('open');
    expect(mapStatus('Work in progress')).toBe('in_progress');
    expect(mapStatus('On hold')).toBe('in_progress');
    expect(mapStatus('Resolved')).toBe('resolved');
    expect(mapStatus('Cancelled')).toBe('closed');
    expect(mapStatus('mystery')).toBeNull();
  });
});

const deps = () => {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    deps: {
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      resolve: async () => ['93.184.216.34'],
    },
  };
};

async function ticketWith(w: ReturnType<typeof world>) {
  return w.ticket.create({
    data: {
      orgId: ORG,
      roomId: ROOM,
      title: 'Projector is offline',
      body: 'No answer.',
      status: 'open',
      priority: 'high',
      routedTo: 'org',
      createdAt: NOW,
    },
  }) as never;
}

describe('service desk connectors', () => {
  it('sends a signed webhook and records it, and never throws when the desk is down', async () => {
    const w = world();
    const c = await createConnector(
      w.db,
      {
        orgId: ORG,
        name: 'Desk',
        type: 'webhook',
        url: 'https://desk.example.com/hook',
        secret: 'shared-secret-1',
        userId: null,
      },
      { resolve: async () => ['93.184.216.34'] },
    );
    if (!c.ok) throw new Error(c.message);
    const t = await ticketWith(w);
    const d = deps();
    await mirrorTicket(w.db, d.deps as never, t, 'ticket.created', undefined, NOW);
    expect(d.calls).toHaveLength(1);
    const headers = d.calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-kestrel-signature']).toMatch(/^sha256=/);
    expect(JSON.parse(String(d.calls[0]!.init.body))).toMatchObject({
      event: 'ticket.created',
      ticket: { title: 'Projector is offline', room: 'Boardroom' },
    });
    expect(w.itsmSyncLog.rows[0]).toMatchObject({ direction: 'out', ok: true });
    const failing = {
      ...d.deps,
      fetch: (async () => {
        throw new Error('boom');
      }) as unknown as typeof fetch,
    };
    await mirrorTicket(w.db, failing as never, t, 'ticket.updated', undefined, NOW);
    expect(w.itsmSyncLog.rows.at(-1)).toMatchObject({ ok: false });
  });

  it('refuses an address that is not public', async () => {
    const w = world();
    const r = await createConnector(
      w.db,
      {
        orgId: ORG,
        name: 'Desk',
        type: 'webhook',
        url: 'https://intranet.local/hook',
        userId: null,
      },
      { resolve: async () => ['10.0.0.5'] },
    );
    expect(r.ok).toBe(false);
    expect(
      (await createConnector(w.db, { orgId: ORG, name: 'No url', type: 'webhook', userId: null }))
        .ok,
    ).toBe(false);
  });

  it('takes a status and a comment back, links by outside reference, and refuses a wrong secret', async () => {
    const w = world();
    const c = await createConnector(
      w.db,
      {
        orgId: ORG,
        name: 'Desk',
        type: 'webhook',
        url: 'https://desk.example.com/hook',
        userId: null,
      },
      { resolve: async () => ['93.184.216.34'] },
    );
    if (!c.ok || !c.value.inboundSecret) throw new Error('no connector');
    const t = (await ticketWith(w)) as { id: string };
    const call = (secret: string, body: unknown) =>
      handleInbound(w.db, { connectorId: c.value.id, secret, body }, at(5));
    expect((await call('wrong', { ticketId: t.id })).ok).toBe(false);
    // First call links the outside reference to the ticket and moves it along.
    expect(
      (
        await call(c.value.inboundSecret, {
          ticketId: t.id,
          externalRef: 'INC0012',
          status: 'In Progress',
          comment: 'Engineer booked',
          author: 'Desk',
        })
      ).ok,
    ).toBe(true);
    expect(w.ticket.rows[0]).toMatchObject({ status: 'in_progress' });
    expect(w.itsmLink.rows[0]).toMatchObject({ externalRef: 'INC0012' });
    expect(String(w.ticketComment.rows[0]!.body)).toBe('Desk: Engineer booked');
    // Later calls can use the outside reference alone.
    expect(
      (await call(c.value.inboundSecret, { externalRef: 'INC0012', status: 'Resolved' })).ok,
    ).toBe(true);
    expect(w.ticket.rows[0]).toMatchObject({ status: 'resolved' });
    expect(w.ticket.rows[0]!.closedAt).toEqual(at(5));
    expect((await call(c.value.inboundSecret, { externalRef: 'NOPE' })).ok).toBe(false);
    expect((await call(c.value.inboundSecret, { status: 'x'.repeat(100) })).ok).toBe(false);
    // A new secret shuts the old one out.
    const rotated = await rotateInboundSecret(w.db, ORG, c.value.id);
    if (!rotated.ok) throw new Error('no rotate');
    expect((await call(c.value.inboundSecret, { externalRef: 'INC0012' })).ok).toBe(false);
    expect((await call(rotated.value.inboundSecret, { externalRef: 'INC0012' })).ok).toBe(true);
  });

  it('shows the whole round trip with the demo desk', async () => {
    const w = world();
    const c = await createConnector(w.db, {
      orgId: ORG,
      name: 'Demo desk',
      type: 'demo',
      userId: null,
    });
    if (!c.ok) throw new Error(c.message);
    const t = (await ticketWith(w)) as { id: string };
    await mirrorTicket(w.db, deps().deps as never, t as never, 'ticket.created', undefined, NOW);
    expect(String(w.itsmLink.rows[0]!.externalRef)).toMatch(/^DEMO-\d+$/);
    expect(
      (
        await simulateDemoReply(
          w.db,
          { orgId: ORG, connectorId: c.value.id, ticketId: t.id, action: 'work' },
          at(5),
        )
      ).ok,
    ).toBe(true);
    expect(w.ticket.rows[0]).toMatchObject({ status: 'in_progress' });
    expect(
      (
        await simulateDemoReply(
          w.db,
          { orgId: ORG, connectorId: c.value.id, ticketId: t.id, action: 'resolve' },
          at(6),
        )
      ).ok,
    ).toBe(true);
    expect(w.ticket.rows[0]).toMatchObject({ status: 'resolved' });
    expect(w.itsmSyncLog.rows.map((r) => r.direction)).toEqual(['out', 'in', 'in']);
    const w2 = world();
    const web = await createConnector(
      w2.db,
      {
        orgId: ORG,
        name: 'Real',
        type: 'webhook',
        url: 'https://desk.example.com/hook',
        userId: null,
      },
      { resolve: async () => ['93.184.216.34'] },
    );
    if (!web.ok) throw new Error('x');
    expect(
      (
        await simulateDemoReply(w2.db, {
          orgId: ORG,
          connectorId: web.value.id,
          ticketId: t.id,
          action: 'work',
        })
      ).ok,
    ).toBe(false);
  });

  it('turns mail forwarded to an email-in connector into a ticket, and refuses other connectors', async () => {
    const w = world();
    const c = await createConnector(w.db, {
      orgId: ORG,
      name: 'Support mailbox',
      type: 'email_in',
      userId: null,
    });
    if (!c.ok || !c.value.inboundSecret) throw new Error('no connector');
    const r = await handleEmailIn(
      w.db,
      {
        connectorId: c.value.id,
        secret: c.value.inboundSecret,
        body: { from: 'sam@example.com', subject: 'Screen flickers', text: 'Since Monday.' },
      },
      NOW,
    );
    expect(r.ok).toBe(true);
    expect(w.ticket.rows[0]).toMatchObject({
      title: 'Screen flickers',
      body: 'Since Monday.',
      createdByEmail: 'sam@example.com',
      orgId: ORG,
    });
    expect(
      (await handleEmailIn(w.db, { connectorId: c.value.id, secret: 'nope', body: {} })).ok,
    ).toBe(false);
    const demo = await createConnector(w.db, {
      orgId: ORG,
      name: 'Demo',
      type: 'demo',
      userId: null,
    });
    if (!demo.ok || !demo.value.inboundSecret) throw new Error('x');
    expect(
      (
        await handleEmailIn(w.db, {
          connectorId: demo.value.id,
          secret: demo.value.inboundSecret,
          body: { from: 'a@b.c', subject: 's' },
        })
      ).ok,
    ).toBe(false);
  });
});
