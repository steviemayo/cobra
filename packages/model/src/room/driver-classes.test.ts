import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_DRIVERS,
  DEVICE_CATALOG,
  DRIVER_CLASSES,
  DriverClass,
  LEGACY_CATEGORIES,
  RoomModel,
  STARTER_TEMPLATES,
  checkDriverSpec,
  classProblems,
  classesForCategory,
  isVideoDestination,
  settingScope,
} from '../index';

describe('driver classes', () => {
  it('every class has a label and at least one feature, and every category it names exists', () => {
    for (const c of DriverClass.options) {
      const info = DRIVER_CLASSES[c];
      expect(info.label, c).not.toBe('');
      expect(Object.keys(info.features).length, c).toBeGreaterThan(0);
      for (const cat of info.categories) expect(DEVICE_CATALOG[cat], `${c}: ${cat}`).toBeDefined();
    }
  });

  it('projectors and displays are separate classes; the older category reads as either', () => {
    expect(classesForCategory('projector')).toEqual(['projector']);
    expect(classesForCategory('display')).toEqual(['display']);
    expect(classesForCategory('video_destination').sort()).toEqual(['display', 'projector']);
    expect(DRIVER_CLASSES.display.features).toHaveProperty('remote_keys');
    expect(DRIVER_CLASSES.projector.features).not.toHaveProperty('remote_keys');
  });

  it('the two microphone kinds are separate classes', () => {
    expect(classesForCategory('reinforcement_mic')).toEqual(['reinforcement_mic']);
    expect(classesForCategory('voice_capture_mic')).toEqual(['conferencing_mic']);
    expect(DRIVER_CLASSES.reinforcement_mic.features).toHaveProperty('volume');
    expect(DRIVER_CLASSES.conferencing_mic.features).toHaveProperty('privacy_mute');
    expect(DRIVER_CLASSES.conferencing_mic.features).not.toHaveProperty('volume');
  });

  it('checks declared features against the class', () => {
    expect(classProblems('display', ['apps', 'remote_keys'])).toEqual([]);
    expect(classProblems('display', undefined)).toEqual([]);
    expect(classProblems('projector', ['apps'])[0]).toContain('not a feature of the Projector class');
    expect(classProblems(undefined, ['apps'])[0]).toContain('names its class');
  });
});

describe('display and projector categories', () => {
  it('all three video destination categories are treated as a display', () => {
    for (const c of ['video_destination', 'display', 'projector'] as const) expect(isVideoDestination(c)).toBe(true);
    expect(isVideoDestination('video_matrix')).toBe(false);
  });

  it('a room saved with the older category still loads', () => {
    const m = RoomModel.parse({
      roomType: 'meeting',
      devices: [{ id: 'd1', name: 'Screen', category: 'video_destination' }],
    });
    expect(m.devices[0]!.category).toBe('video_destination');
    expect(LEGACY_CATEGORIES).toContain('video_destination');
  });

  it('starter templates use display, not the older category', () => {
    for (const t of STARTER_TEMPLATES)
      expect(t.model.devices.some((d) => d.category === 'video_destination'), t.name).toBe(false);
  });
});

describe('setting scope', () => {
  it('uses the declared scope first', () => {
    expect(settingScope('host', { scope: 'design' })).toBe('design');
  });
  it('secrets by type or well-known name', () => {
    expect(settingScope('anything', { type: 'secret' })).toBe('secret');
    expect(settingScope('password')).toBe('secret');
    expect(settingScope('credentials')).toBe('secret');
  });
  it('addresses are bindings and everything else is design', () => {
    expect(settingScope('host')).toBe('binding');
    expect(settingScope('port')).toBe('binding');
    expect(settingScope('gainComponent')).toBe('design');
  });
});

describe('built-in driver info', () => {
  it('each driver names a class its categories belong to, with features from that class', () => {
    for (const [id, info] of Object.entries(BUILT_IN_DRIVERS)) {
      const cls = DRIVER_CLASSES[info.class];
      expect(
        info.categories.some((c) => cls.categories.includes(c)),
        `${id}: no category in class ${info.class}`,
      ).toBe(true);
      for (const f of info.features) expect(cls.features, `${id}: ${f}`).toHaveProperty(f);
      expect(new Set(info.settings.map((s) => s.key)).size, id).toBe(info.settings.length);
    }
  });

  it('every setting in the example has a described setting', () => {
    for (const [id, info] of Object.entries(BUILT_IN_DRIVERS)) {
      const keys = new Set(info.settings.map((s) => s.key));
      for (const k of Object.keys(info.example)) expect(keys.has(k), `${id}: ${k}`).toBe(true);
    }
  });
});

describe('driver specs with a class', () => {
  const base = {
    id: 'my-display',
    name: 'My display',
    transport: { type: 'tcp', port: 1515 },
    commands: { 'power.on': { send: 'PWR ON' } },
  };
  const displayCommands = {
    'power.on': { send: 'PWR ON' },
    'power.off': { send: 'PWR OFF' },
    select_input: { send: 'SRC {inputNumber}' },
    'blank.on': { send: 'BLK ON' },
    'blank.off': { send: 'BLK OFF' },
  };
  it('accepts a class and its features, and a scope on a setting', () => {
    const r = checkDriverSpec({
      ...base,
      commands: displayCommands,
      class: 'display',
      features: ['blank'],
      settings: [{ key: 'pin', label: 'PIN', type: 'string', scope: 'secret' }],
    });
    expect(r.ok).toBe(true);
  });
  it('holds a driver to the contract of its class: the commands the class needs, and the ones each feature needs', () => {
    const missingClass = checkDriverSpec({ ...base, class: 'display' });
    expect(!missingClass.ok && missingClass.problems).toEqual([
      'A Display driver needs the command “power.off”',
      'A Display driver needs the command “select_input”',
    ]);
    const { 'blank.off': _off, ...noOff } = displayCommands;
    void _off;
    const missingFeature = checkDriverSpec({ ...base, commands: noOff, class: 'display', features: ['blank', 'apps'] });
    expect(!missingFeature.ok && missingFeature.problems).toEqual([
      'The Display feature “blank” needs the command “blank.off”',
      'The Display feature “apps” needs the command “app.launch”',
    ]);
  });
  it('leaves a class with no contract, and a driver with no class, alone', () => {
    expect(checkDriverSpec({ ...base, class: 'sensor' }).ok).toBe(true);
    expect(checkDriverSpec(base).ok).toBe(true);
  });
  it('rejects a feature the class does not have', () => {
    const r = checkDriverSpec({ ...base, class: 'projector', features: ['apps'] });
    expect(r.ok).toBe(false);
  });
  it('rejects features without a class, and an unknown class', () => {
    expect(checkDriverSpec({ ...base, features: ['blank'] }).ok).toBe(false);
    expect(checkDriverSpec({ ...base, class: 'toaster' }).ok).toBe(false);
  });
  it('leaves a driver without a class exactly as it was', () => {
    const r = checkDriverSpec(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('class' in r.spec).toBe(false);
      expect('features' in r.spec).toBe(false);
    }
  });
});
