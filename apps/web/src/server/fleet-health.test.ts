import { describe, expect, it } from 'vitest';
import { fleetHealth, type FleetDb } from './fleet-health';
import { table } from './test-db';

const A = '11111111-1111-4111-8111-111111111111';
const B = '11111111-1111-4111-8111-111111111112';
const C = '11111111-1111-4111-8111-111111111113';
const PROVIDER = '22222222-2222-4222-8222-222222222221';
const NOW = new Date('2026-09-26T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const latest = { stable: '0.2.0', beta: '0.3.0' };

function world() {
  const org = table([
    { id: A, name: 'Acme', kind: 'customer' },
    { id: B, name: 'Beta', kind: 'customer' },
    { id: C, name: 'Calm Co', kind: 'customer' },
    { id: PROVIDER, name: 'AV Partners', kind: 'msp' },
  ]);
  const gateway = table([
    {
      id: 'g1',
      orgId: A,
      name: 'HO gateway',
      siteId: 's1',
      enrolledAt: NOW,
      lastSeenAt: minutesAgo(1),
      version: '0.2.0',
      channel: 'stable',
    },
    {
      id: 'g2',
      orgId: A,
      name: 'Warehouse gateway',
      siteId: 's2',
      enrolledAt: NOW,
      lastSeenAt: minutesAgo(120),
      version: '0.1.0',
      channel: 'stable',
    },
    {
      id: 'g3',
      orgId: B,
      name: 'Beta gateway',
      siteId: 's3',
      enrolledAt: NOW,
      lastSeenAt: minutesAgo(600),
      version: '0.3.0',
      channel: 'beta',
    },
    {
      id: 'g4',
      orgId: C,
      name: 'Calm gateway',
      siteId: 's4',
      enrolledAt: NOW,
      lastSeenAt: minutesAgo(0.5),
      version: '0.2.0',
      channel: 'stable',
    },
    {
      id: 'g5',
      orgId: B,
      name: 'Not enrolled yet',
      siteId: 's3',
      enrolledAt: null,
      lastSeenAt: null,
      version: null,
      channel: 'stable',
    },
  ]);
  const site = table([
    { id: 's1', name: 'Head office' },
    { id: 's2', name: 'Warehouse' },
    { id: 's3', name: 'Beta HQ' },
    { id: 's4', name: 'Calm HQ' },
  ]);
  const room = table([
    { id: 'r1', orgId: A, name: 'Boardroom', gatewayId: 'g1' },
    { id: 'r2', orgId: A, name: 'Dock office', gatewayId: 'g2' },
    { id: 'r3', orgId: A, name: 'Stores', gatewayId: 'g2' },
    { id: 'r4', orgId: B, name: 'Studio', gatewayId: 'g3' },
  ]);
  const incident = table([
    {
      id: 'i1',
      orgId: A,
      status: 'open',
      severity: 'warning',
      title: 'Display offline',
      roomId: 'r1',
      openedAt: minutesAgo(30),
      occurrences: 2,
      acknowledgedAt: null,
    },
    {
      id: 'i2',
      orgId: A,
      status: 'open',
      severity: 'critical',
      title: 'Gateway offline',
      roomId: null,
      openedAt: minutesAgo(100),
      occurrences: 1,
      acknowledgedAt: minutesAgo(90),
    },
    {
      id: 'i3',
      orgId: B,
      status: 'open',
      severity: 'critical',
      title: 'Gateway offline',
      roomId: null,
      openedAt: minutesAgo(500),
      occurrences: 1,
      acknowledgedAt: null,
    },
    {
      id: 'i4',
      orgId: PROVIDER,
      status: 'open',
      severity: 'critical',
      title: 'Ignore me',
      roomId: null,
      openedAt: minutesAgo(5),
      occurrences: 1,
      acknowledgedAt: null,
    },
  ]);
  const deployment = table([
    {
      id: 'd1',
      orgId: A,
      roomId: 'r1',
      status: 'failed',
      error: 'Signature check failed',
      createdAt: daysAgo(1),
      finishedAt: daysAgo(1),
    },
    {
      id: 'd2',
      orgId: A,
      roomId: 'r2',
      status: 'rolled_back',
      error: 'Health check failed',
      createdAt: daysAgo(3),
      finishedAt: null,
    },
    {
      id: 'd3',
      orgId: B,
      roomId: 'r4',
      status: 'active',
      error: null,
      createdAt: daysAgo(1),
      finishedAt: daysAgo(1),
    },
    {
      id: 'd4',
      orgId: B,
      roomId: 'r4',
      status: 'failed',
      error: 'old',
      createdAt: daysAgo(20),
      finishedAt: daysAgo(20),
    },
  ]);
  const ticket = table([
    { id: 't1', orgId: A, routedTo: 'kestrel', status: 'open', priority: 'urgent' },
    { id: 't2', orgId: A, routedTo: 'kestrel', status: 'open', priority: 'normal' },
    { id: 't3', orgId: B, routedTo: 'kestrel', status: 'in_progress', priority: 'high' },
    { id: 't4', orgId: B, routedTo: 'org', status: 'open', priority: 'urgent' },
  ]);
  return { org, gateway, site, room, incident, deployment, ticket } as unknown as FleetDb;
}

describe('fleet health', () => {
  it('summarises the whole fleet, customers only', async () => {
    const h = await fleetHealth(world(), NOW, latest);
    expect(h.summary).toEqual({
      organisations: 3,
      gateways: 5,
      gatewaysOnline: 2,
      gatewaysOffline: 2,
      gatewaysBehind: 1,
      openIncidents: 3, // the provider's incident is not a customer's
      criticalIncidents: 2,
      failedDeployments: 2, // the 20 day old one is out of the window, the active one is fine
      urgentTickets: 2, // only tickets with Kestrel
      organisationsNeedingAttention: 2,
    });
  });

  it('lists silent gateways, longest silent first, and not ones that were never enrolled', async () => {
    const h = await fleetHealth(world(), NOW, latest);
    expect(h.offlineGateways.map((g) => g.name)).toEqual(['Beta gateway', 'Warehouse gateway']);
    expect(h.offlineGateways[1]).toMatchObject({
      orgName: 'Acme',
      siteName: 'Warehouse',
      rooms: 2,
      version: '0.1.0',
    });
  });

  it('lists open incidents, critical first then oldest', async () => {
    const h = await fleetHealth(world(), NOW, latest);
    expect(h.incidents.map((i) => i.id)).toEqual(['i3', 'i2', 'i1']);
    expect(h.incidents[2]).toMatchObject({
      roomName: 'Boardroom',
      occurrences: 2,
      acknowledged: false,
    });
    expect(h.incidents[1]!.acknowledged).toBe(true);
  });

  it('lists deployments that did not go live in the last week, newest first', async () => {
    const h = await fleetHealth(world(), NOW, latest);
    expect(h.failedDeployments.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(h.failedDeployments[0]).toMatchObject({
      roomName: 'Boardroom',
      error: 'Signature check failed',
      orgName: 'Acme',
    });
  });

  it('names gateways running behind the newest version on their channel', async () => {
    const h = await fleetHealth(world(), NOW, latest);
    expect(h.behindGateways).toEqual([
      expect.objectContaining({
        name: 'Warehouse gateway',
        version: '0.1.0',
        latest: '0.2.0',
        channel: 'stable',
      }),
    ]);
    // Nothing is "behind" when the newest version is not known.
    const unknown = await fleetHealth(world(), NOW, { stable: null, beta: null });
    expect(unknown.behindGateways).toEqual([]);
  });

  it('ranks the organisations that need attention, worst first, and leaves calm ones out', async () => {
    const h = await fleetHealth(world(), NOW, latest);
    expect(h.attention.map((r) => r.orgName)).toEqual(['Acme', 'Beta']);
    expect(h.attention[0]).toEqual({
      orgId: A,
      orgName: 'Acme',
      offlineGateways: 1,
      criticalIncidents: 1,
      openIncidents: 2,
      failedDeployments: 2,
    });
    expect(h.attention.some((r) => r.orgName === 'Calm Co')).toBe(false);
  });

  it('is empty and calm with no customers', async () => {
    const empty = {
      org: table([]),
      gateway: table([]),
      site: table([]),
      room: table([]),
      incident: table([]),
      deployment: table([]),
      ticket: table([]),
    } as unknown as FleetDb;
    const h = await fleetHealth(empty, NOW, latest);
    expect(h.summary.organisationsNeedingAttention).toBe(0);
    expect(h.attention).toEqual([]);
  });
});
