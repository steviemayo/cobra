import { describe, expect, it } from 'vitest';
import type { DeviceState, Port } from '@kestrel/model';
import { deviceFeedback, feedbackChanges } from './device-feedback';

const ports: Port[] = [
  { id: 'hdmi1', name: 'HDMI 1', direction: 'in', signal: 'video' },
  { id: 'hdmi2', name: 'HDMI 2', direction: 'in', signal: 'video' },
];
const state = (over: Partial<DeviceState> = {}): DeviceState => ({
  online: true,
  routes: {},
  signal: {},
  points: {},
  ...over,
});

describe('deviceFeedback', () => {
  it('carries over whatever the driver reported, leaving out fields it did not answer', () => {
    expect(deviceFeedback(state({ power: 'on', muted: true, volume: 40 }), ports)).toEqual({
      power: 'on',
      muted: true,
      volume: 40,
    });
  });

  it('resolves a selected input to the port’s name, not its id', () => {
    expect(deviceFeedback(state({ selectedInput: 'hdmi2' }), ports)).toEqual({ input: 'HDMI 2' });
  });

  it('drops a selected input that names a port the device no longer has', () => {
    expect(deviceFeedback(state({ selectedInput: 'gone' }), ports)).toEqual({});
  });

  it('is empty for no state at all, and for a state with nothing to say', () => {
    expect(deviceFeedback(undefined, ports)).toEqual({});
    expect(deviceFeedback(state(), ports)).toEqual({});
  });

  it('reports a false or zero value, not just a truthy one', () => {
    expect(deviceFeedback(state({ muted: false, volume: 0, recording: false }), ports)).toEqual({
      muted: false,
      volume: 0,
      recording: false,
    });
  });
});

describe('feedbackChanges', () => {
  it('lists only the fields that changed, each with its new value', () => {
    const prev = { power: 'off', muted: false } as const;
    const next = { power: 'on', muted: false, input: 'HDMI 1' } as const;
    expect(feedbackChanges(prev, next)).toEqual([
      ['power', 'on'],
      ['input', 'HDMI 1'],
    ]);
  });

  it('is empty when nothing changed, or from nothing to nothing', () => {
    expect(feedbackChanges({ power: 'on' }, { power: 'on' })).toEqual([]);
    expect(feedbackChanges({}, {})).toEqual([]);
  });

  it('never reports a field going away: only a defined new value counts as a change', () => {
    expect(feedbackChanges({ power: 'on' }, {})).toEqual([]);
  });

  it('treats false and zero as real changes, not as nothing to report', () => {
    expect(feedbackChanges({ muted: true, volume: 50 }, { muted: false, volume: 0 })).toEqual([
      ['muted', false],
      ['volume', 0],
    ]);
  });
});
