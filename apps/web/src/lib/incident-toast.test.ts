import { describe, expect, it } from 'vitest';
import { MERGE_WINDOW_MS, addToGroup, describeGroup, type NewIncident } from './incident-toast';

const inc = (id: string, room: string | null, severity = 'warning'): NewIncident => ({
  id,
  severity,
  title: `${id} is offline`,
  roomName: room,
});

describe('incident toasts', () => {
  it('names a single incident and its room', () => {
    expect(describeGroup([inc('DSP', 'Boardroom')])).toEqual({
      title: 'DSP is offline',
      description: 'Boardroom',
      severity: 'warning',
    });
  });

  it('groups several by room, worst severity wins, and trims a long list', () => {
    const d = describeGroup([
      inc('a', 'Boardroom'),
      inc('b', 'Boardroom', 'critical'),
      inc('c', 'Lobby'),
      inc('d', 'Cafe'),
      inc('e', 'Gym'),
      inc('f', null),
    ]);
    expect(d.title).toBe('6 new incidents');
    expect(d.description).toBe('Boardroom (2), Lobby, Cafe and 2 more');
    expect(d.severity).toBe('critical');
  });

  it('adds to the open group inside the window, without repeats, and starts fresh after it', () => {
    const first = addToGroup(null, [inc('a', 'R')], 1000);
    const merged = addToGroup(first, [inc('a', 'R'), inc('b', 'R')], 1000 + MERGE_WINDOW_MS - 1);
    expect(merged.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(merged.startedAt).toBe(1000);
    const later = addToGroup(merged, [inc('c', 'R')], 1000 + MERGE_WINDOW_MS);
    expect(later.items.map((i) => i.id)).toEqual(['c']);
  });
});
