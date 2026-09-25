import { describe, expect, it } from 'vitest';
import { incidentVisible, inScope, roomIdsInScope, siteFilter, ticketVisible } from './site-scope';

const rooms = [
  { id: 'r1', siteId: 's1' },
  { id: 'r2', siteId: 's2' },
  { id: 'r3', siteId: 's3' },
];

describe('site scope', () => {
  it('null means the whole organisation', () => {
    expect(inScope(null, 'anything')).toBe(true);
    expect(siteFilter(null)).toEqual({});
    expect(roomIdsInScope(rooms, null).size).toBe(3);
  });

  it('a list means only those sites', () => {
    expect(inScope(['s1', 's2'], 's1')).toBe(true);
    expect(inScope(['s1', 's2'], 's3')).toBe(false);
    expect(siteFilter(['s1'])).toEqual({ siteId: { in: ['s1'] } });
    expect([...roomIdsInScope(rooms, ['s1', 's3'])]).toEqual(['r1', 'r3']);
  });

  it('an empty list sees nothing', () => {
    expect(inScope([], 's1')).toBe(false);
    expect(roomIdsInScope(rooms, []).size).toBe(0);
  });
});

describe('which tickets a site-limited provider sees', () => {
  const inRooms = new Set(['r1']);
  const t = (roomId: string | null, routedTo = 'org') => ({ roomId, routedTo });

  it('everything, with whole-organisation access', () => {
    expect(ticketVisible(t(null), null, inRooms, null)).toBe(true);
    expect(ticketVisible(t('r9'), null, inRooms, null)).toBe(true);
  });

  it('tickets about rooms at its sites', () => {
    expect(ticketVisible(t('r1'), ['s1'], inRooms, 'msp1')).toBe(true);
    expect(ticketVisible(t('r2'), ['s1'], inRooms, 'msp1')).toBe(false);
  });

  it('tickets sent to it, whatever the room, but not other providers’ or the organisation’s own', () => {
    expect(ticketVisible(t(null, 'msp:msp1'), ['s1'], inRooms, 'msp1')).toBe(true);
    expect(ticketVisible(t('r2', 'msp:msp1'), ['s1'], inRooms, 'msp1')).toBe(true);
    expect(ticketVisible(t(null, 'msp:other'), ['s1'], inRooms, 'msp1')).toBe(false);
    expect(ticketVisible(t(null, 'org'), ['s1'], inRooms, 'msp1')).toBe(false);
    expect(ticketVisible(t(null, 'kestrel'), ['s1'], inRooms, 'msp1')).toBe(false);
  });
});

describe('which incidents a site-limited provider sees', () => {
  const roomIds = new Set(['r1']);
  const gatewayIds = new Set(['g1']);
  const i = (roomId: string | null, gatewayId: string | null) => ({ roomId, gatewayId });

  it('room incidents by room, gateway incidents by gateway', () => {
    expect(incidentVisible(i('r1', 'g2'), ['s1'], roomIds, gatewayIds)).toBe(true);
    expect(incidentVisible(i('r2', 'g1'), ['s1'], roomIds, gatewayIds)).toBe(false); // the room decides
    expect(incidentVisible(i(null, 'g1'), ['s1'], roomIds, gatewayIds)).toBe(true);
    expect(incidentVisible(i(null, 'g2'), ['s1'], roomIds, gatewayIds)).toBe(false);
    expect(incidentVisible(i(null, null), ['s1'], roomIds, gatewayIds)).toBe(false);
    expect(incidentVisible(i('r9', null), null, roomIds, gatewayIds)).toBe(true);
  });
});
