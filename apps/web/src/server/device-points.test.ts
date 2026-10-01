import { describe, expect, it } from 'vitest';
import type { ControlPoint } from '@kestrel/model';
import {
  applyWatchedPoints,
  pointValuesPatch,
  pointsOf,
  setDevicePoints,
  validatePoints,
  type PointsDb,
} from './device-points';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const ROOM = '33333333-3333-4333-8333-333333333331';
const DEV = '00000000-0000-4000-8000-000000000001';
const GW = '99999999-9999-4999-8999-999999999991';
const NOW = new Date('2026-10-01T10:00:00Z');
const QSYS = { kind: 'driver', driverId: 'qsys-core' };

const gain: ControlPoint = {
  id: 'g',
  name: 'Boardroom gain',
  type: 'level',
  address: { component: 'Boardroom', control: 'gain' },
  min: -100,
  max: 20,
  watch: { min: 30, severity: 'warning' },
};
const mute: ControlPoint = {
  id: 'm',
  name: 'Boardroom mute',
  type: 'mute',
  address: { component: 'Boardroom', control: 'mute' },
  watch: { expect: false, severity: 'critical' },
};
const router: ControlPoint = {
  id: 'r2',
  name: 'Router output 2',
  type: 'select',
  address: { component: 'Router', control: 'select.2' },
};
const named: ControlPoint = {
  id: 'mic',
  name: 'Mic mute',
  type: 'generic',
  valueType: 'boolean',
  address: { control: 'Mic Mute' },
  watch: { expect: false, severity: 'warning' },
};

describe('which points a driver can take', () => {
  it('accepts a Q-SYS gain, a router output and a named control with no component', () => {
    expect(validatePoints(QSYS, [gain, mute, router, named])).toBeNull();
    expect(validatePoints(QSYS, [])).toBeNull();
  });

  it('wants the driver chosen first, and one that has control points', () => {
    expect(validatePoints(null, [gain])).toMatch(/Choose the device’s driver/);
    expect(validatePoints({ kind: 'generic', protocol: 'tcp' }, [gain])).toMatch(
      /Choose the device’s driver/,
    );
    expect(validatePoints({ kind: 'driver', driverId: 'pjlink' }, [gain])).toMatch(
      /does not support control points/,
    );
  });

  it('wants the parts of the address the driver needs, except where it says they are optional', () => {
    expect(validatePoints(QSYS, [{ ...gain, address: { component: 'Boardroom' } }])).toMatch(
      /needs its control name/,
    );
    // A level or mute is a component's control; only a generic point may be a named control.
    expect(validatePoints(QSYS, [{ ...gain, address: { control: 'gain' } }])).toMatch(
      /needs its component name/,
    );
  });

  it('refuses duplicate ids and an empty range', () => {
    expect(validatePoints(QSYS, [gain, { ...mute, id: 'g' }])).toMatch(/share the id/);
    expect(validatePoints(QSYS, [{ ...gain, min: 10, max: 10 }])).toMatch(/minimum must be below/);
  });

  it('drops stored points that no longer parse', () => {
    expect(pointsOf([gain, { nonsense: true }, 'x'])).toEqual([gain]);
    expect(pointsOf(null)).toEqual([]);
  });
});

function world(extra: Record<string, unknown> = {}) {
  const device = table([
    {
      id: DEV,
      orgId: ORG,
      roomId: ROOM,
      name: 'Core 1',
      kind: 'active',
      control: QSYS,
      version: 3,
      points: [],
      pointValues: { g: 50 },
      ...extra,
    },
  ]);
  return { device, deviceEvent: table([]), incident: table([]) };
}
const asDb = (w: ReturnType<typeof world>) => w as unknown as PointsDb;

describe('saving points', () => {
  it('stores them, clears the old readings and bumps the version so the gateway fetches the change', async () => {
    const w = world();
    const res = await setDevicePoints(
      asDb(w),
      { orgId: ORG, deviceId: DEV, actorId: null, points: [gain, mute] },
      NOW,
    );
    expect(res).toEqual({ ok: true });
    expect(w.device.rows[0]).toMatchObject({ version: 4, points: [gain, mute] });
    expect(w.device.rows[0]!.pointValues).not.toEqual({ g: 50 });
    expect(w.deviceEvent.rows[0]).toMatchObject({
      type: 'field_changed',
      field: 'control points',
      newValue: '2 points',
    });
  });

  it('refuses a recorded-only device, another organisation’s device and a bad point', async () => {
    const w = world({ kind: 'passive' });
    expect(
      await setDevicePoints(asDb(w), { orgId: ORG, deviceId: DEV, actorId: null, points: [gain] }),
    ).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Only a monitored device/),
    });
    const w2 = world();
    expect(
      await setDevicePoints(asDb(w2), {
        orgId: '11111111-1111-4111-8111-111111111112',
        deviceId: DEV,
        actorId: null,
        points: [],
      }),
    ).toMatchObject({ ok: false, message: 'No such device' });
    expect(
      await setDevicePoints(asDb(w2), {
        orgId: ORG,
        deviceId: DEV,
        actorId: null,
        points: [{ ...gain, address: {} }],
      }),
    ).toMatchObject({ ok: false });
    expect(w2.device.rows[0]!.version).toBe(3);
  });
});

