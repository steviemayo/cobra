import { describe, expect, it } from 'vitest';
import {
  baselineDrift,
  compareSnapshots,
  continueDeploy,
  createProfile,
  deleteProfile,
  deviceConfigView,
  evaluateConfig,
  planProfileDeploy,
  rollbackDeploy,
  setBaseline,
  setDeviceConfig,
  snapshotAll,
  startDeploy,
  takeSnapshot,
  updateProfile,
  type ConfigDb,
} from './config-service';
import { table } from './test-db';

const ORG = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-30T10:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const uid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function world() {
  const device = table([
    {
      id: uid(1),
      orgId: ORG,
      roomId: uid(9),
      name: 'Lobby display',
      kind: 'active',
      category: 'display',
      control: { kind: 'generic', protocol: 'pjlink' },
      firmware: '1.0',
      profileId: null,
      configParams: [],
      configState: {},
      feedback: { power: 'on', volume: 40 },
      details: [{ title: 'Device', rows: [{ label: 'Serial number', value: 'A1' }] }],
      settings: {},
      values: { host: '10.0.0.5', password: 'x' },
      lastSeenAt: NOW,
    },
    {
      id: uid(2),
      orgId: ORG,
      roomId: uid(9),
      name: 'Camera',
      kind: 'active',
      category: 'ptz_camera',
      control: { kind: 'driver', driverId: 'visca-ip' },
      firmware: null,
      profileId: null,
      configParams: [],
      configState: {},
      feedback: { power: 'on' },
      details: null,
      settings: {},
      values: {},
      lastSeenAt: NOW,
    },
    {
      id: uid(3),
      orgId: ORG,
      roomId: null,
      name: 'Laptop',
      kind: 'passive',
      category: 'computer',
      feedback: null,
    },
  ]);
  const deviceEvent = table([]);
  const configProfile = table([]);
  const deviceSnapshot = table([]);
  const configDeploy = table([]);
  const incident = table([]);
  const db = {
    device,
    deviceEvent,
    configProfile,
    deviceSnapshot,
    configDeploy,
    incident,
  } as unknown as ConfigDb;
  return { db, device, deviceEvent, configProfile, deviceSnapshot, configDeploy, incident };
}

const enforcePower = { field: 'power', value: 'on', mode: 'enforce' };
const watchVolume = { field: 'volume', value: 40, mode: 'watch' };

async function profile(
  w: ReturnType<typeof world>,
  params: unknown[] = [enforcePower, watchVolume],
  name = 'Meeting display',
) {
  const r = await createProfile(w.db, { orgId: ORG, name, params, userId: null });
  if (!r.ok) throw new Error(r.message);
  return r.value.id;
}

