import { describe, expect, it } from 'vitest';
import { CO2_KG_PER_KWH, drawingIntervals, estateEnergy, TYPICAL_WATTS } from './energy';
import type { UsageDb } from './usage-service';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222221';
const ROOM = '33333333-3333-4333-8333-333333333331';
const ROOM2 = '33333333-3333-4333-8333-333333333332';
const D1 = '44444444-4444-4444-8444-444444444441';
const D2 = '44444444-4444-4444-8444-444444444442';
const D3 = '44444444-4444-4444-8444-444444444443';
const H = 3_600_000;

// 2026-10-07 is a Wednesday. Times below are UTC; the site is in UTC so working hours read plainly.
const NOW = new Date('2026-10-07T12:00:00Z');
const at = (iso: string) => new Date(iso);

describe('drawingIntervals', () => {
  it('turns power changes into stretches of drawing power', () => {
    const out = drawingIntervals(
      [
        { at: 10 * H, value: 'on' },
        { at: 12 * H, value: 'off' },
        { at: 15 * H, value: 'warming' },
      ],
      null,
      0,
      20 * H,
    );
    expect(out).toEqual([
      { start: 10 * H, end: 12 * H },
      { start: 15 * H, end: 20 * H },
    ]);
  });
  it('starts a window with the reading in force before it', () => {
    expect(drawingIntervals([{ at: 5 * H, value: 'off' }], 'on', 0, 10 * H)).toEqual([
      { start: 0, end: 5 * H },
    ]);
  });
  it('counts cooling as still drawing, and nothing for off', () => {
    expect(drawingIntervals([{ at: 2 * H, value: 'cooling' }], 'off', 0, 4 * H)).toEqual([
      { start: 2 * H, end: 4 * H },
    ]);
    expect(drawingIntervals([], 'off', 0, 4 * H)).toEqual([]);
  });
});

function world(history: { deviceId: string; value: string; at: Date }[]) {
  const db = {
    usageSettings: table([]),
    room: table([
      { id: ROOM, orgId: ORG, siteId: SITE, name: 'Boardroom' },
      { id: ROOM2, orgId: ORG, siteId: SITE, name: 'Studio' },
    ]),
    site: table([{ id: SITE, orgId: ORG, timezone: 'UTC' }]),
    device: table([
      { id: D1, orgId: ORG, roomId: ROOM, kind: 'active', category: 'display' },
      { id: D2, orgId: ORG, roomId: ROOM2, kind: 'active', category: 'projector' },
      { id: D3, orgId: ORG, roomId: ROOM, kind: 'active', category: 'dsp' },
    ]),
    deviceHistory: table(history.map((h) => ({ orgId: ORG, field: 'power', ...h }))),
    usageDefinition: table([]),
    roomUsageDay: table([]),
  } as unknown as UsageDb;
  return db;
}

describe('estateEnergy', () => {
  it('counts only the hours outside working time, at the category wattage', async () => {
    // Default working hours are weekdays 08:00-18:00. The display is on from 17:00 to 21:00 on the
    // Tuesday: 1 working hour and 3 after hours.
    const db = world([
      { deviceId: D1, value: 'on', at: at('2026-10-06T17:00:00Z') },
      { deviceId: D1, value: 'off', at: at('2026-10-06T21:00:00Z') },
    ]);
    const e = await estateEnergy(db, { orgId: ORG, days: 7, now: NOW });
    expect(e.rows).toHaveLength(1);
    expect(e.rows[0]).toMatchObject({
      roomId: ROOM,
      devices: 1,
      onMinutes: 240,
      afterHoursMinutes: 180,
    });
    expect(e.rows[0]!.afterHoursKwh).toBeCloseTo((3 * TYPICAL_WATTS.display!) / 1000, 1);
    expect(e.rows[0]!.afterHoursCo2Kg).toBeCloseTo(e.rows[0]!.afterHoursKwh * CO2_KG_PER_KWH, 1);
    expect(e.totals.afterHoursKwhPerYear).toBe(
      Math.round((3 * TYPICAL_WATTS.display! * 365) / 1000 / 7),
    );
  });

  it('ranks rooms by after-hours energy and uses the projector wattage', async () => {
    const db = world([
      { deviceId: D1, value: 'on', at: at('2026-10-06T19:00:00Z') },
      { deviceId: D1, value: 'off', at: at('2026-10-06T20:00:00Z') },
      { deviceId: D2, value: 'on', at: at('2026-10-06T19:00:00Z') },
      { deviceId: D2, value: 'off', at: at('2026-10-06T21:00:00Z') },
    ]);
    const e = await estateEnergy(db, { orgId: ORG, days: 7, now: NOW });
    expect(e.rows.map((r) => r.roomId)).toEqual([ROOM2, ROOM]);
    expect(e.rows[0]!.afterHoursKwh).toBeCloseTo((2 * TYPICAL_WATTS.projector!) / 1000, 1);
  });

  it('counts a display left on all night from the reading before the window', async () => {
    const db = world([{ deviceId: D1, value: 'on', at: at('2026-09-20T09:00:00Z') }]);
    const e = await estateEnergy(db, { orgId: ORG, days: 7, now: NOW });
    expect(e.rows[0]!.afterHoursMinutes).toBeGreaterThan(60 * 24 * 2);
  });

  it('ignores categories it has no wattage for and devices with no readings', async () => {
    const db = world([{ deviceId: D3, value: 'on', at: at('2026-10-06T19:00:00Z') }]);
    const e = await estateEnergy(db, { orgId: ORG, days: 7, now: NOW });
    expect(e.rows).toEqual([]);
    expect(e.totals).toMatchObject({ devices: 0, afterHoursKwh: 0 });
  });
});
