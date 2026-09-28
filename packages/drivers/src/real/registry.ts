import type { Device, PinnedDriver } from '@kestrel/model';
import { LIBRARY } from '../library';
import { DeclarativeDriver } from './declarative';
import { GenericTcpDriver } from './generic-tcp';
import { genericRestDriver } from './generic-rest';
import { AVOIP_SWITCHER_IDS } from './avoip';
import { Crestron4SeriesDriver } from './crestron-4series';
import { CrestronTswDriver } from './crestron-tsw';
import { NvxDriver } from './nvx';
import { NvxDecoderDriver, NvxEncoderDriver } from './nvx-endpoints';
import { PjlinkDriver } from './pjlink';
import { QsysDriver } from './qsys';
import { SerialDriver } from './serial';
import { TesiraDriver } from './tesira';
import { ViscaDriver } from './visca';
import type { DeviceDriver, DriverContext } from './types';

/**
 * Picks a real driver for a device from its control setting. Returns null when there isn't one
 * yet; the room then reports that device by name if something needs it.
 */
export function createDriver(
  device: Device,
  ctx: DriverContext,
  /** Custom drivers pinned into the release, by `custom:<id>`. */
  custom: Record<string, PinnedDriver> = {},
): DeviceDriver | null {
  const control = device.control;
  if (!control) return null;
  if (control.kind === 'generic') {
    if (control.protocol === 'pjlink') return new PjlinkDriver(device, ctx);
    if (control.protocol === 'tcp') return new GenericTcpDriver(device, ctx);
    if (control.protocol === 'serial') return new SerialDriver(device, ctx);
    if (control.protocol === 'rest') return genericRestDriver(device, ctx);
    return null;
  }
  if (control.driverId.startsWith('lib:')) {
    const spec = LIBRARY[control.driverId];
    return spec ? new DeclarativeDriver(device, ctx, spec) : null;
  }
  if (control.driverId.startsWith('custom:')) {
    const pinned = custom[control.driverId];
    return pinned ? new DeclarativeDriver(device, ctx, pinned.spec) : null;
  }
  return BUILT_IN[control.driverId]?.(device, ctx) ?? null;
}

/** Drivers that ship with Kestrel, by the id a device names in its control setting. */
const BUILT_IN: Record<string, (device: Device, ctx: DriverContext) => DeviceDriver> = {
  'crestron-dm-nvx': (d, c) => new NvxDriver(d, c),
  'crestron-nvx-encoder': (d, c) => new NvxEncoderDriver(d, c),
  'crestron-nvx-decoder': (d, c) => new NvxDecoderDriver(d, c),
  'qsys-core': (d, c) => new QsysDriver(d, c),
  'biamp-tesira': (d, c) => new TesiraDriver(d, c),
  'visca-ip': (d, c) => new ViscaDriver(d, c),
  'crestron-4series': (d, c) => new Crestron4SeriesDriver(d, c),
  'crestron-tsw': (d, c) => new CrestronTswDriver(d, c),
};
export const BUILT_IN_DRIVER_IDS = [
  ...Object.keys(BUILT_IN),
  ...AVOIP_SWITCHER_IDS,
  ...Object.keys(LIBRARY),
];
