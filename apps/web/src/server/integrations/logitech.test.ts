import { describe, expect, it } from 'vitest';
import { logitech, LogitechCredentials, normalisePlace } from './logitech';
import type { ProviderDeps } from './types';

const PEM_CERT = `-----BEGIN CERTIFICATE-----\n${'A'.repeat(120)}\n-----END CERTIFICATE-----`;
const PEM_KEY = `-----BEGIN PRIVATE KEY-----\n${'B'.repeat(120)}\n-----END PRIVATE KEY-----`;
const creds = { orgId: 'org-1', certificate: PEM_CERT, privateKey: PEM_KEY };

const place = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  type: 'room',
  name: 'Huddle 4',
  occupancy: 3,
  devices: [
    {
      id: 'd1',
      type: 'RallyBar',
      name: 'Huddle 4 Rally Bar',
      status: 'online',
      healthStatus: 'healthy',
      version: '1.2.3',
      serial: 'SN1',
    },
    { id: 'd2', type: 'Camera', name: 'Ceiling cam', status: 'offline' },
  ],
  ...over,
});

function deps(pages: unknown[]) {
  const urls: string[] = [];
  let i = 0;
  const d: ProviderDeps = {
    fetch: (async () => new Response('no', { status: 500 })) as typeof fetch,
    mtlsGet: async (url, cert) => {
      urls.push(url);
      expect(cert).toEqual({ cert: PEM_CERT, key: PEM_KEY });
      return Response.json(pages[i++] ?? { places: [] });
    },
    now: () => 0,
  };
  return { d, urls };
}

describe('normalisePlace', () => {
  it('maps devices with the room, occupancy and identity', () => {
    const [rally, cam] = normalisePlace(place());
    expect(rally).toMatchObject({
      externalId: 'd1',
      roomName: 'Huddle 4',
      category: 'conference_system',
      make: 'Logitech',
      serial: 'SN1',
      firmware: '1.2.3',
      online: true,
      feedback: { occupied: true },
      issues: [],
    });
    expect(cam).toMatchObject({ category: 'conf_camera', online: false });
  });
  it('flags an unhealthy device that is online, but not an offline one', () => {
    const out = normalisePlace(
      place({
        devices: [
          { id: 'a', name: 'A', status: 'online', healthStatus: 'degraded' },
          { id: 'b', name: 'B', status: 'offline', healthStatus: 'degraded' },
        ],
      }),
    );
    expect(out[0]!.issues).toEqual(['A reports its health as degraded']);
    expect(out[1]!.issues).toEqual([]);
  });
  it('says unknown for a status it does not recognise, and skips empty occupancy', () => {
    const [d] = normalisePlace(
      place({ occupancy: undefined, devices: [{ id: 'a', name: 'A', status: 'mystery' }] }),
    );
    expect(d!.online).toBeNull();
    expect(d!.feedback).toBeUndefined();
  });
  it('skips junk', () => {
    expect(normalisePlace(null)).toEqual([]);
    expect(normalisePlace({ name: 'x', devices: [{ name: 'no id' }] })).toEqual([]);
  });
});

describe('logitech provider', () => {
  it('follows the continuation token and asks for rooms with devices', async () => {
    const { d, urls } = deps([
      { places: [place()], continuation: 'next1' },
      { places: [place({ id: 'p2', devices: [{ id: 'd9', name: 'Z', status: 'online' }] })] },
    ]);
    const out = await logitech.list(LogitechCredentials.parse(creds), d);
    expect(out.map((x) => x.externalId)).toEqual(['d1', 'd2', 'd9']);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/org/org-1/place?');
    expect(urls[0]).toContain('rooms=true');
    expect(urls[1]).toContain('continuation=next1');
  });
  it('explains a refused certificate', async () => {
    const d: ProviderDeps = {
      fetch: (async () => new Response('')) as typeof fetch,
      mtlsGet: async () => new Response('no', { status: 403 }),
      now: () => 0,
    };
    await expect(logitech.test(LogitechCredentials.parse(creds), d)).rejects.toThrow(
      /refused the credentials/,
    );
  });
});

describe('LogitechCredentials', () => {
  it('only accepts https Logitech addresses for the API base', () => {
    expect(
      LogitechCredentials.safeParse({ ...creds, apiBase: 'https://api.eu.sync.logitech.com/v1' })
        .success,
    ).toBe(true);
    for (const bad of [
      'http://api.sync.logitech.com',
      'https://evil.example.com/v1',
      'https://logitech.com.evil.io',
      'nonsense',
    ])
      expect(LogitechCredentials.safeParse({ ...creds, apiBase: bad }).success).toBe(false);
  });
  it('rejects a certificate or key that is not PEM', () => {
    expect(LogitechCredentials.safeParse({ ...creds, certificate: 'x'.repeat(200) }).success).toBe(
      false,
    );
    expect(LogitechCredentials.safeParse({ ...creds, privateKey: 'x'.repeat(200) }).success).toBe(
      false,
    );
  });
});
