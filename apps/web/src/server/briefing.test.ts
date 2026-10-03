import { describe, expect, it } from 'vitest';
import {
  HITLIST_SIZE,
  formatBriefing,
  summariseBriefing,
  type BriefingIncident,
  type BriefingTicket,
} from './briefing';
import { briefingChannelOk } from './briefing-delivery';

const NOW = new Date(Date.UTC(2026, 9, 3, 20, 0));
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const rooms = [
  { id: 'r1', name: 'Boardroom' },
  { id: 'r2', name: 'Lobby' },
];
const inc = (id: string, extra: Partial<BriefingIncident> = {}): BriefingIncident => ({
  id,
  title: `${id} offline`,
  severity: 'warning',
  roomId: 'r2',
  openedAt: ago(1),
  acknowledgedAt: ago(0),
  occurrences: 1,
  meetingsAffected: 0,
  ...extra,
});
const tick = (id: string, extra: Partial<BriefingTicket> = {}): BriefingTicket => ({
  id,
  title: `${id} ticket`,
  priority: 'normal',
  roomId: null,
  createdAt: ago(1),
  escalatedAt: null,
  assignedTo: 'u1',
  staffAssignee: null,
  ...extra,
});

describe('briefing', () => {
  it('says all quiet when nothing is open', () => {
    const b = summariseBriefing('Acme', { rooms, incidents: [], tickets: [] }, NOW);
    expect(b.hitlist).toEqual([]);
    expect(formatBriefing(b).title).toBe('Daily briefing, Acme: all quiet');
  });

  it('counts status figures', () => {
    const b = summariseBriefing(
      'Acme',
      {
        rooms,
        incidents: [
          inc('a', {
            severity: 'critical',
            roomId: 'r1',
            meetingsAffected: 2,
            acknowledgedAt: null,
          }),
          inc('b'),
        ],
        tickets: [tick('t1', { priority: 'urgent', assignedTo: null }), tick('t2')],
      },
      NOW,
    );
    expect(b.status).toMatchObject({
      rooms: 2,
      roomsWithTrouble: 2,
      openIncidents: 2,
      critical: 1,
      unacknowledged: 1,
      meetingsAffected: 2,
      openTickets: 2,
      urgentTickets: 1,
      unassignedTickets: 1,
    });
  });

  it('puts a critical incident hitting meetings above a routine ticket, with reasons', () => {
    const b = summariseBriefing(
      'Acme',
      {
        rooms,
        incidents: [inc('a', { severity: 'critical', roomId: 'r1', meetingsAffected: 3 })],
        tickets: [tick('t1')],
      },
      NOW,
    );
    expect(b.hitlist[0]).toMatchObject({ kind: 'incident', id: 'a', room: 'Boardroom' });
    expect(b.hitlist[0]!.why).toContain('3 meetings affected');
  });

  it('ranks an escalated, unassigned urgent ticket above a quiet warning', () => {
    const b = summariseBriefing(
      'Acme',
      {
        rooms,
        incidents: [inc('a')],
        tickets: [tick('t1', { priority: 'urgent', escalatedAt: ago(2), assignedTo: null })],
      },
      NOW,
    );
    expect(b.hitlist[0]!.id).toBe('t1');
    expect(b.hitlist[0]!.why).toEqual(expect.arrayContaining(['escalated', 'unassigned']));
  });

  it('keeps only the top few', () => {
    const many = Array.from({ length: 12 }, (_, i) => inc(`i${i}`));
    const b = summariseBriefing('Acme', { rooms, incidents: many, tickets: [] }, NOW);
    expect(b.hitlist).toHaveLength(HITLIST_SIZE);
    expect(formatBriefing(b).body).toContain('Focus on today:');
  });

  it('only offers channels that make sense for a briefing', () => {
    expect(['email', 'sms', 'teams', 'webhook'].every(briefingChannelOk)).toBe(true);
    expect(briefingChannelOk('itsm')).toBe(false);
  });
});
