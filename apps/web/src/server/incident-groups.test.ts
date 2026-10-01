import { describe, expect, it, vi } from 'vitest';
import {
  GROUP_MIN,
  GROUP_WINDOW_MS,
  groupOutages,
  subnetOf,
  type GroupDb,
} from './incident-groups';
import { openIncident, resolveIncident, type AlertJob, type MonitoringDb } from './monitoring';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const GW = '99999999-9999-4999-8999-999999999991';
const OTHER_GW = '99999999-9999-4999-8999-999999999992';
const T0 = new Date('2026-10-01T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const gw = { id: GW, orgId: ORG };

const deviceId = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;

function world() {
  const incident = table([]);
  const device = table([]);
  const db = { incident, device } as unknown as GroupDb;
  const monitoring = db as unknown as MonitoringDb;

  const addDevice = (n: number, ip: string | null) =>
    device.rows.push({ id: deviceId(n), orgId: ORG, name: `Display ${n}`, ip });

  /** A device goes quiet: its own incident opens, as the heartbeat does. */
  const goOffline = async (n: number, when: Date, gateway = GW) =>
    (await openIncident(
      monitoring,
      {
        orgId: ORG,
        gatewayId: gateway,
        kind: 'device_offline',
        subject: `device:${deviceId(n)}`,
        severity: 'warning',
        title: `Display ${n} is offline`,
      },
      when,
    )) as AlertJob;

  const comeBack = async (n: number, when: Date) =>
    (await resolveIncident(
      monitoring,
      { orgId: ORG, kind: 'device_offline', subject: `device:${deviceId(n)}` },
      when,
    )) as AlertJob;

  const groups = () => incident.rows.filter((r) => r.kind === 'group_outage');
  const children = () => incident.rows.filter((r) => r.kind === 'device_offline');
  return { db, incident, device, addDevice, goOffline, comeBack, groups, children };
}

describe('subnetOf', () => {
  it('reads the /24 of a plain IPv4 address', () => {
    expect(subnetOf('10.1.2.33')).toBe('10.1.2.0/24');
    expect(subnetOf(' 192.168.0.7 ')).toBe('192.168.0.0/24');
  });
  it('has none for anything else', () => {
    for (const x of [null, undefined, '', 'host.local', '10.1.2', '10.1.2.999', 'fe80::1'])
      expect(subnetOf(x as string | null)).toBeNull();
  });
});

describe('devices that go quiet together', () => {
  it('are left alone below the threshold', async () => {
    const w = world();
    for (let n = 1; n < GROUP_MIN; n++) w.addDevice(n, `10.0.1.${n}`);
    const jobs = [];
    for (let n = 1; n < GROUP_MIN; n++) jobs.push(await w.goOffline(n, T0));
    expect(await groupOutages(w.db, gw, jobs, T0)).toEqual(jobs);
    expect(w.groups()).toHaveLength(0);
  });

  it('become one group at the threshold, with one alert for the group and none for its devices', async () => {
    const w = world();
    for (let n = 1; n <= GROUP_MIN; n++) w.addDevice(n, `10.0.1.${n}`);
    const jobs = [];
    for (let n = 1; n <= GROUP_MIN; n++) jobs.push(await w.goOffline(n, T0));
    const out = await groupOutages(w.db, gw, jobs, T0);
    const [group] = w.groups();
    expect(w.groups()).toHaveLength(1);
    expect(out).toEqual([{ incidentId: group!.id, event: 'opened' }]);
    expect(group).toMatchObject({
      severity: 'critical',
      status: 'open',
      gatewayId: GW,
      roomId: null,
      alerted: true,
      subject: `group:${GW}:10.0.1.0/24`,
    });
    expect(String(group!.title)).toContain(`${GROUP_MIN} devices on 10.0.1.0/24`);
    expect(String(group!.detail)).toContain('Display 1');
    expect(w.children().every((c) => c.parentId === group!.id)).toBe(true);
  });

  it('are not grouped across subnets, gateways or when an address is missing', async () => {
    const w = world();
    w.addDevice(1, '10.0.1.1');
    w.addDevice(2, '10.0.2.1');
    w.addDevice(3, null);
    w.addDevice(4, '10.0.1.2');
    const jobs = [
      await w.goOffline(1, T0),
      await w.goOffline(2, T0),
      await w.goOffline(3, T0),
      await w.goOffline(4, T0, OTHER_GW),
    ];
    expect(await groupOutages(w.db, gw, jobs, T0)).toEqual(jobs);
    expect(w.groups()).toHaveLength(0);
  });

  it('do not form a group when most went quiet long ago', async () => {
    const w = world();
    for (let n = 1; n <= GROUP_MIN; n++) w.addDevice(n, `10.0.1.${n}`);
    const old = at(-GROUP_WINDOW_MS - 60_000);
    await w.goOffline(1, old);
    await w.goOffline(2, old);
    const fresh = await w.goOffline(3, T0);
    expect(await groupOutages(w.db, gw, [fresh], T0)).toEqual([fresh]);
    expect(w.groups()).toHaveLength(0);
  });

  it('do not regroup on a pass that has nothing new to say', async () => {
    const w = world();
    for (let n = 1; n <= GROUP_MIN; n++) w.addDevice(n, `10.0.1.${n}`);
    for (let n = 1; n <= GROUP_MIN; n++) await w.goOffline(n, T0);
    expect(await groupOutages(w.db, gw, [], T0)).toEqual([]);
    expect(w.groups()).toHaveLength(0);
  });

  it('take a later device into the group without a new alert', async () => {
    const w = world();
    for (let n = 1; n <= GROUP_MIN + 1; n++) w.addDevice(n, `10.0.1.${n}`);
    const first = [];
    for (let n = 1; n <= GROUP_MIN; n++) first.push(await w.goOffline(n, T0));
    await groupOutages(w.db, gw, first, T0);
    const later = at(30 * 60_000);
    const job = await w.goOffline(GROUP_MIN + 1, later);
    const out = await groupOutages(w.db, gw, [job], later);
    expect(out).toEqual([]);
    expect(w.groups()).toHaveLength(1);
    expect(w.groups()[0]!.title).toContain(`${GROUP_MIN + 1} devices`);
    expect(w.children().filter((c) => c.parentId === w.groups()[0]!.id)).toHaveLength(
      GROUP_MIN + 1,
    );
  });

  it('resolve once, when the last device is back', async () => {
    const w = world();
    for (let n = 1; n <= GROUP_MIN; n++) w.addDevice(n, `10.0.1.${n}`);
    const jobs = [];
    for (let n = 1; n <= GROUP_MIN; n++) jobs.push(await w.goOffline(n, T0));
    await groupOutages(w.db, gw, jobs, T0);
    const group = w.groups()[0]!;

    for (let n = 1; n < GROUP_MIN; n++) {
      const t = at(n * 60_000);
      const out = await groupOutages(w.db, gw, [await w.comeBack(n, t)], t);
      expect(out).toEqual([]);
      expect(group.status).toBe('open');
      expect(group.title).toContain(`${GROUP_MIN - n} device`);
    }
    const end = at(GROUP_MIN * 60_000);
    const out = await groupOutages(w.db, gw, [await w.comeBack(GROUP_MIN, end)], end);
    expect(out).toEqual([{ incidentId: group.id, event: 'resolved' }]);
    expect(group).toMatchObject({ status: 'resolved' });
    expect(group.resolvedAt).toEqual(end);
  });

  it('start over, ungrouped, when one drops again after its group resolved', async () => {
    const w = world();
    for (let n = 1; n <= GROUP_MIN; n++) w.addDevice(n, `10.0.1.${n}`);
    const jobs = [];
    for (let n = 1; n <= GROUP_MIN; n++) jobs.push(await w.goOffline(n, T0));
    await groupOutages(w.db, gw, jobs, T0);
    for (let n = 1; n <= GROUP_MIN; n++) {
      const t = at(n * 1000);
      await groupOutages(w.db, gw, [await w.comeBack(n, t)], t);
    }
    // Within the flap window, so the same incident reopens quietly and gives no alert of its own.
    const again = at((GROUP_MIN + 1) * 1000);
    expect(await w.goOffline(1, again)).toBeNull();
    expect(await groupOutages(w.db, gw, [], again)).toEqual([]);
    const reopened = w.children().find((c) => c.subject === `device:${deviceId(1)}`)!;
    expect(reopened).toMatchObject({ status: 'open', parentId: null });
  });

  it('leave the alerts exactly as they were if grouping fails', async () => {
    const w = world();
    for (let n = 1; n <= GROUP_MIN; n++) w.addDevice(n, `10.0.1.${n}`);
    const jobs = [];
    for (let n = 1; n <= GROUP_MIN; n++) jobs.push(await w.goOffline(n, T0));
    (w.db as unknown as { device: unknown }).device = {
      findMany: () => Promise.reject(new Error('down')),
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await groupOutages(w.db, gw, jobs, T0)).toEqual(jobs);
    err.mockRestore();
  });

  it('never group another organisation’s devices', async () => {
    const w = world();
    for (let n = 1; n <= GROUP_MIN; n++) w.addDevice(n, `10.0.1.${n}`);
    const jobs = [];
    for (let n = 1; n <= GROUP_MIN; n++) jobs.push(await w.goOffline(n, T0));
    const out = await groupOutages(
      w.db,
      { id: GW, orgId: '11111111-1111-4111-8111-111111111999' },
      jobs,
      T0,
    );
    expect(out).toEqual(jobs);
    expect(w.groups()).toHaveLength(0);
  });
});
