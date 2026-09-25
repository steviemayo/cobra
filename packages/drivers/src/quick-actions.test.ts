import { describe, expect, it } from 'vitest';
import { DriverSpec } from '@kestrel/model';
import { driverQuickActions } from './quick-actions';

describe("what a device's driver supports", () => {
  it('PJLink can blank; a generic TCP or REST device declares nothing', () => {
    expect(driverQuickActions({ kind: 'generic', protocol: 'pjlink' })).toEqual(['display.blank']);
    expect(driverQuickActions({ kind: 'generic', protocol: 'tcp' })).toEqual([]);
    expect(driverQuickActions({ kind: 'generic', protocol: 'rest' })).toEqual([]);
  });

  it('a device with no driver supports nothing', () => {
    expect(driverQuickActions(undefined)).toEqual([]);
  });

  it('the Cisco library driver can privacy-mute, other library and built-in drivers cannot', () => {
    expect(driverQuickActions({ kind: 'driver', driverId: 'lib:cisco-roomos' })).toEqual([
      'mics.privacy_mute',
    ]);
    expect(driverQuickActions({ kind: 'driver', driverId: 'lib:extron-sis' })).toEqual([]);
    expect(driverQuickActions({ kind: 'driver', driverId: 'qsys-core' })).toEqual([]);
    expect(driverQuickActions({ kind: 'driver', driverId: 'lib:nope' })).toEqual([]);
  });

  it('a custom driver supports what its pinned spec declares', () => {
    const spec = DriverSpec.parse({
      id: 'acme-display',
      name: 'Acme display',
      transport: { type: 'tcp' },
      quickActions: ['display.blank'],
      commands: { 'blank.on': { send: 'B1' }, 'blank.off': { send: 'B0' } },
    });
    const control = { kind: 'driver' as const, driverId: 'custom:acme-display' };
    expect(driverQuickActions(control, { 'custom:acme-display': { version: 1, spec } })).toEqual([
      'display.blank',
    ]);
    expect(driverQuickActions(control)).toEqual([]);
  });
});
