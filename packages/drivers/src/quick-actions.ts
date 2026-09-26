import { BUILT_IN_DRIVERS, type DeviceControl, type PinnedDriver, type QuickActionId } from '@kestrel/model';
import { LIBRARY } from './library';

/**
 * The quick actions a device's driver supports, from its control setting alone. The simulator uses
 * this (it has no driver to ask), and it matches what the real drivers report. `custom` holds the
 * custom drivers pinned into the release, by `custom:<id>`.
 */
export function driverQuickActions(
  control: DeviceControl | undefined,
  custom: Record<string, PinnedDriver> = {},
): QuickActionId[] {
  if (!control) return [];
  if (control.kind === 'generic') return control.protocol === 'pjlink' ? ['display.blank'] : [];
  const id = control.driverId;
  const spec = id.startsWith('lib:')
    ? LIBRARY[id]
    : id.startsWith('custom:')
      ? custom[id]?.spec
      : undefined;
  return [...new Set(spec?.quickActions ?? [])];
}

/**
 * The optional features (of the driver's class) a device's driver supports, from its control
 * setting alone. The simulator uses this, and it matches what the real drivers report.
 */
export function driverFeatures(
  control: DeviceControl | undefined,
  custom: Record<string, PinnedDriver> = {},
): string[] {
  if (!control || control.kind === 'generic') return [];
  const id = control.driverId;
  if (id.startsWith('lib:')) return [...(LIBRARY[id]?.features ?? [])];
  if (id.startsWith('custom:')) return [...(custom[id]?.spec.features ?? [])];
  return [...(BUILT_IN_DRIVERS[id]?.features ?? [])];
}
