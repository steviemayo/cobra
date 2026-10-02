import { describe, expect, it, vi } from 'vitest';
import type { RoomReport } from '@kestrel/model';
import {
  DEVICE_GRACE_MS,
  openIncident,
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
  const orgLicenseOverride = table([]);
  const db = {
    room,
    deviceStatus,
    incident,
    gateway,
    remoteCommand,
    orgBilling,
    org,
    orgLicenseOverride,
  } as unknown as MonitoringDb;
  return {
    db,
    room,
    deviceStatus,
    incident,
    gateway,
    remoteCommand,
    orgBilling,
    orgLicenseOverride,
  };
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

  it('stores whatever the driver reported back, and keeps it when a later heartbeat leaves it out', async () => {
    const w = world();
    await recordReports(
      w.db,
      { id: GW, orgId: ORG },
      [
        report({
          devices: [
            { deviceId: 'dsp', name: 'DSP', online: true, feedback: { power: 'on', muted: false } },
          ],
        }),
      ],
      T0,
    );
    expect(w.deviceStatus.rows[0]).toMatchObject({ feedback: { power: 'on', muted: false } });
    // Same reading again: no pointless write.
    const update = vi.spyOn(w.deviceStatus, 'update');
    await recordReports(
      w.db,
      { id: GW, orgId: ORG },
      [
        report({
          devices: [
            { deviceId: 'dsp', name: 'DSP', online: true, feedback: { power: 'on', muted: false } },
          ],
        }),
      ],
      at(1000),
    );
    expect(update).not.toHaveBeenCalled();
    // A heartbeat that says nothing about it (a momentary hiccup) keeps the last known reading.
    await recordReports(
      w.db,
      { id: GW, orgId: ORG },
      [report({ devices: [{ deviceId: 'dsp', name: 'DSP', online: true }] })],
      at(2000),
    );
    expect(w.deviceStatus.rows[0]).toMatchObject({ feedback: { power: 'on', muted: false } });
    // A changed reading is written.
    await recordReports(
      w.db,
      { id: GW, orgId: ORG },
      [
        report({
          devices: [{ deviceId: 'dsp', name: 'DSP', online: true, feedback: { power: 'off' } }],
        }),
      ],
      at(3000),
    );
    expect(w.deviceStatus.rows[0]).toMatchObject({ feedback: { power: 'off' } });
  });

  describe('watched points', () => {
    const gw = { id: GW, orgId: ORG };
    const watched = (ok: boolean, over: object = {}) => ({
      pointId: 'mut',
      name: 'Mic mute',
      ok,
      ...(ok ? {} : { message: 'Mic mute is on, expected off' }),
      severity: 'critical' as const,
      ...over,
    });
    const withWatch = (w: ReturnType<typeof watched>[] | undefined, online = true) =>
      report({
        devices: [
          { deviceId: 'dsp', name: 'DSP', online, ...(w ? { watched: w } : {}) },
          { deviceId: 'display', name: 'Display', online: true },
        ],
      });

    it('raises an incident with the severity of the watch, and resolves it when the value is fine again', async () => {
      const w = world();
      const jobs = await recordReports(w.db, gw, [withWatch([watched(false)])], T0);
      expect(jobs).toEqual([{ incidentId: expect.any(String), event: 'opened' }]);
      expect(w.incident.rows[0]).toMatchObject({
        kind: 'point_alert',
        subject: `${ROOM}:dsp:mut`,
        severity: 'critical',
        title: 'DSP: Mic mute',
        status: 'open',
      });
      expect(w.incident.rows[0]!.detail).toContain('Mic mute is on, expected off');
      // Still wrong: the same incident, no second alert.
      expect(await recordReports(w.db, gw, [withWatch([watched(false)])], at(1000))).toEqual([]);
      expect(w.incident.rows).toHaveLength(1);
      const back = await recordReports(w.db, gw, [withWatch([watched(true)])], at(2000));
      expect(back[0]!.event).toBe('resolved');
      expect(w.incident.rows[0]!.status).toBe('resolved');
    });

    it('closes the incident when the watch is taken off the point', async () => {
      const w = world();
      await recordReports(w.db, gw, [withWatch([watched(false)])], T0);
      const jobs = await recordReports(w.db, gw, [withWatch(undefined)], at(1000));
      expect(jobs[0]!.event).toBe('resolved');
    });

    it('leaves the incident open while the device is offline, because nothing can be read', async () => {
      const w = world();
      await recordReports(w.db, gw, [withWatch([watched(false)])], T0);
      expect(await recordReports(w.db, gw, [withWatch(undefined, false)], at(1000))).toEqual([]);
      expect(w.incident.rows[0]!.status).toBe('open');
    });

    it('never alerts for a staging room', async () => {
      const w = world();
      w.room.rows.find((r) => r.id === ROOM)!.kind = 'staging';
      expect(await recordReports(w.db, gw, [withWatch([watched(false)])], T0)).toEqual([]);
      expect(w.incident.rows).toHaveLength(0);
    });
  });

  it('watches a staging room but never raises an incident or an alert for it', async () => {
    const w = world();
    w.room.rows.find((r) => r.id === ROOM)!.kind = 'staging';
    const gw = { id: GW, orgId: ORG };
    await recordReports(w.db, gw, [report({ devices: offline() })], T0);
    const jobs = await recordReports(
      w.db,
      gw,
      [report({ status: 'fault', error: 'boom', devices: offline() })],
      at(DEVICE_GRACE_MS),
    );
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

  it('alerts again when a problem returns after a real gap inside the flap window', async () => {
    const w = world();
    const gw = { id: GW, orgId: ORG };
    await recordReports(w.db, gw, [report({ devices: offline() })], T0);
    await recordReports(w.db, gw, [report({ devices: offline() })], at(DEVICE_GRACE_MS));
    await recordReports(w.db, gw, [report()], at(60_000));
    // Gone again 2 minutes after it was resolved: not a blip, so it is told.
    const back = 60_000 + 2 * 60_000;
    await recordReports(w.db, gw, [report({ devices: offline() })], at(back));
    const jobs = await recordReports(
      w.db,
      gw,
      [report({ devices: offline() })],
      at(back + DEVICE_GRACE_MS),
    );
    expect(jobs).toEqual([{ incidentId: w.incident.rows[0]!.id, event: 'opened' }]);
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

describe('device details', () => {
  const gw = { id: GW, orgId: ORG };
  const details = (serial: string) => [
    { title: 'Device', rows: [{ label: 'Serial number', value: serial }] },
  ];
  const devices = (d?: ReturnType<typeof details>) => [
    { deviceId: 'dsp', name: 'DSP', online: true, ...(d ? { details: d } : {}) },
  ];
  const dsp = (w: ReturnType<typeof world>) =>
    w.deviceStatus.rows.find((r) => r.deviceId === 'dsp')!;

  it('stores what a device says about itself, and replaces it when it changes', async () => {
    const w = world();
    await recordReports(w.db, gw, [report({ devices: devices(details('A1')) })], T0);
    expect(dsp(w).details).toEqual(details('A1'));
    await recordReports(w.db, gw, [report({ devices: devices(details('B2')) })], at(60_000));
    expect(dsp(w).details).toEqual(details('B2'));
  });

  it('keeps the last details when a heartbeat leaves them out (the gateway only sends changes)', async () => {
    const w = world();
    await recordReports(w.db, gw, [report({ devices: devices(details('A1')) })], T0);
    await recordReports(w.db, gw, [report({ devices: devices() })], at(60_000));
    expect(dsp(w).details).toEqual(details('A1'));
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

  it('leaves organisations alone when staff have switched monitoring off', async () => {
    const w = world();
    w.gateway.rows.push(gwRow());
    w.orgLicenseOverride.rows.push({
      id: 'o1',
      orgId: ORG,
      monitoring: false,
      revokedAt: null,
      expiresAt: null,
      createdAt: T0,
    });
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

describe('a problem that opens around a meeting', () => {
  const meeting = (id: string, from: number, to: number, priv = false) => ({
    id,
    title: id,
    start: at(from).toISOString(),
    end: at(to).toISOString(),
    private: priv,
  });
  const open = (
    w: ReturnType<typeof world>,
    kind: 'device_offline' | 'pm_overdue' = 'device_offline',
  ) =>
    openIncident(
      w.db,
      { orgId: ORG, roomId: ROOM, kind, subject: `${ROOM}:d1`, severity: 'warning', title: 'x' },
      T0,
    );
  const withSchedule = (meetings: unknown, fetchedAt = T0) => {
    const w = world();
    const roomSchedule = table([{ roomId: ROOM, orgId: ORG, fetchedAt, meetings }]);
    (w.db as unknown as { roomSchedule: unknown }).roomSchedule = roomSchedule;
    return w;
  };

  it('is raised a step and marked when a meeting is on now', async () => {
    const w = withSchedule([meeting('a', -600_000, 600_000)]);
    await open(w);
    expect(w.incident.rows[0]).toMatchObject({
      severity: 'critical',
      meetingsAffected: 1,
      severityRaised: true,
    });
  });

  it('is raised when a meeting starts within half an hour, but not when it is later', async () => {
    const soon = withSchedule([meeting('a', 20 * 60_000, 80 * 60_000)]);
    await open(soon);
    expect(soon.incident.rows[0]).toMatchObject({ severity: 'critical', meetingsAffected: 1 });
    const later = withSchedule([meeting('a', 3 * 3_600_000, 4 * 3_600_000)]);
    await open(later);
    expect(later.incident.rows[0]).toMatchObject({
      severity: 'warning',
      meetingsAffected: 0,
      severityRaised: false,
    });
  });

  it('counts a private meeting too', async () => {
    const w = withSchedule([meeting('a', -600_000, 600_000, true)]);
    await open(w);
    expect(w.incident.rows[0]).toMatchObject({ severity: 'critical', meetingsAffected: 1 });
  });

  it('never raises on a stale calendar, or a room with none', async () => {
    const stale = withSchedule([meeting('a', -600_000, 600_000)], at(-3_600_000));
    await open(stale);
    expect(stale.incident.rows[0]).toMatchObject({ severity: 'warning', meetingsAffected: 0 });
    const none = world();
    await open(none);
    expect(none.incident.rows[0]).toMatchObject({ severity: 'warning', meetingsAffected: 0 });
  });

  it('leaves housekeeping problems alone', async () => {
    const w = withSchedule([meeting('a', -600_000, 600_000)]);
    await open(w, 'pm_overdue');
    expect(w.incident.rows[0]).toMatchObject({ severity: 'warning', meetingsAffected: 0 });
  });

  it('does not go past critical', async () => {
    const w = withSchedule([meeting('a', -600_000, 600_000)]);
    await openIncident(
      w.db,
      {
        orgId: ORG,
        roomId: ROOM,
        kind: 'room_fault',
        subject: 's',
        severity: 'critical',
        title: 'x',
      },
      T0,
    );
    expect(w.incident.rows[0]).toMatchObject({ severity: 'critical', severityRaised: false });
  });

  it('still opens the incident if the calendar cannot be read', async () => {
    const w = withSchedule([meeting('a', -600_000, 600_000)]);
    (w.db as unknown as { roomSchedule: unknown }).roomSchedule = {
      findFirst: () => Promise.reject(new Error('down')),
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await open(w);
    expect(w.incident.rows[0]).toMatchObject({ severity: 'warning', meetingsAffected: 0 });
    err.mockRestore();
  });
});
