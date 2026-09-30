import { describe, expect, it } from 'vitest';
import {
  ENFORCE_COOLDOWN_MS,
  ENFORCE_MAX_ATTEMPTS,
  checkConfigParam,
  diffSnapshots,
  effectiveParams,
  holdableFields,
  paramCommand,
  planDeploy,
  splitApplicable,
  stepDrift,
  stripSecrets,
  type ConfigParam,
  type ConfigState,
  type SnapshotData,
} from './config';

const T0 = Date.UTC(2026, 8, 30, 10, 0);
const power: ConfigParam = { field: 'power', value: 'on', mode: 'enforce' };
const volume: ConfigParam = { field: 'volume', value: 40, mode: 'watch' };

describe('parameters', () => {
  it('only accepts settings Kestrel can hold and set', () => {
    expect(checkConfigParam(power)).toBeNull();
    expect(checkConfigParam({ field: 'colour', value: 'red', mode: 'watch' })).toMatch(
      /cannot be held/,
    );
    expect(checkConfigParam({ field: 'volume', value: 150, mode: 'watch' })).toMatch(
      /cannot be set/,
    );
    expect(checkConfigParam({ field: 'power', value: 'sideways', mode: 'watch' })).toMatch(
      /cannot be set/,
    );
  });

  it('turns a parameter into the command that sets it', () => {
    expect(paramCommand(power)).toEqual({ type: 'power', on: true });
    expect(paramCommand(volume)).toEqual({ type: 'volume', level: 40 });
    expect(paramCommand({ field: 'muted', value: true, mode: 'once' })).toEqual({
      type: 'mute',
      muted: true,
    });
  });

  it('lets a device own setting replace the profile one for the same field', () => {
    const merged = effectiveParams(
      [power, volume],
      [{ field: 'volume', value: 20, mode: 'enforce' }],
    );
    expect(merged.find((p) => p.field === 'volume')).toMatchObject({ value: 20, mode: 'enforce' });
    expect(merged).toHaveLength(2);
  });

  it('only applies a parameter to a device that reports that reading', () => {
    const { applies, skipped } = splitApplicable([power, volume], ['power', 'input']);
    expect(applies.map((p) => p.field)).toEqual(['power']);
    expect(skipped.map((p) => p.field)).toEqual(['volume']);
    expect(holdableFields(['power', 'input', 'volume', 'power'])).toEqual(['power', 'volume']);
  });
});

