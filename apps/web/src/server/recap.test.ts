import { describe, expect, it } from 'vitest';
import {
  RECAP_GAP_MS,
  RECAP_MAX_LOOKBACK_MS,
  describeChange,
  incidentKpis,
  isChange,
  recapSince,
  type RecapIncidentRow,
} from './recap';

const NOW = new Date(Date.UTC(2026, 9, 3, 10, 0));
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('recapSince', () => {
  it('gives no recap on a first visit', () => {
    expect(recapSince(null, NOW)).toBeNull();
  });
  it('gives none while the session continues', () => {
    expect(recapSince(ago(RECAP_GAP_MS - 1), NOW)).toBeNull();
  });
  it('starts at the last visit after a gap', () => {
    const last = ago(RECAP_GAP_MS);
    expect(recapSince(last, NOW)).toEqual(last);
  });
  it('never looks back past the cap', () => {
    expect(recapSince(ago(RECAP_MAX_LOOKBACK_MS * 3), NOW)).toEqual(ago(RECAP_MAX_LOOKBACK_MS));
  });
});

describe('changes', () => {
  it('keeps estate changes and drops noise', () => {
    expect(isChange('room.update')).toBe(true);
    expect(isChange('config.deploy')).toBe(true);
    expect(isChange('org.view')).toBe(false);
    expect(isChange('command.result')).toBe(false);
  });
  it('words an action', () => {
    expect(describeChange('room.update')).toBe('Room updated');
    expect(describeChange('ticket_rule.create')).toBe('Ticket rule created');
    expect(describeChange('room.shape_save')).toBe('Room shape save');
  });
});

describe('incidentKpis', () => {
  const row = (id: string, extra: Partial<RecapIncidentRow> = {}): RecapIncidentRow => ({
    id,
    title: id,
    severity: 'warning',
    roomId: null,
    roomIds: [],
    openedAt: ago(60 * 60_000),
    resolvedAt: null,
    meetingsAffected: 0,
    ...extra,
  });
  it('is zero and has no mean when nothing happened', () => {
    expect(incidentKpis([], 0, { total: 0, critical: 0 })).toEqual({
      opened: 0,
      resolved: 0,
      stillOpen: 0,
      critical: 0,
      meanMinutesToResolve: null,
      roomsAffected: 0,
      meetingsAffected: 0,
    });
  });
  it('averages time to fix over resolved ones and counts distinct rooms and meetings', () => {
    const k = incidentKpis(
      [
        row('a', { roomId: 'r1', resolvedAt: ago(30 * 60_000), meetingsAffected: 2 }),
        row('b', { roomId: 'r1', roomIds: ['r2'], resolvedAt: ago(0), meetingsAffected: 1 }),
        row('c', { roomId: 'r3' }),
      ],
      2,
      { total: 1, critical: 1 },
    );
    expect(k.meanMinutesToResolve).toBe(45);
    expect(k.roomsAffected).toBe(3);
    expect(k.meetingsAffected).toBe(3);
    expect(k.resolved).toBe(2);
    expect(k.stillOpen).toBe(1);
  });
});
