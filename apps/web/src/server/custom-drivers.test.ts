import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type RoomModel } from '@kestrel/model';
import { MAX_DRIVERS_PER_ORG, pinDrivers, saveDriver, type DriverDb } from './custom-drivers';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '11111111-1111-4111-8111-111111111112';

const spec = (over: Record<string, unknown> = {}) => ({
  id: 'acme-amp',
  name: 'Acme amp',
  transport: { type: 'tcp', port: 4001 },
  commands: { 'power.on': { send: 'PWR ON' }, 'power.off': { send: 'PWR OFF' } },
  ...over,
});

function world() {
  const customDriver = table([]);
  const customDriverVersion = table([]);
  // Prisma's unique key on (driverId, version) as the in-memory table has none.
  return { db: { customDriver, customDriverVersion } as unknown as DriverDb, customDriver, customDriverVersion };
}

const withDriver = (driverId: string, driverVersion?: string): RoomModel => {
  const m = structuredClone(STARTER_TEMPLATES[0]!.model);
  const d = m.devices.find((x) => x.id === 'dsp')!;
  d.control = { kind: 'driver', driverId, ...(driverVersion ? { driverVersion } : {}) };
  return m;
};

describe('saving a driver', () => {
  it('creates version 1, then a new version for each real change, and none for a repeat', async () => {
    const w = world();
    const a = await saveDriver(w.db, { orgId: ORG, raw: spec(), by: 'u' });
    expect(a).toMatchObject({ ok: true, version: 1, created: true });
    const again = await saveDriver(w.db, { orgId: ORG, raw: spec(), by: 'u' });
    expect(again).toMatchObject({ ok: true, version: 1, created: false });
    expect(w.customDriverVersion.rows).toHaveLength(1);
    const b = await saveDriver(w.db, { orgId: ORG, raw: spec({ commands: { 'power.on': { send: 'ON' } } }), by: 'u' });
    expect(b).toMatchObject({ ok: true, version: 2, created: false });
    expect(w.customDriver.rows[0]).toMatchObject({ latestVersion: 2 });
    expect(w.customDriverVersion.rows.map((v) => (v.spec as { version: number }).version)).toEqual([1, 2]);
  });

  it('does not let a spec claim its own version number', async () => {
    const w = world();
    await saveDriver(w.db, { orgId: ORG, raw: spec({ version: 99 }), by: 'u' });
    expect((w.customDriverVersion.rows[0]!.spec as { version: number }).version).toBe(1);
  });

  it('refuses a driver that does not check out, with the reasons', async () => {
    const w = await Promise.resolve(world());
    const res = await saveDriver(w.db, { orgId: ORG, raw: spec({ commands: { reboot: { send: 'x' } } }), by: 'u' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.problems[0]).toContain('not a command Kestrel knows');
    expect(w.customDriver.rows).toHaveLength(0);
  });

  it('keeps organisations apart, and caps how many drivers one can have', async () => {
    const w = world();
    await saveDriver(w.db, { orgId: ORG, raw: spec(), by: 'u' });
    expect(await saveDriver(w.db, { orgId: OTHER, raw: spec(), by: 'u' })).toMatchObject({ created: true });
    for (let i = 0; i < MAX_DRIVERS_PER_ORG; i++) w.customDriver.rows.push({ id: `x${i}`, orgId: ORG, slug: `filler-${i}` });
    const over = await saveDriver(w.db, { orgId: ORG, raw: spec({ id: 'one-more' }), by: 'u' });
    expect(over.ok).toBe(false);
  });
});

describe('pinning drivers into a release', () => {
  it('copies the version each device names, or the latest', async () => {
    const w = world();
    await saveDriver(w.db, { orgId: ORG, raw: spec(), by: 'u' });
    await saveDriver(w.db, { orgId: ORG, raw: spec({ commands: { 'power.on': { send: 'ON' } } }), by: 'u' });
    const latest = await pinDrivers(w.db, ORG, withDriver('custom:acme-amp'));
    expect(latest.ok && latest.drivers['custom:acme-amp']).toMatchObject({ version: 2 });
    const old = await pinDrivers(w.db, ORG, withDriver('custom:acme-amp', '1'));
    expect(old.ok && old.drivers['custom:acme-amp']).toMatchObject({ version: 1, spec: { commands: { 'power.off': { send: 'PWR OFF' } } } });
  });

  it('ignores built-in and generic drivers', async () => {
    const w = world();
    const r = await pinDrivers(w.db, ORG, withDriver('qsys-core'));
    expect(r).toEqual({ ok: true, drivers: {} });
  });

  it('stops a release that names a driver the organisation does not have, or a version that does not exist', async () => {
    const w = world();
    await saveDriver(w.db, { orgId: OTHER, raw: spec(), by: 'u' });
    const notMine = await pinDrivers(w.db, ORG, withDriver('custom:acme-amp'));
    expect(!notMine.ok && notMine.problems[0]).toContain('doesn’t have');
    await saveDriver(w.db, { orgId: ORG, raw: spec(), by: 'u' });
    const noVersion = await pinDrivers(w.db, ORG, withDriver('custom:acme-amp', '7'));
    expect(!noVersion.ok && noVersion.problems[0]).toContain('version 7');
  });

  it('will not build a release from a stored spec that has since become invalid', async () => {
    const w = world();
    await saveDriver(w.db, { orgId: ORG, raw: spec(), by: 'u' });
    w.customDriverVersion.rows[0]!.spec = { nonsense: true };
    const r = await pinDrivers(w.db, ORG, withDriver('custom:acme-amp'));
    expect(r.ok).toBe(false);
  });
});
