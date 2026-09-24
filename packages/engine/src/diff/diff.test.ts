import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type RoomModel } from '@kestrel/model';
import { diffRoomModels, summariseChanges } from './diff';

const base = (): RoomModel => structuredClone(STARTER_TEMPLATES[0]!.model);
const changes = (mutate: (m: RoomModel) => void) => {
  const after = base();
  mutate(after);
  return diffRoomModels(base(), after);
};

describe('diffRoomModels', () => {
  it('finds nothing when nothing changed, and ignores key order', () => {
    expect(diffRoomModels(base(), base())).toEqual([]);
    const reordered = base();
    reordered.devices[3]!.settings = { b: 1, a: 2 };
    const other = base();
    other.devices[3]!.settings = { a: 2, b: 1 };
    expect(diffRoomModels(reordered, other)).toEqual([]);
  });

  it('reports added and removed devices', () => {
    const c = changes((m) => {
      m.devices = m.devices.filter((d) => d.id !== 'speakers');
      m.devices.push({
        id: 'cam',
        name: 'Lectern camera',
        category: 'ptz_camera',
        ports: [],
        extraCapabilities: [],
        settings: {},
      });
    });
    expect(c).toContainEqual({ kind: 'removed', area: 'device', label: 'Speakers', details: [] });
    expect(c).toContainEqual({ kind: 'added', area: 'device', label: 'Lectern camera', details: [] });
  });

  it('describes what changed on a device, without revealing setting values', () => {
    const c = changes((m) => {
      const d = m.devices.find((x) => x.id === 'display1')!;
      d.name = 'Front display';
      d.control = { kind: 'generic', protocol: 'tcp' };
      d.settings = { host: '10.0.0.5', password: 'hunter2' };
    });
    const change = c.find((x) => x.area === 'device')!;
    expect(change).toMatchObject({ kind: 'changed', label: 'Front display' });
    expect(change.details).toEqual([
      'renamed from “Display 1”',
      'control method changed',
      'settings changed (host, password)',
    ]);
    expect(JSON.stringify(c)).not.toContain('hunter2');
    expect(JSON.stringify(c)).not.toContain('10.0.0.5');
  });

  it('reports port changes', () => {
    const c = changes((m) => {
      const matrix = m.devices.find((x) => x.id === 'matrix')!;
      matrix.ports.push({ id: 'in3', name: 'Input 3', direction: 'in', signal: 'av' });
      matrix.ports = matrix.ports.filter((p) => p.id !== 'out3');
    });
    expect(c.find((x) => x.label === 'Video matrix')!.details).toEqual([
      'ports added: Input 3',
      'ports removed: Audio out',
    ]);
  });

  it('names connections by device and port', () => {
    const c = changes((m) => {
      m.connections = m.connections.filter((x) => x.id !== 'c1');
      m.connections.push({
        id: 'cx',
        from: { deviceId: 'laptop1', portId: 'out' },
        to: { deviceId: 'matrix', portId: 'in2' },
      });
    });
    expect(c.filter((x) => x.area === 'connection').map((x) => `${x.kind}: ${x.label}`)).toEqual([
      'removed: Laptop 1 Output to Video matrix Input 1',
      'added: Laptop 1 Output to Video matrix Input 2',
    ]);
  });

  it('reports changes to groups, states, activities and triggers', () => {
    const c = changes((m) => {
      m.groups[0]!.mode = 'independent';
      m.groups[0]!.members = ['display1'];
      m.states[1]!.actions.pop();
      m.activities[0]!.name = 'Share screen';
      m.activities[0]!.hidden = true;
      m.triggers[0]!.enabled = false;
    });
    const by = (area: string) => c.find((x) => x.area === area)!;
    expect(by('group').details).toEqual(['mode changed to independent', 'members now Display 1']);
    expect(by('state').details).toEqual(['actions changed (4 to 3)']);
    expect(by('activity').details).toEqual(['renamed from “Present”', 'now hidden']);
    expect(by('trigger').details).toEqual(['disabled']);
  });

  it('reports room settings in plain words', () => {
    const c = changes((m) => {
      m.settings.defaultVolume = 65;
      m.settings.autoOff.idleSeconds = 300;
      m.settings.userControls.lights = true;
    });
    expect(c.filter((x) => x.area === 'setting').map((x) => [x.label, x.details[0]])).toEqual([
      ['Auto-off idle time', '600 to 300'],
      ['Default volume', '50 to 65'],
      ['Lights control on panel', 'false to true'],
    ]);
  });

  it('with no earlier release, everything is new', () => {
    const c = diffRoomModels(null, base());
    expect(c.length).toBeGreaterThan(10);
    expect(c.every((x) => x.kind === 'added')).toBe(true);
    expect(c.some((x) => x.area === 'setting')).toBe(false);
  });

  it('is ordered by area, then name', () => {
    const c = changes((m) => {
      m.settings.defaultVolume = 60;
      m.devices.find((d) => d.id === 'dsp')!.name = 'Audio DSP';
      m.groups[0]!.name = 'All displays';
    });
    expect(c.map((x) => x.area)).toEqual(['device', 'group', 'setting']);
  });
});

describe('summariseChanges', () => {
  it('counts each kind', () => {
    expect(summariseChanges([])).toBe('No changes');
    expect(
      summariseChanges([
        { kind: 'added', area: 'device', label: 'a', details: [] },
        { kind: 'added', area: 'device', label: 'b', details: [] },
        { kind: 'removed', area: 'device', label: 'c', details: [] },
      ]),
    ).toBe('2 added, 1 removed');
  });
});
