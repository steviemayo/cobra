import { describe, expect, it } from 'vitest';
import { RoomModel, STARTER_TEMPLATES, type RoomGroupSpec } from '@kestrel/model';
import {
  combinedKey,
  enumerateCombinedRooms,
  liveCombinations,
  validateGroupSpec,
} from './combinations';
import { deriveCombinedModel, memberKey } from './derive';
import { validateRoomModel } from '../validate/validate';

const div = (id: string, ...roomIds: string[]) => ({ id, name: id, roomIds });
const keys = (spec: RoomGroupSpec) => enumerateCombinedRooms(spec).sets.map((s) => s.key);

describe('which combined rooms are possible', () => {
  it('two rooms with one wall make one combined room', () => {
    expect(keys({ roomIds: ['a', 'b'], dividers: [div('w1', 'a', 'b')] })).toEqual(['a+b']);
  });

  it('a line of three: two pairs and the whole', () => {
    const spec = {
      roomIds: ['a', 'b', 'c'],
      dividers: [div('ab', 'a', 'b'), div('bc', 'b', 'c')],
    };
    expect(keys(spec)).toEqual(['a+b', 'b+c', 'a+b+c']);
  });

  it('a line of five is 10 combined rooms, not every subset', () => {
    const rooms = ['a', 'b', 'c', 'd', 'e'];
    const dividers = rooms.slice(1).map((r, i) => div(`w${i}`, rooms[i]!, r));
    expect(keys({ roomIds: rooms, dividers })).toHaveLength(10);
  });

  it('never joins rooms that no wall connects', () => {
    const spec = {
      roomIds: ['a', 'b', 'c', 'd'],
      dividers: [div('ab', 'a', 'b'), div('cd', 'c', 'd')],
    };
    expect(keys(spec)).toEqual(['a+b', 'c+d']);
  });

  it('handles a wall that opens a big room onto two rooms at once', () => {
    // A B C D in a line, and L that opens onto B and C together.
    const spec = {
      roomIds: ['a', 'b', 'c', 'd', 'l'],
      dividers: [
        div('ab', 'a', 'b'),
        div('bc', 'b', 'c'),
        div('cd', 'c', 'd'),
        div('lbc', 'l', 'b', 'c'),
      ],
    };
    const found = keys(spec);
    expect(found).toContain('b+c+l'); // L with both middle rooms, through the one wall
    expect(found).toContain('a+b+c+d+l'); // everything
    expect(found).not.toContain('b+l'); // L cannot open onto B alone: there is no wall for that
    expect(found).not.toContain('a+l');
  });

  it('a ring of rooms works and does not loop forever', () => {
    const spec = {
      roomIds: ['a', 'b', 'c'],
      dividers: [div('ab', 'a', 'b'), div('bc', 'b', 'c'), div('ca', 'c', 'a')],
    };
    expect(keys(spec)).toEqual(['a+b', 'a+c', 'b+c', 'a+b+c']);
  });

  it('stops at the cap and says so', () => {
    const rooms = Array.from({ length: 12 }, (_, i) => `r${i}`);
    const dividers = rooms.slice(1).map((r, i) => div(`w${i}`, rooms[i]!, r));
    const result = enumerateCombinedRooms({ roomIds: rooms, dividers }, 20);
    expect(result.truncated).toBe(true);
    expect(result.sets).toHaveLength(20);
  });

  it('is the same whatever order the rooms and walls are listed in', () => {
    const a = keys({
      roomIds: ['a', 'b', 'c'],
      dividers: [div('x', 'b', 'c'), div('y', 'a', 'b')],
    });
    const b = keys({
      roomIds: ['c', 'b', 'a'],
      dividers: [div('y', 'b', 'a'), div('x', 'c', 'b')],
    });
    expect(a).toEqual(b);
  });

  it('combinedKey ignores order', () => {
    expect(combinedKey(['b', 'a'])).toBe(combinedKey(['a', 'b']));
  });
});

describe('what is joined right now', () => {
  const spec = {
    roomIds: ['a', 'b', 'c', 'd'],
    dividers: [div('ab', 'a', 'b'), div('bc', 'b', 'c'), div('cd', 'c', 'd')],
  };

  it('nothing open: nothing combined', () => {
    expect(liveCombinations(spec, [])).toEqual([]);
  });

  it('one wall open joins two rooms', () => {
    expect(liveCombinations(spec, ['ab']).map((s) => s.key)).toEqual(['a+b']);
  });

  it('two walls apart make two separate combined rooms', () => {
    expect(liveCombinations(spec, ['ab', 'cd']).map((s) => s.key)).toEqual(['a+b', 'c+d']);
  });

  it('walls that touch make one bigger room', () => {
    expect(liveCombinations(spec, ['ab', 'bc']).map((s) => s.key)).toEqual(['a+b+c']);
  });

  it('every live combination is one of the enumerated ones', () => {
    const possible = new Set(keys(spec));
    for (const open of [['ab'], ['bc', 'cd'], ['ab', 'bc', 'cd'], ['ab', 'cd']])
      for (const live of liveCombinations(spec, open)) expect(possible.has(live.key)).toBe(true);
  });
});

