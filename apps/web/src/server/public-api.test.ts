import { describe, expect, it } from 'vitest';
import { MAX_PAGE, getRoom, listIncidents, listRooms, type PublicApiDb } from './public-api';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '11111111-1111-4111-8111-111111111112';
const SITE = '22222222-2222-4222-8222-222222222221';
const GW = '99999999-9999-4999-8999-999999999991';
const R1 = '33333333-3333-4333-8333-333333333331';
const R2 = '33333333-3333-4333-8333-333333333332';
const REL1 = '44444444-4444-4444-8444-444444444441';
const REL2 = '44444444-4444-4444-8444-444444444442';
const NOW = Date.now();

function world() {
  return {
    room: table([
      {
        id: R1,
        orgId: ORG,
        siteId: SITE,
        gatewayId: GW,
        name: 'Boardroom',
        type: 'meeting',
        kind: 'standard',
        desiredReleaseId: REL2,
        reportedReleaseId: REL1,
        reportedStatus: 'on',
        reportedAt: new Date('2026-09-27T09:00:00Z'),
        // Things that must never leave the server.
        panel: { pinHash: 'secret-hash' },
        hookSecretHash: 'hook-secret',
      },
      { id: R2, orgId: ORG, siteId: SITE, gatewayId: null, name: 'Annex', type: 'training', reportedReleaseId: null, desiredReleaseId: null },
      { id: 'foreign', orgId: OTHER, siteId: 'x', name: 'Not yours', type: 'meeting' },
    ]),
    site: table([{ id: SITE, orgId: ORG, name: 'HQ' }]),
    gateway: table([{ id: GW, orgId: ORG, name: 'Level 2', enrolledAt: new Date(), lastSeenAt: new Date(NOW) }]),
    release: table([
      { id: REL1, orgId: ORG, number: 3 },
      { id: REL2, orgId: ORG, number: 4 },
    ]),
    deviceStatus: table([
      { orgId: ORG, roomId: R1, deviceId: 'dsp', name: 'DSP', online: false, since: new Date('2026-09-27T08:00:00Z'), host: '10.0.0.5' },
      { orgId: ORG, roomId: R1, deviceId: 'display', name: 'Display', online: true, since: new Date('2026-09-26T08:00:00Z') },
    ]),
    incident: table([
      { id: 'i1', orgId: ORG, roomId: R1, kind: 'device_offline', severity: 'warning', status: 'open', title: 'DSP is offline', detail: 'x', openedAt: new Date('2026-09-27T08:05:00Z'), resolvedAt: null, acknowledgedAt: null },
      { id: 'i2', orgId: ORG, roomId: R2, kind: 'room_fault', severity: 'critical', status: 'resolved', title: 'Fault', detail: null, openedAt: new Date('2026-09-26T08:05:00Z'), resolvedAt: new Date('2026-09-26T09:00:00Z'), acknowledgedAt: new Date() },
      { id: 'i3', orgId: OTHER, roomId: null, kind: 'gateway_offline', severity: 'critical', status: 'open', title: 'Theirs', detail: null, openedAt: new Date(), resolvedAt: null, acknowledgedAt: null },
    ]),
  } as unknown as PublicApiDb;
}

describe('rooms', () => {
  it('lists the organisation’s rooms with site, gateway and release numbers', async () => {
    const rooms = await listRooms(world(), ORG);
    expect(rooms.map((r) => r.name)).toEqual(['Annex', 'Boardroom']);
    expect(rooms.find((r) => r.name === 'Boardroom')).toEqual({
      id: R1,
      name: 'Boardroom',
      type: 'meeting',
      kind: 'standard',
      site: { id: SITE, name: 'HQ' },
      gateway: { id: GW, name: 'Level 2', status: 'online' },
      release: { running: 3, target: 4 },
      status: 'on',
      reportedAt: '2026-09-27T09:00:00.000Z',
    });
    expect(rooms.find((r) => r.name === 'Annex')).toMatchObject({ kind: 'standard', gateway: null, release: { running: null, target: null }, status: null, reportedAt: null });
  });

  it('never shows another organisation’s rooms, or anything private', async () => {
    const text = JSON.stringify(await listRooms(world(), ORG));
    expect(text).not.toContain('Not yours');
    expect(text).not.toContain('secret-hash');
    expect(text).not.toContain('hook-secret');
    expect(text).not.toContain('panel');
  });

  it('gives one room with its devices and its open problems', async () => {
    const room = (await getRoom(world(), ORG, R1))!;
    expect(room.devices).toEqual([
      { id: 'display', name: 'Display', online: true, since: '2026-09-26T08:00:00.000Z' },
      { id: 'dsp', name: 'DSP', online: false, since: '2026-09-27T08:00:00.000Z' },
    ]);
    expect(room.openIncidents).toBe(1);
    expect(JSON.stringify(room)).not.toContain('10.0.0.5');
  });

  it('says nothing about a room that is not the organisation’s', async () => {
    expect(await getRoom(world(), ORG, 'foreign')).toBeNull();
    expect(await getRoom(world(), ORG, '33333333-3333-4333-8333-3333333333ff')).toBeNull();
  });

  it('shows an offline gateway as offline', async () => {
    const db = world();
    (db.gateway as unknown as { rows: { lastSeenAt: Date }[] }).rows[0]!.lastSeenAt = new Date(NOW - 10 * 60_000);
    expect((await listRooms(db, ORG)).find((r) => r.name === 'Boardroom')!.gateway!.status).toBe('offline');
  });
});

describe('incidents', () => {
  it('lists the organisation’s incidents, newest first, with their rooms', async () => {
    const list = await listIncidents(world(), ORG, {});
    expect(list.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(list[0]).toEqual({
      id: 'i1',
      kind: 'device_offline',
      severity: 'warning',
      status: 'open',
      title: 'DSP is offline',
      detail: 'x',
      room: { id: R1, name: 'Boardroom' },
      openedAt: '2026-09-27T08:05:00.000Z',
      resolvedAt: null,
      acknowledged: false,
    });
    expect(list[1]).toMatchObject({ acknowledged: true, resolvedAt: '2026-09-26T09:00:00.000Z' });
  });

  it('filters by status and room, and limits the page', async () => {
    expect((await listIncidents(world(), ORG, { status: 'open' })).map((i) => i.id)).toEqual(['i1']);
    expect((await listIncidents(world(), ORG, { roomId: R2 })).map((i) => i.id)).toEqual(['i2']);
    expect(await listIncidents(world(), ORG, { limit: 1 })).toHaveLength(1);
    expect(await listIncidents(world(), ORG, { limit: 10_000 })).toHaveLength(2);
    expect(MAX_PAGE).toBe(200);
  });
});