describe('stepDrift', () => {
  it('reports a setting that starts to drift once, and sends an enforced one back', () => {
    const first = stepDrift([power], {}, { power: 'off' }, T0);
    expect(first.newlyDrifted).toEqual([{ field: 'power', desired: 'on', actual: 'off' }]);
    expect(first.enforce).toEqual([{ field: 'power', command: { type: 'power', on: true } }]);
    expect(first.state.power).toMatchObject({ drifted: true, attempts: 1 });
    // Still off half a minute later: no second report, and not sent again inside the cool-down.
    const again = stepDrift([power], first.state, { power: 'off' }, T0 + 30_000);
    expect(again.newlyDrifted).toEqual([]);
    expect(again.enforce).toEqual([]);
    // After the cool-down it is tried again.
    const later = stepDrift([power], first.state, { power: 'off' }, T0 + ENFORCE_COOLDOWN_MS + 1);
    expect(later.enforce).toHaveLength(1);
    expect(later.state.power!.attempts).toBe(2);
  });

  it('notes a correction when a sent-back setting reads right again', () => {
    const first = stepDrift([power], {}, { power: 'off' }, T0);
    const fixed = stepDrift([power], first.state, { power: 'on' }, T0 + 5_000);
    expect(fixed.newlyOk).toEqual([{ field: 'power', corrected: true }]);
    expect(fixed.state.power).toBeUndefined();
  });

  it('a watched setting is reported but never sent back, and a person putting it right is not a correction', () => {
    const first = stepDrift([volume], {}, { volume: 80 }, T0);
    expect(first.newlyDrifted).toHaveLength(1);
    expect(first.enforce).toEqual([]);
    const fixed = stepDrift([volume], first.state, { volume: 40 }, T0 + 5_000);
    expect(fixed.newlyOk).toEqual([{ field: 'volume', corrected: false }]);
  });

  it('gives up after too many tries', () => {
    let state: ConfigState = {};
    let gaveUp = false;
    for (let i = 0; i < ENFORCE_MAX_ATTEMPTS + 2; i++) {
      const step = stepDrift([power], state, { power: 'off' }, T0 + i * (ENFORCE_COOLDOWN_MS + 1));
      state = step.state;
      if (step.giveUp.length) gaveUp = true;
    }
    expect(gaveUp).toBe(true);
    expect(state.power!.attempts).toBe(ENFORCE_MAX_ATTEMPTS);
  });

  it('ignores a reading the device did not give, and apply-once settings', () => {
    const drifted: ConfigState = {
      power: { drifted: true, desired: 'on', actual: 'off', since: 'x', attempts: 1 },
    };
    const silent = stepDrift([power], drifted, {}, T0);
    expect(silent.state.power).toBe(drifted.power);
    expect(silent.newlyOk).toEqual([]);
    const once = stepDrift(
      [{ field: 'power', value: 'on', mode: 'once' }],
      {},
      { power: 'off' },
      T0,
    );
    expect(once.newlyDrifted).toEqual([]);
    expect(once.state).toEqual({});
  });

  it('clears the drift of a setting that is no longer held', () => {
    const drifted: ConfigState = {
      volume: { drifted: true, desired: '40', actual: '80', since: 'x', attempts: 0 },
    };
    expect(stepDrift([], drifted, { volume: 80 }, T0).cleared).toEqual(['volume']);
  });
});

describe('snapshots', () => {
  const base: SnapshotData = {
    driver: 'pjlink',
    firmware: '1.0',
    feedback: { power: 'on', volume: 40 },
    settings: { host: '10.0.0.5', password: 'x' },
    details: [
      {
        title: 'Device',
        rows: [
          { label: 'Serial number', value: 'A1' },
          { label: 'Uptime', value: '3 days' },
        ],
      },
    ],
  };

  it('compares two snapshots and ignores rows that change by themselves', () => {
    const later: SnapshotData = {
      ...base,
      firmware: '1.1',
      feedback: { power: 'on', volume: 55 },
      details: [
        {
          title: 'Device',
          rows: [
            { label: 'Serial number', value: 'A1' },
            { label: 'Uptime', value: '9 days' },
          ],
        },
      ],
    };
    expect(diffSnapshots(base, later)).toEqual([
      { key: 'firmware', before: '1.0', after: '1.1' },
      { key: 'reading: volume', before: '40', after: '55' },
    ]);
  });

  it('shows a setting that appeared or vanished', () => {
    const changes = diffSnapshots(base, {
      ...base,
      settings: { host: '10.0.0.5', port: 4352 },
      feedback: { power: 'on' },
    });
    expect(changes.map((c) => c.key)).toEqual([
      'reading: volume',
      'setting: password',
      'setting: port',
    ]);
  });

  it('leaves anything that could be a login out of a snapshot', () => {
    expect(stripSecrets({ host: 'a', password: 'b', apiToken: 'c', port: 1 })).toEqual({
      host: 'a',
      port: 1,
    });
  });
});

describe('planDeploy', () => {
  it('lists what a push would change from what the device reads now', () => {
    const plan = planDeploy([power, volume], { power: 'off', volume: 40 });
    expect(plan).toEqual([
      { field: 'power', from: 'off', to: 'on', mode: 'enforce', willSet: true },
      { field: 'volume', from: '40', to: '40', mode: 'watch', willSet: false },
    ]);
  });
});
