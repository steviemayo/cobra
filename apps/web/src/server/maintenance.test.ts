import { describe, expect, it } from 'vitest';
import {
  createWindow,
  deleteWindow,
  deviceOfSubject,
  inMaintenance,
  upcomingWindows,
  windowActive,
  type MaintenanceDb,
} from './maintenance';
import { openIncident, type MonitoringDb } from './monitoring';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const ROOM = '33333333-3333-4333-8333-333333333331';
const DEVICE = '44444444-4444-4444-8444-444444444441';
const H = 3_600_000;
const NOW = new Date('2026-09-30T10:00:00Z');
const at = (h: number) => new Date(NOW.getTime() + h * H);

const win = (over: Record<string, unknown> = {}) => ({
  id: 'w1',
  orgId: ORG,
  name: 'Works',
  scope: 'org',
  scopeId: null,
  startsAt: at(-1),
  endsAt: at(1),
  repeat: 'none',
  repeatUntil: null,
  ...over,
});

function world(windows: Record<string, unknown>[] = []) {
  const maintenanceWindow = table(windows);
  const room = table([{ id: ROOM, orgId: ORG, siteId: SITE }]);
  const site = table([{ id: SITE, orgId: ORG }]);
  const device = table([{ id: DEVICE, orgId: ORG }]);
  const incident = table([]);
  const db = { maintenanceWindow, room, site, device, incident } as unknown as MaintenanceDb &
    MonitoringDb;
  return { db, maintenanceWindow, incident };
}

describe('windowActive', () => {
  it('covers its own hours, and repeats daily and weekly', () => {
    const w = win({ startsAt: at(-1), endsAt: at(1) });
    expect(windowActive(w as never, NOW)).toBe(true);
    expect(windowActive(w as never, at(2))).toBe(false);
    const daily = win({ repeat: 'daily' });
    expect(windowActive(daily as never, at(23.5))).toBe(true); // 09:00 to 11:00 again tomorrow, now 09:30
    expect(windowActive(daily as never, at(20))).toBe(false);
    const weekly = win({ repeat: 'weekly' });
    expect(windowActive(weekly as never, at(24 * 7))).toBe(true);
    expect(windowActive(weekly as never, at(24 * 3))).toBe(false);
  });

  it('stops repeating after its end date, and ignores windows that have not started', () => {
    const w = win({ repeat: 'daily', repeatUntil: at(24) });
    expect(windowActive(w as never, at(24 * 5))).toBe(false);
    expect(windowActive(win({ startsAt: at(5), endsAt: at(6) }) as never, NOW)).toBe(false);
  });
});

describe('inMaintenance', () => {
  it('matches the organisation, the site, the room and the device, and nothing else', async () => {
    const t = { roomId: ROOM, deviceId: DEVICE };
    expect(await inMaintenance(world([win()]).db, ORG, t, NOW)).toBe(true);
    expect(
      await inMaintenance(world([win({ scope: 'site', scopeId: SITE })]).db, ORG, t, NOW),
    ).toBe(true);
    expect(
      await inMaintenance(world([win({ scope: 'room', scopeId: ROOM })]).db, ORG, t, NOW),
    ).toBe(true);
    expect(
      await inMaintenance(world([win({ scope: 'device', scopeId: DEVICE })]).db, ORG, t, NOW),
    ).toBe(true);
    expect(
      await inMaintenance(
        world([win({ scope: 'room', scopeId: '99999999-9999-4999-8999-999999999999' })]).db,
        ORG,
        t,
        NOW,
      ),
    ).toBe(false);
    expect(
      await inMaintenance(
        world([win({ orgId: '99999999-9999-4999-8999-999999999999' })]).db,
        ORG,
        t,
        NOW,
      ),
    ).toBe(false);
  });

  it('reads the device out of an incident subject', () => {
    expect(deviceOfSubject(`device:${DEVICE}:config:power`)).toBe(DEVICE);
    expect(deviceOfSubject('somewhere:else')).toBeNull();
  });
});

describe('incidents during a window', () => {
  it('opens no incident and no alert while a window covers it, and one after', async () => {
    const w = world([win({ scope: 'room', scopeId: ROOM })]);
    const input = {
      orgId: ORG,
      roomId: ROOM,
      kind: 'device_offline' as const,
      subject: `device:${DEVICE}`,
      severity: 'warning' as const,
      title: 'Offline',
    };
    expect(await openIncident(w.db, input, NOW)).toBeNull();
    expect(w.incident.rows).toHaveLength(0);
    expect(await openIncident(w.db, input, at(3))).toMatchObject({ event: 'opened' });
    expect(w.incident.rows).toHaveLength(1);
  });
});

describe('managing windows', () => {
  it('creates, refuses nonsense, and deletes', async () => {
    const w = world();
    const base = {
      orgId: ORG,
      name: 'Firmware',
      scope: 'site' as const,
      scopeId: SITE,
      startsAt: at(1),
      endsAt: at(3),
      userId: null,
    };
    const ok = await createWindow(w.db as never, base);
    expect(ok.ok).toBe(true);
    expect((await createWindow(w.db as never, { ...base, endsAt: at(0) })).ok).toBe(false);
    expect(
      (
        await createWindow(w.db as never, {
          ...base,
          scopeId: '99999999-9999-4999-8999-999999999999',
        })
      ).ok,
    ).toBe(false);
    expect((await createWindow(w.db as never, { ...base, scopeId: null })).ok).toBe(false);
    expect((await createWindow(w.db as never, { ...base, endsAt: at(24 * 40) })).ok).toBe(false);
    if (!ok.ok) return;
    expect((await upcomingWindows(w.db, ORG, NOW)).map((x) => x.id)).toEqual([ok.value.id]);
    expect((await deleteWindow(w.db, '99999999-9999-4999-8999-999999999999', ok.value.id)).ok).toBe(
      false,
    );
    expect((await deleteWindow(w.db, ORG, ok.value.id)).ok).toBe(true);
  });
});
