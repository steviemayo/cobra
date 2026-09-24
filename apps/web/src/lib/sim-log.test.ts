import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, defaultDeviceState, type DeviceState } from '@kestrel/model';
import { describeChange } from './sim-log';

const model = STARTER_TEMPLATES[0]!.model;
const device = (id: string) => model.devices.find((d) => d.id === id)!;
const state = (over: Partial<DeviceState> = {}): DeviceState => ({
  ...defaultDeviceState(),
  ...over,
});

describe('describeChange', () => {
  it('says nothing for the first snapshot or no change', () => {
    expect(describeChange(device('display1'), undefined, state({ power: 'off' }))).toEqual([]);
    expect(
      describeChange(device('display1'), state({ power: 'on' }), state({ power: 'on' })),
    ).toEqual([]);
  });

  it('describes power and input changes', () => {
    expect(
      describeChange(device('display1'), state({ power: 'off' }), state({ power: 'warming' })),
    ).toEqual(['Display 1 is warming up']);
    expect(
      describeChange(
        device('display1'),
        state({ power: 'on', selectedInput: null }),
        state({ power: 'on', selectedInput: 'in' }),
      ),
    ).toEqual(['Display 1 switched to Input']);
  });

  it('describes matrix routes by port name', () => {
    expect(
      describeChange(
        device('matrix'),
        state({ routes: { out1: null } }),
        state({ routes: { out1: 'in2' } }),
      ),
    ).toEqual(['Video matrix routed Input 2 to Output 1']);
    expect(
      describeChange(
        device('matrix'),
        state({ routes: { out1: 'in2' } }),
        state({ routes: { out1: null } }),
      ),
    ).toEqual(['Video matrix cleared Output 1']);
  });

  it('describes signal, DSP and connectivity changes', () => {
    expect(
      describeChange(
        device('matrix'),
        state({ signal: { in1: false } }),
        state({ signal: { in1: true } }),
      ),
    ).toEqual(['Video matrix: signal on Input 1']);
    expect(
      describeChange(
        device('dsp'),
        state({ muted: true, volume: 50 }),
        state({ muted: false, volume: 60 }),
      ),
    ).toEqual(['DSP unmuted', 'DSP volume 60']);
    expect(describeChange(device('dsp'), state(), state({ online: false }))).toEqual([
      'DSP went offline',
    ]);
  });
});
