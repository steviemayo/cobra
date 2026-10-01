import { describe, expect, it } from 'vitest';
import { ControlPoint, checkWatch } from '@kestrel/model';
import { validatePoints } from '../server/device-points';
import { gainPoints, namedControlPoint, routerPoints, slug, uniqueIds } from './qsys-points';

const QSYS = { kind: 'driver', driverId: 'qsys-core' };

describe('Q-SYS points from what a person types', () => {
  it('a gain component gives a level and a mute, in the Core’s own range', () => {
    const [level, mute] = gainPoints('Boardroom Gain', { minDb: -30, muteShouldBe: false });
    expect(level).toMatchObject({
      id: 'boardroom-gain-gain',
      name: 'Boardroom Gain level',
      type: 'level',
      address: { component: 'Boardroom Gain', control: 'gain' },
      min: -100,
      max: 20,
    });
    expect(mute).toMatchObject({
      type: 'mute',
      address: { component: 'Boardroom Gain', control: 'mute' },
      watch: { expect: false, severity: 'warning' },
    });
  });

  it('turns dB limits into the 0 to 100 value that is checked, so a quiet gain is caught', () => {
    const [level] = gainPoints('Mics', { minDb: -30, maxDb: 6 })!;
    // -30 dB on a -100..20 scale is 58 of 100; +6 dB is 88 of 100.
    expect(level!.watch).toMatchObject({ min: 58, max: 88 });
    // The driver reports a gain of -50 dB as 42: below the limit.
    expect(checkWatch('Mics level', level!.watch!, 42)).toMatchObject({ ok: false });
    expect(checkWatch('Mics level', level!.watch!, 70)).toEqual({ ok: true });
  });

  it('watches nothing unless asked to', () => {
    const [level, mute] = gainPoints('Mics');
    expect(level!.watch).toBeUndefined();
    expect(mute!.watch).toBeUndefined();
  });

  it('a router gives one selector per output, select.1 to select.n', () => {
    const out = routerPoints('Main Router', 4);
    expect(out.map((p) => p.address.control)).toEqual([
      'select.1',
      'select.2',
      'select.3',
      'select.4',
    ]);
    expect(out[1]).toMatchObject({
      id: 'main-router-out2',
      name: 'Main Router output 2',
      type: 'select',
      address: { component: 'Main Router', control: 'select.2' },
    });
    expect(routerPoints('R', 0)).toHaveLength(1);
    expect(routerPoints('R', 500)).toHaveLength(64);
  });

  it('a named control stands alone, with the kind of value it holds and what to expect', () => {
    expect(namedControlPoint('Mic Mute', 'boolean', false)).toEqual({
      id: 'ctl-mic-mute',
      name: 'Mic Mute',
      type: 'generic',
      valueType: 'boolean',
      address: { control: 'Mic Mute' },
      watch: { expect: false, severity: 'warning' },
    });
    expect(namedControlPoint('Scene', 'integer', 3).watch).toMatchObject({ expect: 3 });
    expect(namedControlPoint('Status', 'text', 'OK').watch).toMatchObject({ expect: 'OK' });
    expect(namedControlPoint('Status', 'text', '').watch).toBeUndefined();
    expect(namedControlPoint('Status', 'text').watch).toBeUndefined();
  });

  it('everything it builds is a valid point for the Q-SYS driver', () => {
    const all = [
      ...gainPoints('Boardroom', { minDb: -30, muteShouldBe: false }),
      ...routerPoints('Router', 3),
      namedControlPoint('Mic Mute', 'boolean', false),
      namedControlPoint('Scene', 'integer'),
      namedControlPoint('Status', 'text', 'OK'),
    ];
    for (const p of all) expect(ControlPoint.safeParse(p).success).toBe(true);
    expect(validatePoints(QSYS, all)).toBeNull();
  });

  it('makes ids from names, and keeps them unique when the same thing is added twice', () => {
    expect(slug('  Room 1 / Gain! ')).toBe('room-1-gain');
    expect(slug('!!!')).toBe('point');
    const added = uniqueIds(routerPoints('Router', 2), ['router-out1']);
    expect(added.map((p) => p.id)).toEqual(['router-out1-2', 'router-out2']);
  });
});
