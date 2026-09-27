import { describe, expect, it, vi } from 'vitest';
import type { DeviceBus, DeviceCommand } from '@kestrel/model';
import { CONTROL_NOT_LICENSED, ControlGate } from './room-host';

const command = { type: 'power', on: true } as unknown as DeviceCommand;

function fakeBus() {
  const send = vi.fn(async () => {});
  const bus: DeviceBus = {
    send,
    getState: () => ({ online: true, routes: {}, signal: {}, points: {} }),
    subscribe: () => () => {},
  };
  return { bus, send };
}

describe('ControlGate', () => {
  it('passes commands through while control is on', async () => {
    const { bus, send } = fakeBus();
    await new ControlGate(bus, () => true).send('d1', command);
    expect(send).toHaveBeenCalledWith('d1', command);
  });

  it('refuses every command while control is off, and never reaches the device', async () => {
    const { bus, send } = fakeBus();
    await expect(new ControlGate(bus, () => false).send('d1', command)).rejects.toThrow(
      CONTROL_NOT_LICENSED,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('still reports device state while control is off, so the room stays watched', () => {
    const { bus } = fakeBus();
    expect(new ControlGate(bus, () => false).getState('d1')?.online).toBe(true);
  });

  it('follows the switch without being rebuilt', async () => {
    const { bus, send } = fakeBus();
    let on = false;
    const gate = new ControlGate(bus, () => on);
    await expect(gate.send('d1', command)).rejects.toThrow();
    on = true;
    await gate.send('d1', command);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
