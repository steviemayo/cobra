import { describe, expect, it } from 'vitest';
import { DriverRequestInput } from '@kestrel/model';
import {
  DriverRequestError,
  createDriverRequest,
  staffRequests,
  updateRequest,
  type RequestDb,
} from './driver-requests';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '11111111-1111-4111-8111-111111111112';
const USER = { id: '22222222-2222-4222-8222-222222222222', email: 'Owner@Example.com' };
const STAFF = '33333333-3333-4333-8333-333333333333';

function world() {
  const t = {
    driverRequest: table([]),
    ticket: table([]),
    ticketComment: table([]),
    device: table([]),
    org: table([
      { id: ORG, name: 'Acme' },
      { id: OTHER, name: 'Globex' },
    ]),
    customDriver: table([]),
    customDriverVersion: table([]),
  };
  return { db: t as unknown as RequestDb, ...t };
}

const request = (over: Record<string, unknown> = {}) =>
  DriverRequestInput.parse({
    make: 'Ubiquiti',
    model: 'UniFi U6 Pro',
    category: 'wireless_ap',
    ...over,
  });

const driver = (over: Record<string, unknown> = {}) => ({
  id: 'unifi-u6',
  name: 'UniFi U6',
  make: 'Ubiquiti',
  model: 'U6 Pro',
  categories: ['wireless_ap'],
  transport: { type: 'udp', port: 9000 },
  commands: { 'command.reboot': { send: 'REBOOT' } },
  ...over,
});

describe('requesting a driver', () => {
  it('raises a ticket routed to Kestrel and records the request against the organisation', async () => {
    const w = world();
    const res = await createDriverRequest(w.db, { orgId: ORG, by: USER, request: request() });
    expect(w.ticket.rows).toHaveLength(1);
    expect(w.ticket.rows[0]).toMatchObject({
      orgId: ORG,
      routedTo: 'kestrel',
      title: 'Driver request: Ubiquiti UniFi U6 Pro',
      createdByEmail: 'owner@example.com',
    });
    expect(w.driverRequest.rows[0]).toMatchObject({
      id: res.id,
      orgId: ORG,
      ticketId: res.ticketId,
      category: 'wireless_ap',
      status: 'open',
    });
    expect(String(w.ticket.rows[0]!.body)).toContain('Wireless access point');
  });

  it('refuses a second open request for the same make and model, however it is spelled', async () => {
    const w = world();
    await createDriverRequest(w.db, { orgId: ORG, by: USER, request: request() });
    await expect(
      createDriverRequest(w.db, {
        orgId: ORG,
        by: USER,
        request: request({ make: ' ubiquiti ', model: 'UNIFI  U6 pro' }),
      }),
    ).rejects.toBeInstanceOf(DriverRequestError);
    // Another organisation may ask for the same device.
    await createDriverRequest(w.db, { orgId: OTHER, by: USER, request: request() });
    expect(w.driverRequest.rows).toHaveLength(2);
  });

  it('will not link a device from another organisation', async () => {
    const w = world();
    const device = '44444444-4444-4444-8444-444444444444';
    w.device.rows.push({ id: device, orgId: OTHER });
    await expect(
      createDriverRequest(w.db, { orgId: ORG, by: USER, request: request({ deviceId: device }) }),
    ).rejects.toThrow('Device not found');
  });

  it('accepts any device category, including network kit, and rejects a made-up one', () => {
    expect(request({ category: 'network_switch' }).category).toBe('network_switch');
    expect(request({ category: 'ups' }).category).toBe('ups');
    expect(() => request({ category: 'toaster' })).toThrow();
    expect(() => request({ docsUrl: 'javascript:alert(1)' })).toThrow();
  });
});

describe('working a request', () => {
  it('saving a driver builds it inside the asking organisation only, and tells the customer', async () => {
    const w = world();
    const { id, ticketId } = await createDriverRequest(w.db, {
      orgId: ORG,
      by: USER,
      request: request(),
    });
    await updateRequest(w.db, { id, staffUserId: STAFF, spec: driver() });
    expect(w.customDriver.rows).toHaveLength(1);
    expect(w.customDriver.rows[0]).toMatchObject({ orgId: ORG, slug: 'unifi-u6' });
    expect(w.driverRequest.rows[0]).toMatchObject({ status: 'built', driverSlug: 'custom:unifi-u6' });
    expect(w.ticketComment.rows[0]).toMatchObject({
      ticketId,
      visibility: 'public',
      fromStaff: true,
    });
    expect(w.ticket.rows[0]).toMatchObject({ status: 'resolved' });
  });

  it('a driver that does not pass the format check is refused and nothing changes', async () => {
    const w = world();
    const { id } = await createDriverRequest(w.db, { orgId: ORG, by: USER, request: request() });
    await expect(
      updateRequest(w.db, { id, staffUserId: STAFF, spec: driver({ commands: {} }) }),
    ).rejects.toBeInstanceOf(DriverRequestError);
    expect(w.driverRequest.rows[0]).toMatchObject({ status: 'open' });
    expect(w.customDriver.rows).toHaveLength(0);
  });

  it('declining says so on the ticket, and in progress only moves the ticket', async () => {
    const w = world();
    const a = await createDriverRequest(w.db, { orgId: ORG, by: USER, request: request() });
    await updateRequest(w.db, { id: a.id, staffUserId: STAFF, status: 'in_progress' });
    expect(w.ticket.rows[0]).toMatchObject({ status: 'in_progress' });
    expect(w.ticketComment.rows).toHaveLength(0);
    await updateRequest(w.db, {
      id: a.id,
      staffUserId: STAFF,
      status: 'declined',
      staffNote: 'No public protocol.',
    });
    expect(String(w.ticketComment.rows[0]!.body)).toContain('No public protocol.');
  });

  it('staff see how many organisations asked for the same device', async () => {
    const w = world();
    await createDriverRequest(w.db, { orgId: ORG, by: USER, request: request() });
    await createDriverRequest(w.db, { orgId: OTHER, by: USER, request: request() });
    const rows = await staffRequests(w.db);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.orgsAsking === 2)).toBe(true);
    expect(rows.map((r) => r.orgName).sort()).toEqual(['Acme', 'Globex']);
  });
});
