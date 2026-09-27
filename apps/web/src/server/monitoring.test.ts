import { describe, expect, it } from 'vitest';
import type { RoomReport } from '@kestrel/model';
import {
  DEVICE_GRACE_MS,
  FLAP_WINDOW_MS,
  recordReports,
  roomHealth,
  sweep,
  type MonitoringDb,
} from './monitoring';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const GW = '99999999-9999-4999-8999-999999999991';
const ROOM = '33333333-3333-4333-8333-333333333331';
const OTHER_ROOM = '33333333-3333-4333-8333-333333333332';
const T0 = new Date('2026-09-24T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function world() {
  const room = table([
    { id: ROOM, orgId: ORG, gatewayId: GW, name: 'Boardroom' },
    {
      id: OTHER_ROOM,
      orgId: ORG,
      gatewayId: '99999999-9999-4999-8999-999999999992',
      name: 'Studio',
    },
  ]);
  const deviceStatus = table([]);
  const incident = table([]);
  const gateway = table([]);
  const remoteCommand = table([]);
  const orgBilling = table([
    { id: 'b1', orgId: ORG, plan: 'pro', status: 'active', trialEndsAt: T0 },
  ]);
  const org = table([{ id: ORG, createdAt: T0 }]);
  const db = {
    room,
    deviceStatus,
    incident,
    gateway,
    remoteCommand,
    orgBilling,
    org,
  } as unknown as MonitoringDb;
  return { db, room, deviceStatus, incident, gateway, remoteCommand, orgBilling };
}

const report = (
  over: Partial<RoomReport> & { devices?: RoomReport['devices'] } = {},
): RoomReport => ({
  roomId: ROOM,
  releaseId: '44444444-4444-4444-8444-444444444441',
  status: 'off',
  devices: [
    { deviceId: 'dsp', name: 'DSP', online: true },
    { deviceId: 'display', name: 'Display', online: true },
  ],
  ...over,
});
const offline = (name = 'DSP') => [
  { deviceId: 'dsp', name, online: name !== 'DSP' },
  { deviceId: 'display', name: 'Display', online: true },
];

