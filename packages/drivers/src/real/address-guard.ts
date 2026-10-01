import { isIP } from 'node:net';

// The generic TCP, REST and declarative drivers connect wherever a device's own `host` setting
// says, because that is the whole point: an AV device can be at any address on the room's network.
// A room's own dev or owner can type that setting, and on a cloud-hosted gateway 169.254.169.254
// (and the rest of that /16) is the cloud provider's own instance metadata: credentials for the
// gateway's own cloud account, never a room device. That is refused by default; a device's own
// `allowLocalAddress: true` setting is the explicit way around it, for the rare real device that
// is actually addressed link-local.
//
// The gateway's own loopback address is deliberately NOT blocked here: the product's own local
// admin page, and the test suite's fake devices, both sit on 127.0.0.1, so a driver-layer block
// would be as likely to refuse a real, intended setup as an attack. The admin page already has its
// own lockout (local-admin.ts), and Watchtower's API already needs a token a driver has no way to
// obtain, so loopback is left to those.

const LINK_LOCAL_V4 = /^169\.254\./;

function isLinkLocalV6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h.startsWith('fe80:') || h.startsWith('fe8:') || h.startsWith('fe9:') || h.startsWith('fea:') || h.startsWith('feb:'))
    return true; // fe80::/10
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  return mapped ? isLinkLocal(mapped[1]!) : false;
}

/** True for a cloud metadata (link-local) address, by any spelling. */
export function isLinkLocal(host: string): boolean {
  const h = host.trim().toLowerCase();
  const kind = isIP(h.replace(/^\[|\]$/g, ''));
  if (kind === 4) return LINK_LOCAL_V4.test(h);
  if (kind === 6) return isLinkLocalV6(h);
  return false;
}

/** Reads a device's `allowLocalAddress` escape hatch, so the rare deliberate case still works. */
export function localAddressAllowed(settings: Record<string, unknown>): boolean {
  return settings.allowLocalAddress === true;
}

/**
 * Throws unless `host` is fine to connect to: not a cloud metadata address, or the device's
 * settings say to allow it anyway. Call this once, right where a connection or request is about
 * to be made, using the same `host` value that is used to make it.
 */
export function assertDeviceAddress(host: string, settings: Record<string, unknown>): void {
  if (host && isLinkLocal(host) && !localAddressAllowed(settings))
    throw new Error(
      `${host} is a cloud metadata address, not a device. If this is deliberate, add "allowLocalAddress": true to the device's settings.`,
    );
}
