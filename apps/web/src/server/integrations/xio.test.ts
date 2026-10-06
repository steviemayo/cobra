import { describe, expect, it } from 'vitest';
import { normaliseDevice, xio, XioCredentials } from './xio';
import type { ProviderDeps } from './types';

const creds = XioCredentials.parse({ accountId: 'acct-1', subscriptionKey: '9838a7e6a8df4ff3' });
const dev = (over: Record<string, unknown> = {}) => ({
  'device-cid': 'cid-1',
  'device-name': 'TSW-770',
  'user-device-name': 'Boardroom panel',
  'device-model': 'TSW-770',
  'device-category': 'Touch Screen',
  'device-manufacturer': 'Crestron',
  'device-status': 'Online',
  ipAddress: '10.0.0.9',
  'serial-number': '1234',
  ...over,
});

const deps = (res: Response, seen: { url?: string; headers?: HeadersInit } = {}): ProviderDeps => ({
  fetch: (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.headers = init?.headers;
    return res;
  }) as typeof fetch,
  mtlsGet: async () => {
    throw new Error('no mtls');
  },
  now: () => 0,
});

describe('normaliseDevice', () => {
  it('maps a device with its status and identity', () => {
    expect(normaliseDevice(dev())).toMatchObject({
      externalId: 'cid-1',
      name: 'Boardroom panel',
      category: 'touch_panel',
      make: 'Crestron',
      model: 'TSW-770',
      serial: '1234',
      ip: '10.0.0.9',
      online: true,
    });
  });
  it('reads Offline as offline, and an odd status as unknown', () => {
    expect(normaliseDevice(dev({ 'device-status': 'Offline' }))?.online).toBe(false);
    expect(normaliseDevice(dev({ 'device-status': 'Rebooting' }))?.online).toBeNull();
  });
  it('unwraps a nested device and falls back to a control processor', () => {
    expect(
      normaliseDevice({ device: dev({ 'device-model': 'CP4-R', 'device-category': 'Processor' }) })
        ?.category,
    ).toBe('control_processor');
  });
  it('drops junk', () => {
    expect(normaliseDevice({ 'device-name': 'no id' })).toBeNull();
    expect(normaliseDevice(null)).toBeNull();
  });
});

describe('xio provider', () => {
  it('reads the account list with the subscription key header', async () => {
    const seen: { url?: string; headers?: HeadersInit } = {};
    const out = await xio.list(
      creds,
      deps(Response.json({ devices: [dev(), dev({ 'device-cid': 'cid-2' })] }), seen),
    );
    expect(out).toHaveLength(2);
    expect(seen.url).toBe('https://api.crestron.io/api/v1/device/accountid/acct-1/devices');
    expect(seen.headers).toMatchObject({ 'XiO-subscription-key': '9838a7e6a8df4ff3' });
  });
  it('accepts a bare array', async () => {
    expect(await xio.list(creds, deps(Response.json([dev()])))).toHaveLength(1);
  });
  it('rejects an unexpected shape and explains a refused key', async () => {
    await expect(xio.list(creds, deps(Response.json({ nope: 1 })))).rejects.toThrow(
      /did not expect/,
    );
    await expect(xio.test(creds, deps(new Response('x', { status: 403 })))).rejects.toThrow(
      /refused the credentials/,
    );
  });
  it('is read no more often than Crestron allows', () => {
    expect(xio.intervalMs).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