describe('checking a layout', () => {
  it('accepts a sensible one', () => {
    expect(validateGroupSpec({ roomIds: ['a', 'b'], dividers: [div('w', 'a', 'b')] })).toEqual([]);
  });

  it('flags a wall that touches a room outside the group, twice-listed rooms and repeats', () => {
    const problems = validateGroupSpec({
      roomIds: ['a', 'b', 'c'],
      dividers: [
        div('w1', 'a', 'x'),
        div('w2', 'a', 'a', 'b'),
        div('w1', 'b', 'c'),
        div('w3', 'b', 'c'),
      ],
    });
    expect(problems.join('\n')).toMatch(/not in this group/);
    expect(problems.join('\n')).toMatch(/more than once/);
    expect(problems.join('\n')).toMatch(/name is used twice/);
    expect(problems.join('\n')).toMatch(/already joins the same rooms/);
  });

  it('flags a room no wall touches', () => {
    const problems = validateGroupSpec({
      roomIds: ['a', 'b', 'c'],
      dividers: [div('w', 'a', 'b')],
    });
    expect(problems.join('\n')).toMatch(/no divider/);
  });
});

describe('the starting program for a combined room', () => {
  const meeting = () => structuredClone(STARTER_TEMPLATES[0]!.model);
  const members = [
    { key: 'r1', name: 'Room 1', model: meeting() },
    { key: 'r2', name: 'Room 2', model: meeting() },
  ];
  const model = deriveCombinedModel(members);

  it('is a valid room model with both rooms devices side by side', () => {
    expect(() => RoomModel.parse(model)).not.toThrow();
    expect(model.devices).toHaveLength(members[0]!.model.devices.length * 2);
    expect(model.devices.every((d) => /^r[12]__/.test(d.id))).toBe(true);
    expect(model.devices[0]!.name.startsWith('Room 1: ')).toBe(true);
  });

  it('has no duplicate ids anywhere', () => {
    const ids = [
      ...model.devices.map((d) => d.id),
      ...model.connections.map((c) => c.id),
      ...model.groups.map((g) => g.id),
      ...model.states.map((s) => s.id),
      ...model.activities.map((a) => a.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has one Present with both rooms laptops, aimed at all the displays', () => {
    const present = model.activities.filter((a) => a.kind === 'present');
    expect(present).toHaveLength(1);
    expect(present[0]!.sources.map((s) => s.label)).toEqual([
      'Room 1: Laptop 1',
      'Room 1: Laptop 2',
      'Room 2: Laptop 1',
      'Room 2: Laptop 2',
    ]);
    const all = model.groups.find((g) => g.id === 'all_displays')!;
    expect(present[0]!.targetGroupId).toBe('all_displays');
    expect(all.members).toHaveLength(4);
  });

  it('runs every rooms On and Off states', () => {
    const present = model.activities.find((a) => a.kind === 'present')!;
    expect(present.actions.map((a) => a.type === 'run_state' && a.stateId).sort()).toEqual([
      'r1__on',
      'r2__on',
    ]);
    const off = model.activities.find((a) => a.kind === 'room_off')!;
    expect(off.actions).toHaveLength(2);
  });

  it('points every action at devices and states that exist', () => {
    const deviceIds = new Set(model.devices.map((d) => d.id));
    const stateIds = new Set(model.states.map((s) => s.id));
    for (const s of model.states)
      for (const a of s.actions) {
        if ('deviceId' in a) expect(deviceIds.has(a.deviceId)).toBe(true);
        if (a.type === 'run_state') expect(stateIds.has(a.stateId)).toBe(true);
      }
    for (const a of model.activities.flatMap((x) => x.actions))
      if (a.type === 'run_state') expect(stateIds.has(a.stateId)).toBe(true);
  });

  it('does not copy triggers, and reports nothing structurally broken', () => {
    expect(model.triggers).toEqual([]);
    const errors = validateRoomModel(model).issues.filter((i) => i.severity === 'error');
    // Whatever is left is about wiring between rooms, which only the dev can add.
    for (const e of errors) expect(e.code).not.toMatch(/unknown|missing_device|dangling/i);
  });

  it('needs at least two rooms, and distinct keys', () => {
    expect(() => deriveCombinedModel([members[0]!])).toThrow(/at least two/);
    expect(() => deriveCombinedModel([members[0]!, { ...members[1]!, key: 'r1' }])).toThrow(
      /share the key/,
    );
  });

  it('makes safe short keys from room names', () => {
    expect(memberKey('Room 101')).toBe('room_101');
    expect(memberKey('Boardroom — North!')).toBe('boardroom_no');
    expect(memberKey('', new Set(['room']))).toBe('room2');
    expect(memberKey('Room 101', new Set(['room_101']))).toBe('room_1012');
  });

  it('works with the recorded training room too (a camera and a recorder)', () => {
    const training = () =>
      structuredClone(STARTER_TEMPLATES.find((t) => t.id === 'training-recorded')!.model);
    const mixed = deriveCombinedModel([
      { key: 'meet', name: 'Meeting', model: meeting() },
      { key: 'train', name: 'Training', model: training() },
    ]);
    expect(() => RoomModel.parse(mixed)).not.toThrow();
    expect(mixed.activities.some((a) => a.kind === 'record')).toBe(true);
  });
});
