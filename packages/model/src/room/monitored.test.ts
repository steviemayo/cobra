import { describe, expect, it } from 'vitest';
import { RoomModel } from './room-model';
import { changesControlContent, controlContentIn } from './monitored';
import { newRoomModel, STARTER_TEMPLATES } from './templates';

describe('monitored rooms', () => {
  it('a blank room has no control side', () => {
    expect(controlContentIn(newRoomModel('meeting'))).toEqual([]);
  });

  it('a starter template has one', () => {
    expect(controlContentIn(STARTER_TEMPLATES[0]!.model).length).toBeGreaterThan(0);
  });

  it('adding a device is not a change to the control side, adding an activity is', () => {
    const before = newRoomModel('meeting');
    const withDevice = RoomModel.parse({
      ...before,
      devices: [{ id: 'dsp', name: 'DSP', category: 'audio_matrix' }],
    });
    expect(changesControlContent(before, withDevice)).toBe(false);
    const template = STARTER_TEMPLATES[0]!.model;
    expect(changesControlContent(before, template)).toBe(true);
    // Leaving what is already there alone is fine, so a lapsed Pro room can still add devices.
    expect(changesControlContent(template, { ...template, devices: [] })).toBe(false);
  });

  it('treats a missing draft as an empty one', () => {
    expect(changesControlContent(null, newRoomModel('meeting'))).toBe(false);
  });
});
