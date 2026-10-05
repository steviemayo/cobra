import { describe, expect, it } from 'vitest';
import {
  BROWSE_FEATURE,
  MAX_BROWSES_PER_GATEWAY_MINUTE,
  browseResult,
  requestBrowsePoints,
  type BrowseDb,
} from './browse-points';
import { table } from './test-db';

// Picking a control point from the live device: who may ask, which gateway is asked, and how its
// answer is read back.
const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const GW = '99999999-9999-4999-8999-999999999991';
const DEV = '33333333-3333-4333-8333-333333333333';
const T0 = new Date('2026-10-05T10:00:00Z');

function world() {
  const remoteCommand = table([]);
  const device = table([
    {
      id: DEV,
      orgId: ORG,
      siteId: SITE,
      roomId: null,
      gatewayId: GW,
      name: 'Central CP4',
      kind: 'active',
      control: { kind: 'driver', driverId: 'crestron-4series' },
    },
  ]);
  const gateway = table([
    {
      id: GW,
      orgId: ORG,
      siteId: SITE,
      features: [BROWSE_FEATURE],
      enrolledAt: new Date('2026-01-01T00:00:00Z'),
      lastSeenAt: new Date(T0.getTime() - 1_000),
    },
  ]);
  const db = {
    device,
    gateway,
    remoteCommand,
    room: table([]),
    site: table([]),
    auditLog: table([]),
  } as unknown as BrowseDb;
  return { db, device, gateway, remoteCommand };
}
const ask = (w: ReturnType<typeof world>, siteScope: string[] | null = null, at = T0) =>
  requestBrowsePoints(w.db, { orgId: ORG, deviceId: DEV, siteScope, requestedBy: 'user-1' }, at);

describe('asking a gateway to list a device’s points', () => {
  it('stores a command for the device’s gateway, with no room', async () => {
    const w = world();
    const res = await ask(w);
    expect(res.ok).toBe(true);
    expect(w.remoteCommand.rows).toHaveLength(1);
    expect(w.remoteCommand.rows[0]).toMatchObject({
      gatewayId: GW,
      roomId: null,
      type: 'browse_points',
      args: { deviceId: DEV },
      status: 'pending',
    });
  });

  it('refuses a gateway that is offline or too old to know the command', async () => {
    const offline = world();
    offline.gateway.rows[0]!.lastSeenAt = new Date(T0.getTime() - 60 * 60_000);
    expect(await ask(offline)).toMatchObject({
      ok: false,
      error: expect.stringContaining('offline'),
    });

    const old = world();
    old.gateway.rows[0]!.features = ['discovery'];
    expect(await ask(old)).toMatchObject({ ok: false, error: expect.stringContaining('updating') });
    expect(old.remoteCommand.rows).toHaveLength(0);
  });

  it('refuses a device that is passive, has no browsing driver, or is outside the caller’s sites', async () => {
    const passive = world();
    passive.device.rows[0]!.kind = 'passive';
    expect((await ask(passive)).ok).toBe(false);

    const plain = world();
    plain.device.rows[0]!.control = { kind: 'driver', driverId: 'visca-ip' };
    expect((await ask(plain)).ok).toBe(false);

    const scoped = world();
    expect((await ask(scoped, ['44444444-4444-4444-8444-444444444444'])).ok).toBe(false);
    expect((await ask(scoped, [SITE])).ok).toBe(true);
  });

  it('limits how often one gateway is asked', async () => {
    const w = world();
    for (let i = 0; i < MAX_BROWSES_PER_GATEWAY_MINUTE; i++) expect((await ask(w)).ok).toBe(true);
    expect((await ask(w)).ok).toBe(false);
    expect((await ask(w, null, new Date(T0.getTime() + 61_000))).ok).toBe(true);
  });
});

describe('reading the answer', () => {
  async function answered(output: unknown, status = 'succeeded') {
    const w = world();
    await ask(w);
    Object.assign(w.remoteCommand.rows[0]!, { status, output });
    return { w, id: w.remoteCommand.rows[0]!.id as string };
  }
  const read = (w: ReturnType<typeof world>, id: string, siteScope: string[] | null = null) =>
    browseResult(w.db, { orgId: ORG, commandId: id, siteScope });

  it('returns the listed points and keeps only well-formed ones', async () => {
    const { w, id } = await answered({
      points: [
        { path: 'Device.A.Status', label: 'A', group: 'G', value: 'ONLINE', expect: 'ONLINE' },
        { path: '', label: 'no path', group: 'G' },
        'junk',
      ],
      truncated: true,
    });
    expect(await read(w, id)).toEqual({
      status: 'succeeded',
      error: null,
      points: [
        { path: 'Device.A.Status', label: 'A', group: 'G', value: 'ONLINE', expect: 'ONLINE' },
      ],
      truncated: true,
    });
  });

  it('passes on what the gateway said when it failed, and lists nothing', async () => {
    const { w, id } = await answered({}, 'failed');
    w.remoteCommand.rows[0]!.error = 'The device is offline';
    expect(await read(w, id)).toEqual({
      status: 'failed',
      error: 'The device is offline',
      points: [],
      truncated: false,
    });
  });

  it('does not show another organisation’s or another site’s answer', async () => {
    const { w, id } = await answered({ points: [] });
    expect(
      await browseResult(w.db, {
        orgId: '55555555-5555-4555-8555-555555555555',
        commandId: id,
        siteScope: null,
      }),
    ).toBeNull();
    expect(await read(w, id, ['44444444-4444-4444-8444-444444444444'])).toBeNull();
  });
});
