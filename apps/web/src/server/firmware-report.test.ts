import { describe, expect, it } from 'vitest';
import { firmwareReport, type FirmwareDb } from './firmware-report';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '11111111-1111-4111-8111-111111111112';
const SITE_A = '55555555-5555-4555-8555-555555555551';
const SITE_B = '55555555-5555-4555-8555-555555555552';
const R1 = '33333333-3333-4333-8333-333333333331';
const R2 = '33333333-3333-4333-8333-333333333332';
const R3 = '33333333-3333-4333-8333-333333333333';
const T = new Date('2026-09-28T09:00:00Z');

function world() {
  const room = table([
    { id: R1, orgId: ORG, siteId: SITE_A, name: 'Boardroom' },
    { id: R2, orgId: ORG, siteId: SITE_A, name: 'Studio' },
    { id: R3, orgId: ORG, siteId: SITE_B, name: 'Lab' },
  ]);
  const site = table([
    { id: SITE_A, orgId: ORG, name: 'HQ' },
    { id: SITE_B, orgId: ORG, name: 'Annex' },
  ]);
  const dev = (roomId: string, deviceId: string, over: Record<string, unknown> = {}) => ({
    id: `${roomId}:${deviceId}`,
    orgId: ORG,
    roomId,
    deviceId,
    name: deviceId,
    online: true,
    driver: null,
    firmware: null,
    firmwareSince: null,
    ...over,
  });
  const deviceStatus = table([
    dev(R1, 'projector', { driver: 'pjlink', firmware: '1.07', firmwareSince: T }),
    dev(R2, 'projector', { driver: 'pjlink', firmware: '1.07', firmwareSince: T }),
    dev(R3, 'projector', { driver: 'pjlink', firmware: '1.05', firmwareSince: T }),
    dev(R1, 'dsp', { driver: 'biamp-tesira', firmware: '4.2.1.3', firmwareSince: T }),
    dev(R2, 'dsp', { driver: 'biamp-tesira' }),
    dev(R1, 'camera'),
    { ...dev(R1, 'foreign', { driver: 'pjlink', firmware: '9.9' }), id: 'x', orgId: OTHER_ORG },
  ]);
  return { db: { room, site, deviceStatus } as unknown as FirmwareDb };
}

describe('the firmware report', () => {
  it('lists every device with what it reported, grouped by driver then place', async () => {
    const { rows } = await firmwareReport(world().db, ORG);
    expect(rows.map((r) => `${r.driver}:${r.siteName}/${r.roomName}/${r.deviceId}`)).toEqual([
      'biamp-tesira:HQ/Boardroom/dsp',
      'biamp-tesira:HQ/Studio/dsp',
      'pjlink:Annex/Lab/projector',
      'pjlink:HQ/Boardroom/projector',
      'pjlink:HQ/Studio/projector',
      'null:HQ/Boardroom/camera',
    ]);
    expect(rows.find((r) => r.deviceId === 'camera')).toMatchObject({
      firmware: null,
      driver: null,
    });
  });

  it('summarises each driver, flagging mixed versions', async () => {
    const { drivers } = await firmwareReport(world().db, ORG);
    const pj = drivers.find((d) => d.driver === 'pjlink')!;
    expect(pj).toMatchObject({ devices: 3, reporting: 3, mixed: true });
    expect(pj.versions).toEqual([
      { version: '1.07', count: 2 },
      { version: '1.05', count: 1 },
    ]);
    const dsp = drivers.find((d) => d.driver === 'biamp-tesira')!;
    expect(dsp).toMatchObject({ devices: 2, reporting: 1, mixed: false });
    expect(drivers.find((d) => d.driver === 'Unknown driver')).toMatchObject({
      devices: 1,
      reporting: 0,
      versions: [],
    });
  });

  it('never includes another organisation’s devices', async () => {
    const { rows } = await firmwareReport(world().db, ORG);
    expect(rows.some((r) => r.deviceId === 'foreign')).toBe(false);
    expect((await firmwareReport(world().db, OTHER_ORG)).rows).toEqual([]);
  });

  it('shows a site-limited provider only its own sites', async () => {
    const { rows, drivers } = await firmwareReport(world().db, ORG, [SITE_B]);
    expect(rows.map((r) => r.roomName)).toEqual(['Lab']);
    expect(drivers).toEqual([
      {
        driver: 'pjlink',
        devices: 1,
        reporting: 1,
        versions: [{ version: '1.05', count: 1 }],
        mixed: false,
      },
    ]);
  });

  it('includes the devices a gateway watches, once, alongside the older status rows', async () => {
    const { db } = world();
    const D1 = '77777777-7777-4777-8777-777777777771';
    const reg = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      orgId: ORG,
      roomId: R1,
      name: 'UC-Engine',
      status: 'in_service',
      control: { kind: 'driver', driverId: 'crestron-flex' },
      firmware: '1.22.00.405',
      firmwareSince: T,
      online: true,
      ...over,
    });
    const withDevices = {
      ...db,
      device: table([
        reg(D1),
        reg('retired', { status: 'retired' }),
        reg('spare', { roomId: null }),
        reg('foreign', { orgId: OTHER_ORG }),
        // Also reported by the older status table: shown once, from the register.
        reg('projector', { name: 'Projector', control: { kind: 'driver', driverId: 'pjlink' } }),
      ]),
    } as unknown as FirmwareDb;
    const { rows, drivers } = await firmwareReport(withDevices, ORG);
    const flex = rows.filter((r) => r.driver === 'crestron-flex');
    expect(flex).toHaveLength(1);
    expect(flex[0]).toMatchObject({ deviceId: D1, firmware: '1.22.00.405', online: true });
    expect(rows.some((r) => ['retired', 'spare', 'foreign'].includes(r.deviceId))).toBe(false);
    expect(drivers.find((d) => d.driver === 'crestron-flex')).toMatchObject({
      devices: 1,
      reporting: 1,
    });
  });
});
