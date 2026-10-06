import { describe, expect, it } from 'vitest';
import { incidentMuted, isMutedNow, mutedBy, setMute, type MuteDb } from './alert-mute';

const NOW = new Date('2026-10-07T00:00:00Z');
const later = new Date('2026-10-08T00:00:00Z');
const earlier = new Date('2026-10-06T00:00:00Z');
const on = { alertsMuted: true, alertsMutedUntil: null };
const off = { alertsMuted: false, alertsMutedUntil: null };

describe('isMutedNow', () => {
  it('is muted until switched off, or until its end time', () => {
    expect(isMutedNow(on, NOW)).toBe(true);
    expect(isMutedNow({ alertsMuted: true, alertsMutedUntil: later }, NOW)).toBe(true);
    expect(isMutedNow({ alertsMuted: true, alertsMutedUntil: earlier }, NOW)).toBe(false);
    expect(isMutedNow(off, NOW)).toBe(false);
    expect(isMutedNow(null, NOW)).toBe(false);
  });
});

describe('mutedBy', () => {
  it('names the nearest mute', () => {
    expect(mutedBy({ room: on, site: on, org: on }, NOW)).toBe('room');
    expect(mutedBy({ room: off, site: on, org: on }, NOW)).toBe('site');
    expect(mutedBy({ room: off, site: off, org: on }, NOW)).toBe('org');
    expect(mutedBy({ room: off, site: off, org: off }, NOW)).toBeNull();
  });
});

const ORG = 'o1';
function fakeDb(rows: {
  org?: typeof on;
  rooms?: Record<string, typeof on & { siteId: string }>;
  sites?: Record<string, typeof on>;
  gateways?: Record<string, { siteId: string }>;
}): MuteDb {
  const list = <T extends object>(m: Record<string, T> | undefined) =>
    Object.entries(m ?? {}).map(([id, v]) => ({ id, ...v }));
  return {
    org: { findFirst: async () => (rows.org ? { id: ORG, ...rows.org } : null) },
    room: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        list(rows.rooms).filter((r) => where.id.in.includes(r.id)),
    },
    site: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        list(rows.sites).filter((s) => where.id.in.includes(s.id)),
      findFirst: async ({ where }: { where: { id: string } }) =>
        list(rows.sites).find((s) => s.id === where.id) ?? null,
    },
    gateway: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        list(rows.gateways).find((g) => g.id === where.id) ?? null,
    },
  } as unknown as MuteDb;
}

describe('incidentMuted', () => {
  const inc = (roomIds: string[], gatewayId: string | null = null) => ({
    orgId: ORG,
    roomId: roomIds[0] ?? null,
    roomIds,
    gatewayId,
  });

  it('is muted by the room, its site or the organisation', async () => {
    const rooms = { r1: { ...off, siteId: 's1' } };
    expect(await incidentMuted(fakeDb({ rooms, sites: { s1: off } }), inc(['r1']), NOW)).toBe(false);
    expect(
      await incidentMuted(fakeDb({ rooms: { r1: { ...on, siteId: 's1' } }, sites: { s1: off } }), inc(['r1']), NOW),
    ).toBe(true);
    expect(await incidentMuted(fakeDb({ rooms, sites: { s1: on } }), inc(['r1']), NOW)).toBe(true);
    expect(await incidentMuted(fakeDb({ org: on, rooms, sites: { s1: off } }), inc(['r1']), NOW)).toBe(true);
  });

  it('for a shared device is muted only when every affected room is', async () => {
    const rooms = { r1: { ...on, siteId: 's1' }, r2: { ...off, siteId: 's1' } };
    expect(await incidentMuted(fakeDb({ rooms, sites: { s1: off } }), inc(['r1', 'r2']), NOW)).toBe(false);
    rooms.r2 = { ...on, siteId: 's1' };
    expect(await incidentMuted(fakeDb({ rooms, sites: { s1: off } }), inc(['r1', 'r2']), NOW)).toBe(true);
  });

  it('for a gateway problem with no room is muted by the gateway’s site', async () => {
    const db = fakeDb({ sites: { s1: on }, gateways: { g1: { siteId: 's1' } } });
    expect(await incidentMuted(db, inc([], 'g1'), NOW)).toBe(true);
    expect(await incidentMuted(fakeDb({ sites: { s1: off }, gateways: { g1: { siteId: 's1' } } }), inc([], 'g1'), NOW)).toBe(false);
  });

  it('treats a database without the tables as nothing muted', async () => {
    expect(await incidentMuted({}, inc(['r1']), NOW)).toBe(false);
  });
});

describe('setMute', () => {
  it('refuses an end time in the past', async () => {
    const res = await setMute(
      fakeDb({}),
      { orgId: ORG, scope: 'org', muted: true, until: earlier },
      NOW,
    );
    expect(res.ok).toBe(false);
  });
});