describe('readings', () => {
  it('are stored when they change, and not when they do not', () => {
    expect(pointValuesPatch({ pointValues: { g: 50 } }, { points: { g: 50 } })).toBeUndefined();
    expect(pointValuesPatch({ pointValues: { g: 50 } }, { points: { g: 40 } })).toEqual({ g: 40 });
    expect(pointValuesPatch({ pointValues: null }, {})).toBeUndefined();
  });
});

describe('watched points', () => {
  const row = (w: ReturnType<typeof world>) => w.device.rows[0] as never;
  const rep = (online: boolean, watched: unknown[]) => ({ online, watched }) as never;

  it('raise an incident for a point out of bounds, and resolve it when it is fine', async () => {
    const w = world({ points: [gain, mute] });
    const bad = rep(true, [
      {
        pointId: 'g',
        name: 'Boardroom gain',
        ok: false,
        message: 'Boardroom gain is 10, below 30',
        severity: 'warning',
      },
      { pointId: 'm', name: 'Boardroom mute', ok: true, severity: 'critical' },
    ]);
    const jobs = await applyWatchedPoints(asDb(w), row(w), { id: GW }, bad, NOW);
    expect(jobs).toHaveLength(1);
    expect(w.incident.rows).toHaveLength(1);
    expect(w.incident.rows[0]).toMatchObject({
      kind: 'point_alert',
      subject: `device:${DEV}:g`,
      roomId: ROOM,
      severity: 'warning',
      title: 'Core 1: Boardroom gain',
    });
    expect(String(w.incident.rows[0]!.detail)).toContain('below 30');

    const fine = rep(true, [
      { pointId: 'g', name: 'Boardroom gain', ok: true, severity: 'warning' },
    ]);
    const later = await applyWatchedPoints(
      asDb(w),
      row(w),
      { id: GW },
      fine,
      new Date(NOW.getTime() + 60_000),
    );
    expect(later).toEqual([{ incidentId: w.incident.rows[0]!.id, event: 'resolved' }]);
    expect(w.incident.rows[0]!.status).toBe('resolved');
  });

  it('are left alone while the device is offline, and say nothing for a point with no reading', async () => {
    const w = world({ points: [gain] });
    await applyWatchedPoints(
      asDb(w),
      row(w),
      { id: GW },
      rep(true, [{ pointId: 'g', name: 'g', ok: false, severity: 'warning' }]),
      NOW,
    );
    expect(w.incident.rows[0]!.status).toBe('open');
    // Offline: neither raised nor resolved.
    expect(await applyWatchedPoints(asDb(w), row(w), { id: GW }, rep(false, []), NOW)).toEqual([]);
    expect(w.incident.rows[0]!.status).toBe('open');
    // Online but nothing reported for the point (no reading yet): still open, not resolved.
    expect(await applyWatchedPoints(asDb(w), row(w), { id: GW }, rep(true, []), NOW)).toEqual([]);
    expect(w.incident.rows[0]!.status).toBe('open');
  });

  it('are closed when the watch is taken off the point or the point is removed', async () => {
    const w = world({ points: [gain] });
    await applyWatchedPoints(
      asDb(w),
      row(w),
      { id: GW },
      rep(true, [{ pointId: 'g', name: 'g', ok: false, severity: 'warning' }]),
      NOW,
    );
    w.device.rows[0]!.points = [{ ...gain, watch: undefined }];
    const jobs = await applyWatchedPoints(asDb(w), row(w), { id: GW }, rep(true, []), NOW);
    expect(jobs).toHaveLength(1);
    expect(w.incident.rows[0]!.status).toBe('resolved');
  });

  it('ignore a report for a point that is not watched', async () => {
    const w = world({ points: [router] });
    const jobs = await applyWatchedPoints(
      asDb(w),
      row(w),
      { id: GW },
      rep(true, [{ pointId: 'r2', name: 'r2', ok: false, severity: 'warning' }]),
      NOW,
    );
    expect(jobs).toEqual([]);
    expect(w.incident.rows).toHaveLength(0);
  });
});
