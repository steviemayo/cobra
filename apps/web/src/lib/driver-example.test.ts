import { describe, expect, it } from 'vitest';
import { checkDriverSpec } from '@kestrel/model';
import { STARTER, preview, readFeedback } from './driver-example';

// The how-to guide shows these values, so they are pinned here.
describe('driver example', () => {
  it('passes the driver check', () => {
    expect(checkDriverSpec(STARTER)).toMatchObject({ ok: true });
  });

  it('renders the commands the guide lists', () => {
    const at = (key: string, sample: Parameters<typeof preview>[1]) => preview(STARTER, sample).find((c) => c.key === key)?.text;
    expect(at('power.on', {})).toBe('PWR ON');
    expect(at('volume', { level: 0 })).toBe('VOL 0');
    expect(at('volume', { level: 50 })).toBe('VOL 15');
    expect(at('volume', { level: 100 })).toBe('VOL 30');
    expect(at('select_input', { input: 'in1' })).toBe('SRC 1');
    expect(at('select_input', { input: 'in2' })).toBe('SRC 2');
  });

  it('reads replies the way the guide says', () => {
    expect(readFeedback(STARTER, 'POWER=ON')).toEqual([{ set: 'power', result: 'on' }]);
    expect(readFeedback(STARTER, 'POWER=OFF')).toEqual([{ set: 'power', result: 'off' }]);
    expect(readFeedback(STARTER, 'POWER=STANDBY')).toEqual([]);
    expect(readFeedback(STARTER, 'power=on')).toEqual([]);
    expect(readFeedback(STARTER, 'OK')).toEqual([]);
  });

  it('scales a volume reply onto 0-100', () => {
    const spec = { ...STARTER, feedback: { poll: [], patterns: [{ match: '^VOL=(\\d+)', set: 'volume', value: '$1' }] } };
    expect(readFeedback(spec, 'VOL=15')).toEqual([{ set: 'volume', result: '50' }]);
  });
});
