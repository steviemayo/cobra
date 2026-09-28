import { describe, expect, it } from 'vitest';
import { assertDeviceAddress, isLinkLocal, localAddressAllowed } from './address-guard';

describe('isLinkLocal', () => {
  it('recognises a cloud metadata address, however it is spelled', () => {
    for (const host of [
      '169.254.169.254',
      '169.254.0.1',
      'fe80::1',
      '[fe80::1]',
      '::ffff:169.254.169.254',
    ])
      expect(isLinkLocal(host), host).toBe(true);
  });

  it('leaves the gateway’s own loopback and ordinary room-device addresses alone', () => {
    // Loopback is deliberately not blocked here (see address-guard.ts); it is left to the admin
    // page's own lockout and to Watchtower's token.
    for (const host of [
      'localhost',
      '127.0.0.1',
      '::1',
      '10.0.0.5',
      '192.168.1.20',
      '172.16.4.4',
      'projector.local',
      'avmixer',
      '2606:4700::1111',
    ])
      expect(isLinkLocal(host), host).toBe(false);
  });
});

describe('localAddressAllowed / assertDeviceAddress', () => {
  it('refuses a blocked address unless the device settings explicitly allow it', () => {
    expect(localAddressAllowed({})).toBe(false);
    expect(localAddressAllowed({ allowLocalAddress: true })).toBe(true);
    expect(() => assertDeviceAddress('169.254.169.254', {})).toThrow('cloud metadata');
    expect(() => assertDeviceAddress('169.254.169.254', { allowLocalAddress: true })).not.toThrow();
    expect(() => assertDeviceAddress('10.0.0.5', {})).not.toThrow();
  });
});