describe('profiles', () => {
  it('creates, refuses a bad setting or a repeat, and raises the version on a change', async () => {
    const w = world();
    const id = await profile(w);
    expect(
      (await createProfile(w.db, { orgId: ORG, name: 'Meeting display', params: [], userId: null }))
        .ok,
    ).toBe(false);
    expect(
      (
        await createProfile(w.db, {
          orgId: ORG,
          name: 'Odd',
          params: [{ field: 'colour', value: 'red', mode: 'watch' }],
          userId: null,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await createProfile(w.db, {
          orgId: ORG,
          name: 'Twice',
          params: [enforcePower, enforcePower],
          userId: null,
        })
      ).ok,
    ).toBe(false);
    await updateProfile(w.db, { orgId: ORG, profileId: id, params: [enforcePower] });
    expect(w.configProfile.rows[0]!.version).toBe(2);
    await updateProfile(w.db, { orgId: ORG, profileId: id, params: [enforcePower] });
    expect(w.configProfile.rows[0]!.version).toBe(2);
  });

  it('lets its devices go when it is deleted', async () => {
    const w = world();
    const id = await profile(w);
    await setDeviceConfig(w.db, { orgId: ORG, deviceId: uid(1), profileId: id, actorId: null });
    await deleteProfile(w.db, ORG, id);
    expect(w.device.rows[0]!.profileId).toBeNull();
    expect(w.configProfile.rows).toHaveLength(0);
  });
});

describe('a device own settings', () => {
  it('only records a setting the device reports', async () => {
    const w = world();
    // The camera reports power but not volume.
    const refused = await setDeviceConfig(w.db, {
      orgId: ORG,
      deviceId: uid(2),
      params: [watchVolume],
      actorId: null,
    });
    expect(refused).toMatchObject({
      ok: false,
      message: expect.stringMatching(/not something this device reports/),
    });
    expect(
      (
        await setDeviceConfig(w.db, {
          orgId: ORG,
          deviceId: uid(2),
          params: [enforcePower],
          actorId: null,
        })
      ).ok,
    ).toBe(true);
    expect(
      (await setDeviceConfig(w.db, { orgId: ORG, deviceId: uid(3), params: [], actorId: null })).ok,
    ).toBe(false);
  });

  it('shows settings a profile has that the device does not report as not applicable', async () => {
    const w = world();
    const id = await profile(w);
    await setDeviceConfig(w.db, { orgId: ORG, deviceId: uid(2), profileId: id, actorId: null });
    const view = (await deviceConfigView(w.db, ORG, uid(2)))!;
    expect(view.applies.map((p) => p.field)).toEqual(['power']);
    expect(view.notApplicable.map((p) => p.field)).toEqual(['volume']);
    expect(view.holdable.map((h) => h.field)).toEqual(['power']);
  });
});

describe('drift and enforcement', () => {
  const run = async (
    w: ReturnType<typeof world>,
    deviceId: string,
    readings: Record<string, unknown>,
    when = NOW,
  ) => {
    const row = w.device.rows.find((r) => r.id === deviceId) as never;
    const cache = new Map();
    const r = await evaluateConfig(w.db, row, readings, when, cache);
    if (r.state !== null)
      Object.assign(
        w.device.rows.find((x) => x.id === deviceId)!,
        { configState: r.state },
      );
    return r;
  };

  it('raises an incident and a history entry when a held setting changes, sends an enforced one back, and closes when fixed', async () => {
    const w = world();
    const id = await profile(w);
    await setDeviceConfig(w.db, { orgId: ORG, deviceId: uid(1), profileId: id, actorId: null });
    const drift = await run(w, uid(1), { power: 'off', volume: 40 });
    expect(drift.enforce).toEqual([{ deviceId: uid(1), command: { type: 'power', on: true } }]);
    expect(drift.jobs).toHaveLength(1);
    expect(w.incident.rows[0]).toMatchObject({ kind: 'config_drift', status: 'open' });
    expect(w.deviceEvent.rows.map((e) => e.type)).toContain('config_drift');
    const fixed = await run(w, uid(1), { power: 'on', volume: 40 }, at(5_000));
    expect(fixed.enforce).toEqual([]);
    expect(w.incident.rows[0]!.status).toBe('resolved');
    expect(w.deviceEvent.rows.map((e) => e.type)).toContain('config_corrected');
  });

  it('watches a setting without putting it back', async () => {
    const w = world();
    const id = await profile(w);
    await setDeviceConfig(w.db, { orgId: ORG, deviceId: uid(1), profileId: id, actorId: null });
    const r = await run(w, uid(1), { power: 'on', volume: 90 });
    expect(r.enforce).toEqual([]);
    expect(w.incident.rows).toHaveLength(1);
  });

  it('never tracks a setting the device does not report', async () => {
    const w = world();
    const id = await profile(w);
    await setDeviceConfig(w.db, { orgId: ORG, deviceId: uid(2), profileId: id, actorId: null });
    // The camera has no volume reading, so the profile volume is not applicable and raises nothing.
    const r = await run(w, uid(2), { power: 'on' });
    expect(r.enforce).toEqual([]);
    expect(w.incident.rows).toHaveLength(0);
  });

  it('does nothing for a device with no profile and no settings', async () => {
    const w = world();
    const r = await run(w, uid(1), { power: 'off' });
    expect(r).toEqual({ enforce: [], jobs: [], state: null });
  });
});

describe('snapshots', () => {
  it('takes snapshots without logins, keeps one baseline, and compares with the live device', async () => {
    const w = world();
    const first = await takeSnapshot(
      w.db,
      { orgId: ORG, deviceId: uid(1), reason: 'manual', userId: null, baseline: true },
      NOW,
    );
    if (!first.ok) throw new Error(first.message);
    expect(JSON.stringify(w.deviceSnapshot.rows[0]!.data)).not.toContain('"password"');
    const second = await takeSnapshot(
      w.db,
      { orgId: ORG, deviceId: uid(1), reason: 'manual', userId: null, baseline: true },
      at(1000),
    );
    if (!second.ok) throw new Error(second.message);
    expect(w.deviceSnapshot.rows.filter((s) => s.isBaseline)).toHaveLength(1);
    await setBaseline(w.db, ORG, first.value.id);
    expect(w.deviceSnapshot.rows.find((s) => s.id === first.value.id)!.isBaseline).toBe(true);
    // The device changes: its volume and firmware differ from the baseline.
    Object.assign(w.device.rows[0]!, { firmware: '1.1', feedback: { power: 'on', volume: 70 } });
    const drift = (await baselineDrift(w.db, ORG, uid(1)))!;
    expect(drift.changes.map((c) => c.key)).toEqual(['firmware', 'reading: volume']);
    const cmp = (await compareSnapshots(w.db, {
      orgId: ORG,
      deviceId: uid(1),
      from: first.value.id,
      to: 'live',
    }))!;
    expect(cmp.changes).toHaveLength(2);
    expect(
      await compareSnapshots(w.db, { orgId: ORG, deviceId: uid(1), from: 'nope', to: 'live' }),
    ).toBeNull();
  });

  it('refuses a snapshot of a recorded-only device, and takes one per monitored device daily', async () => {
    const w = world();
    expect(
      (await takeSnapshot(w.db, { orgId: ORG, deviceId: uid(3), reason: 'manual', userId: null }))
        .ok,
    ).toBe(false);
    expect(await snapshotAll(w.db, NOW)).toBe(2);
  });
});

describe('deploying a profile', () => {
  it('plans a dry run, deploys to a canary first, then the rest, and rolls back to what it was', async () => {
    const w = world();
    const id = await profile(w);
    // The display was on before; it is turned off by someone, then the deploy is made.
    const plan = (await planProfileDeploy(w.db, {
      orgId: ORG,
      profileId: id,
      deviceIds: [uid(1), uid(2)],
    }))!;
    expect(plan.rows.find((r) => r.deviceId === uid(1))).toMatchObject({ conforming: true });
    expect(plan.rows.find((r) => r.deviceId === uid(2))!.notApplicable).toEqual(['volume']);

    const started = await startDeploy(
      w.db,
      { orgId: ORG, profileId: id, deviceIds: [uid(1), uid(2)], canaryCount: 1, userId: null },
      NOW,
    );
    if (!started.ok) throw new Error(started.message);
    expect(started.value.stage).toBe('canary');
    expect(w.device.rows[0]!.profileId).toBe(id);
    expect(w.device.rows[1]!.profileId).toBeNull();
    expect(w.deviceSnapshot.rows.filter((s) => s.reason === 'before_deploy')).toHaveLength(2);

    await continueDeploy(w.db, ORG, started.value.id, null, at(1000));
    expect(w.device.rows[1]!.profileId).toBe(id);
    expect(w.configDeploy.rows[0]!.stage).toBe('done');

    const back = await rollbackDeploy(w.db, ORG, started.value.id, null, at(2000));
    expect(back.ok).toBe(true);
    expect(w.device.rows[0]!.profileId).toBeNull();
    // What it was before is queued to be sent back once.
    expect(
      (w.device.rows[0]!.configState as { __push: Record<string, unknown> }).__push,
    ).toMatchObject({ power: 'on', volume: 40 });
    expect((await rollbackDeploy(w.db, ORG, started.value.id, null)).ok).toBe(false);
  });

  it('pushes the profile values once when it is applied, whatever the mode', async () => {
    const w = world();
    const id = await profile(w, [{ field: 'volume', value: 25, mode: 'once' }]);
    await startDeploy(
      w.db,
      { orgId: ORG, profileId: id, deviceIds: [uid(1)], canaryCount: 0, userId: null },
      NOW,
    );
    const row = w.device.rows[0] as never;
    const r = await evaluateConfig(w.db, row, { power: 'on', volume: 40 }, at(1000), new Map());
    expect(r.enforce).toEqual([{ deviceId: uid(1), command: { type: 'volume', level: 25 } }]);
    expect(r.state).toEqual({});
  });

  it('refuses to deploy to no monitored devices, or a profile from another organisation', async () => {
    const w = world();
    const id = await profile(w);
    expect(
      (
        await startDeploy(w.db, {
          orgId: ORG,
          profileId: id,
          deviceIds: [uid(3)],
          canaryCount: 0,
          userId: null,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await startDeploy(w.db, {
          orgId: '99999999-9999-4999-8999-999999999999',
          profileId: id,
          deviceIds: [uid(1)],
          canaryCount: 0,
          userId: null,
        })
      ).ok,
    ).toBe(false);
  });
});