describe('device status and incidents', () => {
  it('records device status without raising anything while everything answers', async () => {
    const w = world();
    const jobs = await recordReports(w.db, { id: GW, orgId: ORG }, [report()], T0);
    expect(jobs).toEqual([]);
    expect(w.deviceStatus.rows).toHaveLength(2);
    expect(w.incident.rows).toHaveLength(0);
  });

  it('watches a staging room but never raises an incident or an alert for it', async () => {
    const w = world();
    w.room.rows.find((r) => r.id === ROOM)!.kind = 'staging';
    const gw = { id: GW, orgId: ORG };
    await recordReports(w.db, gw, [report({ devices: offline() })], T0);
    const jobs = await recordReports(w.db, gw, [report({ status: 'fault', error: 'boom', devices: offline() })], at(DEVICE_GRACE_MS));
    expect(jobs).toEqual([]);
    expect(w.incident.rows).toHaveLength(0);
    // Its devices are still tracked, so the room page can show them.
    expect(w.deviceStatus.rows.map((d) => [d.deviceId, d.online])).toContainEqual(['dsp', false]);
  });

  it('waits out the grace period before calling an offline device an incident', async () => {
    const w = world();
    const gw = { id: GW, orgId: ORG };
    await recordReports(w.db, gw, [report()], T0);
    expect(await recordReports(w.db, gw, [report({ devices: offline() })], at(30_000))).toEqual([]);
    expect(w.incident.rows).toHaveLength(0);
    // Still offline one grace period after it went down.
    const jobs = await recordReports(
      w.db,
      gw,
      [report({ devices: offline() })],
      at(30_000 + DEVICE_GRACE_MS),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.event).toBe('opened');
    expect(w.incident.rows[0]).toMatchObject({
      kind: 'device_offline',
      status: 'open',
      severity: 'warning',
      title: 'DSP is offline',
      roomId: ROOM,
      orgId: ORG,
    });
  });

  it('does not open a second incident for the same device, and resolves it when the device returns', async () => {
    const w = world();
    const gw = { id: GW, orgId: ORG };
    await recordReports(w.db, gw, [report({ devices: offline() })], T0);
    await recordReports(w.db, gw, [report({ devices: offline() })], at(DEVICE_GRACE_MS));
    expect(
      await recordReports(w.db, gw, [report({ devices: offline() })], at(DEVICE_GRACE_MS + 30_000)),
    ).toEqual([]);
    expect(w.incident.rows).toHaveLength(1);

    const jobs = await recordReports(w.db, gw, [report()], at(DEVICE_GRACE_MS + 60_000));
    expect(jobs).toEqual([{ incidentId: w.incident.rows[0]!.id, event: 'resolved' }]);
    expect(w.incident.rows[0]).toMatchObject({ status: 'resolved' });
  });

  it('reopens a flapping device quietly instead of alerting again', async () => {
    const w = world();
    const gw = { id: GW, orgId: ORG };
    await recordReports(w.db, gw, [report({ devices: offline() })], T0);
    await recordReports(w.db, gw, [report({ devices: offline() })], at(DEVICE_GRACE_MS));
    await recordReports(w.db, gw, [report()], at(60_000));
    // Down again, and past the grace period, well inside the flap window.
    await recordReports(w.db, gw, [report({ devices: offline() })], at(70_000));
    const jobs = await recordReports(
      w.db,
      gw,
      [report({ devices: offline() })],
      at(70_000 + DEVICE_GRACE_MS),
    );
    expect(jobs).toEqual([]);
    expect(w.incident.rows).toHaveLength(1);
    expect(w.incident.rows[0]).toMatchObject({ status: 'open', occurrences: 2 });
  });

  it('opens a fresh incident once the flap window has passed', async () => {
    const w = world();
    const gw = { id: GW, orgId: ORG };
    await recordReports(w.db, gw, [report({ devices: offline() })], T0);
    await recordReports(w.db, gw, [report({ devices: offline() })], at(DEVICE_GRACE_MS));
    await recordReports(w.db, gw, [report()], at(60_000));
    const later = 60_000 + FLAP_WINDOW_MS + 1000;
    await recordReports(w.db, gw, [report({ devices: offline() })], at(later));
    const jobs = await recordReports(
      w.db,
      gw,
      [report({ devices: offline() })],
      at(later + DEVICE_GRACE_MS),
    );
    expect(jobs).toHaveLength(1);
    expect(w.incident.rows).toHaveLength(2);
  });

  it('forgets devices a new release dropped, and closes their incidents', async () => {
    const w = world();
    const gw = { id: GW, orgId: ORG };
    await recordReports(w.db, gw, [report({ devices: offline() })], T0);
    await recordReports(w.db, gw, [report({ devices: offline() })], at(DEVICE_GRACE_MS));
    expect(w.incident.rows[0]!.status).toBe('open');
    await recordReports(
      w.db,
      gw,
      [report({ devices: [{ deviceId: 'display', name: 'Display', online: true }] })],
      at(DEVICE_GRACE_MS + 30_000),
    );
    expect(w.deviceStatus.rows.map((d) => d.deviceId)).toEqual(['display']);
    expect(w.incident.rows[0]!.status).toBe('resolved');
  });

  it('raises and clears a room fault and a rejected release', async () => {
    const w = world();
    const gw = { id: GW, orgId: ORG };
    const jobs = await recordReports(
      w.db,
      gw,
      [report({ status: 'fault', error: 'Release 4 rejected: bad hash' })],
      T0,
    );
    expect(jobs).toHaveLength(2);
    expect(w.incident.rows.map((i) => `${i.kind}:${i.severity}`).sort()).toEqual([
      'deploy_failed:warning',
      'room_fault:critical',
    ]);
    const cleared = await recordReports(w.db, gw, [report({ status: 'on' })], at(60_000));
    expect(cleared).toHaveLength(2);
    expect(w.incident.rows.every((i) => i.status === 'resolved')).toBe(true);
  });

  it('ignores reports about rooms that belong to another gateway', async () => {
    const w = world();
    await recordReports(
      w.db,
      { id: GW, orgId: ORG },
      [report({ roomId: OTHER_ROOM, status: 'fault' })],
      T0,
    );
    expect(w.deviceStatus.rows).toHaveLength(0);
    expect(w.incident.rows).toHaveLength(0);
  });
});

describe('device firmware', () => {
  const gw = { id: GW, orgId: ORG };
  const withFirmware = (firmware?: string, driver = 'pjlink') => [
    { deviceId: 'dsp', name: 'DSP', online: true, driver: 'biamp-tesira' },
    {
      deviceId: 'display',
      name: 'Display',
      online: true,
      driver,
      ...(firmware ? { firmware } : {}),
    },
  ];
  const display = (w: ReturnType<typeof world>) =>
    w.deviceStatus.rows.find((r) => r.deviceId === 'display')!;

  it('records the driver and firmware a device reports, and when it first saw that version', async () => {
    const w = world();
    await recordReports(w.db, gw, [report({ devices: withFirmware('1.07') })], T0);
    expect(display(w)).toMatchObject({ driver: 'pjlink', firmware: '1.07', firmwareSince: T0 });
    const dsp = w.deviceStatus.rows.find((r) => r.deviceId === 'dsp')!;
    expect(dsp.driver).toBe('biamp-tesira');
    expect(dsp.firmware).toBeUndefined();
  });

  it('keeps the first-seen time while the version is unchanged, and moves it when the version changes', async () => {
    const w = world();
    await recordReports(w.db, gw, [report({ devices: withFirmware('1.07') })], T0);
    await recordReports(w.db, gw, [report({ devices: withFirmware('1.07') })], at(60_000));
    expect(display(w).firmwareSince).toEqual(T0);
    await recordReports(w.db, gw, [report({ devices: withFirmware('1.08') })], at(120_000));
    expect(display(w)).toMatchObject({ firmware: '1.08', firmwareSince: at(120_000) });
  });

  it('remembers the last version when a heartbeat leaves it out', async () => {
    const w = world();
    await recordReports(w.db, gw, [report({ devices: withFirmware('1.07') })], T0);
    await recordReports(w.db, gw, [report({ devices: withFirmware(undefined) })], at(60_000));
    expect(display(w)).toMatchObject({ firmware: '1.07', firmwareSince: T0 });
  });

  it('does not treat a firmware report as a change of reachability', async () => {
    const w = world();
    await recordReports(w.db, gw, [report({ devices: withFirmware('1.07') })], T0);
    const since = display(w).since;
    await recordReports(w.db, gw, [report({ devices: withFirmware('1.08') })], at(60_000));
    expect(display(w).since).toEqual(since);
    expect(display(w).online).toBe(true);
    expect(w.incident.rows).toHaveLength(0);
  });
});

