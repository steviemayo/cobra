import type { Device } from '@kestrel/model';
import { GenericTcpDriver } from './generic-tcp';
import { PjlinkDriver } from './pjlink';
import type { DeviceDriver, DriverContext } from './types';

/**
 * Picks a real driver for a device from its control setting. Returns null when there isn't one
 * yet (serial, REST and the vendor drivers arrive later); the room then reports that device by
 * name if something needs it.
 */
export function createDriver(device: Device, ctx: DriverContext): DeviceDriver | null {
  const control = device.control;
  if (!control) return null;
  if (control.kind === 'generic') {
    if (control.protocol === 'pjlink') return new PjlinkDriver(device, ctx);
    if (control.protocol === 'tcp') return new GenericTcpDriver(device, ctx);
    return null;
  }
  return null;
}
