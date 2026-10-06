import { beforeEach, describe, expect, it } from 'vitest';
import { clearWebexTokens, normaliseDevice, webex, WebexCredentials } from './webex';
import type { ProviderDeps } from './types';

const creds = WebexCredentials.parse({
  clientId: 'cid',
  clientSecret: 'sec',
  refreshToken: 'refresh-token-1',
});

beforeEach(clearWebexTokens);

function world(opts: { rotate?: boolean; tokenStatus?: number } = {}) {
  const calls: { url: string; body?: string }[] = [];
  const saved: Record<string, unknown>[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? String(init.body) : undefined });
    if (u.endsWith('/access_token'))
      return Response.json(
        {
          access_token: 'acc',
          expires_in: 1209599,
          ...(opts.rotate ? { refresh_token: 'refresh-token-2' } : {}),
        },
        { status: opts.tokenStatus ?? 200 },
      );
    if (u.includes('/workspaces'))
      return Response.json({ items: [{ id: 'w1', displayName: 'Level 3 Boardroom' }] });
    if (u.includes('/devices') && !u.includes('page=2'))
      return Response.json(
        {
          items: [
            {
              id: 'd1',
              displayName: 'Board Pro',
              workspaceId: 'w1',
              product: 'Cisco Room Kit Pro',
              connectionStatus: 'connected',
              software: 'RoomOS 11',
              serial: 'FOC1',
              mac: 'AA:BB',
              ip: '10.1.1.1',
            },
          ],
        },
        { headers: { link: '<https://webexapis.com/v1/devices?max=1000&page=2>; rel="next"' } },
      );
    if (u.includes('page=2'))
      return Response.json({
        items: [{ id: 'd2', displayName: 'Desk', connectionStatus: 'disconnected' }],
      });
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  const deps: ProviderDeps = {
    fetch: f,
    mtlsGet: async () => {
      throw new Error('no mtls');
    },
    now: () => 0,
    updateCredentials: async (c) => void saved.push(c),
  };
  return { deps, calls, saved };
}

describe('normaliseDevice', () => {
  const ws = new Map([['w1', 'Boardroom']]);
  it('maps connected, with the workspace as the room', () => {
    expect(
      normaliseDevice(
        {
          id: 'd',
          displayName: 'Bar',
          workspaceId: 'w1',
          connectionStatus: 'connected',
          software: 'RoomOS 11',
          serial: 'S',
        },
        ws,
      ),
    ).toMatchObject({
      online: true,
      roomName: 'Boardroom',
      make: 'Cisco',
      firmware: 'RoomOS 11',
      serial: 'S',
      issues: [],
    });
  });
  it('treats disconnected and offline states as offline with no fault', () => {
    for (const s of ['disconnected', 'offline_expired', 'offline_deep_sleep'])
      expect(
        normaliseDevice({ id: 'd', displayName: 'x', connectionStatus: s, errorCodes: ['e'] }, ws),
      ).toMatchObject({ online: false, issues: [] });
  });
  it('keeps error codes and flags connected_with_issues', () => {
    expect(
      normaliseDevice(
        { id: 'd', displayName: 'x', connectionStatus: 'connected', errorCodes: ['camera.lost'] },
        ws,
      )?.issues,
    ).toEqual(['camera.lost']);
    expect(
      normaliseDevice({ id: 'd', displayName: 'x', connectionStatus: 'connected_with_issues' }, ws)
        ?.issues,
    ).toHaveLength(1);
  });
  it('is unknown for a status it does not know, and drops junk', () => {
    expect(
      normaliseDevice({ id: 'd', displayName: 'x', connectionStatus: 'weird' }, ws)?.online,
    ).toBeNull();
    expect(normaliseDevice({ displayName: 'x' }, ws)).toBeNull();
  });
});

describe('webex provider', () => {
  it('signs in with the refresh token, follows Link pages, and names rooms from workspaces', async () => {
    const w = world();
    const out = await webex.list(creds, w.deps);
    expect(out.map((d) => d.externalId)).toEqual(['d1', 'd2']);
    expect(out[0]!.roomName).toBe('Level 3 Boardroom');
    const form = new URLSearchParams(w.calls[0]!.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('refresh-token-1');
    expect(w.saved).toHaveLength(0);
  });
  it('hands back a rotated refresh token to be saved', async () => {
    const w = world({ rotate: true });
    await webex.list(creds, w.deps);
    expect(w.saved).toEqual([{ ...creds, refreshToken: 'refresh-token-2' }]);
  });
  it('explains a refused sign-in', async () => {
    const w = world({ tokenStatus: 401 });
    await expect(webex.test(creds, w.deps)).rejects.toThrow(/refused the credentials/);
  });
});