describe('sweep', () => {
  const gwRow = (over = {}) => ({
    id: GW,
    orgId: ORG,
    name: 'HQ gateway',
    enrolledAt: T0,
    lastSeenAt: T0,
    ...over,
  });

  it('opens a critical incident when a gateway goes quiet and resolves it when it returns', async () => {
    const w = world();
    w.gateway.rows.push(gwRow());
    expect(await sweep(w.db, at(60_000))).toEqual([]);
    const jobs = await sweep(w.db, at(5 * 60_000));
    expect(jobs).toHaveLength(1);
    expect(w.incident.rows[0]).toMatchObject({
      kind: 'gateway_offline',
      severity: 'critical',
      gatewayId: GW,
    });
    // Not opened twice.
    expect(await sweep(w.db, at(6 * 60_000))).toEqual([]);
    w.gateway.rows[0]!.lastSeenAt = at(6 * 60_000);
    const back = await sweep(w.db, at(6 * 60_000 + 10_000));
    expect(back[0]!.event).toBe('resolved');
  });

  it('leaves organisations without monitoring alone', async () => {
    const w = world();
    w.gateway.rows.push(gwRow());
    w.orgBilling.rows[0]!.plan = 'basic';
    expect(await sweep(w.db, at(60 * 60_000))).toEqual([]);
    expect(w.incident.rows).toHaveLength(0);
  });

  it('ignores gateways that never enrolled', async () => {
    const w = world();
    w.gateway.rows.push(gwRow({ enrolledAt: null, lastSeenAt: null }));
    expect(await sweep(w.db, at(60 * 60_000))).toEqual([]);
    expect(w.incident.rows).toHaveLength(0);
  });

  it('expires commands nobody picked up', async () => {
    const w = world();
    w.remoteCommand.rows.push(
      { id: 'a', status: 'pending', createdAt: T0, sentAt: null },
      { id: 'b', status: 'sent', createdAt: T0, sentAt: T0 },
      { id: 'c', status: 'pending', createdAt: at(9 * 60_000), sentAt: null },
    );
    await sweep(w.db, at(11 * 60_000 + 1));
    expect(w.remoteCommand.rows.map((r) => r.status)).toEqual(['expired', 'expired', 'pending']);
  });
});

describe('room health', () => {
  const base = {
    gatewayStatus: 'online' as const,
    deployed: true,
    status: 'off',
    devices: [{ online: true }],
    openIncidents: [],
  };

  it('is unknown, not healthy, whenever the room cannot be seen', () => {
    expect(roomHealth({ ...base, gatewayStatus: null }).level).toBe('unknown');
    expect(roomHealth({ ...base, gatewayStatus: 'offline' }).level).toBe('unknown');
    expect(roomHealth({ ...base, gatewayStatus: 'pending' }).level).toBe('unknown');
    expect(roomHealth({ ...base, deployed: false }).level).toBe('unknown');
    expect(roomHealth({ ...base, gatewayStatus: 'offline' }).score).toBeNull();
  });

  it('is healthy with everything answering', () => {
    expect(roomHealth(base)).toMatchObject({ level: 'healthy', score: 100, reasons: [] });
  });

  it('degrades with offline devices and open incidents', () => {
    const one = roomHealth({
      ...base,
      devices: [{ online: false }, { online: true }, { online: true }, { online: true }],
    });
    expect(one.level).toBe('degraded');
    expect(one.reasons).toEqual(['1 of 4 devices offline']);
    const many = roomHealth({ ...base, devices: [{ online: false }, { online: false }] });
    expect(many.level).toBe('down');
    expect(roomHealth({ ...base, openIncidents: [{ severity: 'warning' }] }).score).toBe(90 - 0);
  });

  it('is down whenever the room reports a fault', () => {
    expect(roomHealth({ ...base, status: 'fault' }).level).toBe('down');
  });

  it('never goes below zero', () => {
    const h = roomHealth({
      ...base,
      status: 'fault',
      devices: [{ online: false }],
      openIncidents: Array.from({ length: 10 }, () => ({ severity: 'critical' })),
    });
    expect(h.score).toBe(0);
  });
});
