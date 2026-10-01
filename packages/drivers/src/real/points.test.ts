import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES, type ControlPoint, type Device } from '@kestrel/model';
import { createDriver } from './registry';
import { QsysDriver } from './qsys';
import { TesiraDriver } from './tesira';
import type { DeviceDriver, DriverContext } from './types';

const ctx: DriverContext = { log: () => undefined };
const base = STARTER_TEMPLATES[0]!.model;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(15);
  }
}

const servers: { close: () => void }[] = [];
const drivers: DeviceDriver[] = [];
afterEach(() => {
  drivers.splice(0).forEach((d) => d.close());
  servers.splice(0).forEach((s) => s.close());
});

const dsp = (
  driverId: string,
  settings: Record<string, unknown>,
  points: ControlPoint[],
): Device => ({
  ...base.devices.find((d) => d.id === 'dsp')!,
  control: { kind: 'driver', driverId },
  settings,
  points,
});

// ---- Q-SYS ---------------------------------------------------------------------------------------

type Value = number | boolean | string;

interface Core {
  port: number;
  /** Component name to control name to value. */
  components: Map<string, Map<string, Value>>;
  /** Named controls on their own. */
  named: Map<string, Value>;
  sets: { component: string; control: string; value: unknown }[];
  requests: { method: string; params: unknown }[];
  /** The Core forgets its change groups, as it does when a design is reloaded. */
  forgetGroups: () => void;
}

interface Group {
  components: Map<string, Set<string>>;
  named: Set<string>;
  /** What the last poll told this group, so the next one answers with only what changed. */
  told: Map<string, Value>;
}

async function fakeCore(): Promise<Core> {
  const components = new Map<string, Map<string, Value>>([
    [
      'Room',
      new Map<string, Value>([
        ['gain', -20],
        ['mute', false],
      ]),
    ],
    ['Lectern', new Map<string, Value>([['gain', -10]])],
    [
      'Router',
      new Map<string, Value>([
        ['select.1', 1],
        ['select.2', 3],
      ]),
    ],
  ]);
  const named = new Map<string, Value>([
    ['Mic Mute', true],
    ['Scene', 2],
    ['Status Text', 'OK'],
  ]);
  const sets: Core['sets'] = [];
  const requests: Core['requests'] = [];
  let groups = new Map<string, Group>();
  const server: Server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('error', () => undefined);
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\0')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)) as {
          id: number;
          method: string;
          params: any;
        };
        buf = buf.slice(i + 1);
        requests.push({ method: msg.method, params: msg.params });
        const reply = (result: unknown) =>
          socket.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\0');
        const fail = (message: string) =>
          socket.write(
            JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: 10, message } }) + '\0',
          );
        const comp = components.get(msg.params?.Name);
        if (msg.method === 'Component.Get') {
          reply({
            Name: msg.params.Name,
            Controls: msg.params.Controls.flatMap((c: { Name: string }) =>
              comp?.has(c.Name)
                ? [
                    {
                      Name: c.Name,
                      Value: comp.get(c.Name),
                      ...(c.Name === 'gain' ? { ValueMin: -100, ValueMax: 20 } : {}),
                    },
                  ]
                : [],
            ),
          });
        } else if (msg.method === 'Component.Set') {
          for (const c of msg.params.Controls as { Name: string; Value: unknown }[]) {
            sets.push({ component: msg.params.Name, control: c.Name, value: c.Value });
            comp?.set(c.Name, c.Name === 'mute' ? c.Value === 1 : (c.Value as number));
          }
          reply({ Name: msg.params.Name, Controls: [] });
        } else if (msg.method === 'Control.Get') {
          reply(
            (msg.params as string[]).flatMap((n) =>
              named.has(n) ? [{ Name: n, Value: named.get(n) }] : [],
            ),
          );
        } else if (msg.method === 'Control.Set') {
          sets.push({ component: '', control: msg.params.Name, value: msg.params.Value });
          named.set(msg.params.Name, msg.params.Value);
          reply(true);
        } else if (msg.method === 'ChangeGroup.Destroy') {
          groups.delete(msg.params.Id);
          reply(true);
        } else if (msg.method === 'ChangeGroup.AddComponentControl') {
          const g = groups.get(msg.params.Id) ?? {
            components: new Map(),
            named: new Set(),
            told: new Map(),
          };
          if (!components.has(msg.params.Component.Name)) {
            fail(`Component '${String(msg.params.Component.Name)}' does not exist`);
            continue;
          }
          g.components.set(
            msg.params.Component.Name,
            new Set(msg.params.Component.Controls.map((c: { Name: string }) => c.Name)),
          );
          groups.set(msg.params.Id, g);
          reply({ Id: msg.params.Id, Result: 0 });
        } else if (msg.method === 'ChangeGroup.AddControl') {
          const g = groups.get(msg.params.Id) ?? {
            components: new Map(),
            named: new Set(),
            told: new Map(),
          };
          for (const n of msg.params.Controls as string[]) g.named.add(n);
          groups.set(msg.params.Id, g);
          reply({ Id: msg.params.Id, Result: 0 });
        } else if (msg.method === 'ChangeGroup.Poll') {
          const g = groups.get(msg.params.Id);
          if (!g) {
            fail('Change group does not exist');
            continue;
          }
          const Changes: Record<string, unknown>[] = [];
          for (const [c, controls] of g.components)
            for (const n of controls) {
              const v = components.get(c)?.get(n);
              if (v !== undefined && g.told.get(`${c}|${n}`) !== v) {
                g.told.set(`${c}|${n}`, v);
                Changes.push({ Component: c, Name: n, Value: v, String: String(v) });
              }
            }
          for (const n of g.named) {
            const v = named.get(n);
            if (v !== undefined && g.told.get(`|${n}`) !== v) {
              g.told.set(`|${n}`, v);
              Changes.push({ Name: n, Value: v, String: String(v) });
            }
          }
          reply({ Id: msg.params.Id, Changes });
        } else reply(true);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push({ close: () => server.close() });
  return {
    port: (server.address() as { port: number }).port,
    components,
    named,
    sets,
    requests,
    forgetGroups: () => {
      groups = new Map();
    },
  };
}

const qpoints: ControlPoint[] = [
  {
    id: 'vol',
    name: 'Room volume',
    type: 'level',
    address: { component: 'Room', control: 'gain' },
    role: 'room_volume',
    min: -40,
    max: 0,
  },
  {
    id: 'mute',
    name: 'Room mute',
    type: 'mute',
    address: { component: 'Room', control: 'mute' },
    role: 'room_mute',
  },
  {
    id: 'lect',
    name: 'Lectern level',
    type: 'level',
    address: { component: 'Lectern', control: 'gain' },
    min: -20,
    max: 0,
  },
];

/** What the monitoring screen adds for a router with two outputs and three named controls. */
const monitored: ControlPoint[] = [
  {
    id: 'r1',
    name: 'Router out 1',
    type: 'select',
    address: { component: 'Router', control: 'select.1' },
  },
  {
    id: 'r2',
    name: 'Router out 2',
    type: 'select',
    address: { component: 'Router', control: 'select.2' },
  },
  {
    id: 'mic',
    name: 'Mic mute',
    type: 'generic',
    valueType: 'boolean',
    address: { control: 'Mic Mute' },
  },
  {
    id: 'scene',
    name: 'Scene',
    type: 'generic',
    valueType: 'integer',
    address: { control: 'Scene' },
  },
  {
    id: 'text',
    name: 'Status',
    type: 'generic',
    valueType: 'text',
    address: { control: 'Status Text' },
  },
];

describe('Q-SYS control points', () => {
  const start = async (points = qpoints) => {
    const core = await fakeCore();
    const d = createDriver(
      dsp('qsys-core', { host: '127.0.0.1', port: core.port, timeoutMs: 400, pollMs: 100 }, points),
      ctx,
    )!;
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    return { core, d };
  };

  it('reads every point into state, as 0 to 100 for a level, and follows the room roles', async () => {
    const { d } = await start();
    await until(
      () => d.getState().points.vol !== undefined && d.getState().points.lect !== undefined,
    );
    const s = d.getState();
    expect(s.points).toMatchObject({ vol: 50, mute: false, lect: 50 });
    expect(s.volume).toBe(50);
    expect(s.muted).toBe(false);
  });

  it('reads through one change group: components first, then named controls, then a poll', async () => {
    const { core, d } = await start([...qpoints, ...monitored]);
    await until(() => d.getState().points.text !== undefined);
    const methods = core.requests.map((r) => r.method);
    expect(methods.filter((m) => m === 'ChangeGroup.AddComponentControl')).toHaveLength(3);
    expect(methods.filter((m) => m === 'ChangeGroup.AddControl')).toHaveLength(1);
    expect(methods.indexOf('ChangeGroup.Poll')).toBeGreaterThan(
      methods.lastIndexOf('ChangeGroup.AddControl'),
    );
    // Nothing is read control by control while there is a change group.
    expect(methods).not.toContain('Component.Get');
    const router = core.requests.find(
      (r) =>
        r.method === 'ChangeGroup.AddComponentControl' &&
        (r.params as { Component: { Name: string } }).Component.Name === 'Router',
    )!;
    expect(router.params).toMatchObject({
      Component: { Name: 'Router', Controls: [{ Name: 'select.1' }, { Name: 'select.2' }] },
    });
    expect(core.requests.find((r) => r.method === 'ChangeGroup.AddControl')!.params).toMatchObject({
      Controls: ['Mic Mute', 'Scene', 'Status Text'],
    });
  });

  it('reads a router’s selects and named controls as boolean, whole number and text', async () => {
    const { d } = await start(monitored);
    await until(() => d.getState().points.text !== undefined);
    expect(d.getState().points).toEqual({
      r1: 1,
      r2: 3,
      // The Core answers true; a 1 or a "true" is read the same.
      mic: true,
      scene: 2,
      text: 'OK',
    });
  });

  it('then hears only what changes, from a router or a named control', async () => {
    const { core, d } = await start(monitored);
    await until(() => d.getState().points.text !== undefined);
    core.components.get('Router')!.set('select.2', 4);
    core.named.set('Mic Mute', false);
    core.named.set('Status Text', 'Fault');
    await until(
      () =>
        d.getState().points.r2 === 4 &&
        d.getState().points.mic === false &&
        d.getState().points.text === 'Fault',
    );
    // The ones that did not change were not sent again, and nothing else was disturbed.
    expect(d.getState().points).toMatchObject({ r1: 1, scene: 2 });
  });

  it('builds the group again when the Core forgets it, and after a reconnect', async () => {
    const { core, d } = await start(monitored);
    await until(() => d.getState().points.text !== undefined);
    core.forgetGroups();
    core.named.set('Scene', 7);
    await until(() => d.getState().points.scene === 7);
    expect(d.getState().online).toBe(true);
    expect(
      core.requests.filter((r) => r.method === 'ChangeGroup.AddControl').length,
    ).toBeGreaterThan(1);
  });

  it('leaves out a component the Core does not have, and still reads the rest', async () => {
    const { d } = await start([
      ...monitored,
      {
        id: 'ghost',
        name: 'Ghost',
        type: 'level',
        address: { component: 'Nope', control: 'gain' },
      },
    ]);
    await until(() => d.getState().points.text !== undefined);
    expect(d.getState().points.ghost).toBeUndefined();
    expect(d.getState()).toMatchObject({ online: true });
  });

  it('keeps the connection alive with NoOp when there is nothing to watch, and reads no gain', async () => {
    const { core, d } = await start([]);
    await until(() => core.requests.some((r) => r.method === 'NoOp'));
    expect(d.getState().online).toBe(true);
    expect(core.requests.map((r) => r.method)).not.toContain('Component.Get');
  });

  it('sets a level point over its own range', async () => {
    const { core, d } = await start();
    await d.send({ type: 'point', pointId: 'lect', value: 100 });
    expect(core.sets.at(-1)).toEqual({ component: 'Lectern', control: 'gain', value: 0 });
    expect(d.getState().points.lect).toBe(100);
  });

  it('sets a named control on its own', async () => {
    const { core, d } = await start(monitored);
    await d.send({ type: 'point', pointId: 'scene', value: 5 });
    expect(core.sets.at(-1)).toEqual({ component: '', control: 'Scene', value: 5 });
  });

  it('sends the room volume and mute to the points that have those roles, not the gain component', async () => {
    const { core, d } = await start();
    await d.send({ type: 'volume', level: 25 });
    expect(core.sets.at(-1)).toEqual({ component: 'Room', control: 'gain', value: -30 });
    await d.send({ type: 'mute', muted: true });
    expect(core.sets.at(-1)).toEqual({ component: 'Room', control: 'mute', value: 1 });
    expect(d.getState()).toMatchObject({ volume: 25, muted: true });
  });

  it('keeps using the gain component when no point has a room role', async () => {
    const { core, d } = await start([qpoints[2]!]);
    await d.send({ type: 'volume', level: 50 });
    expect(core.sets.at(-1)).toMatchObject({ component: 'gain', control: 'gain' });
  });

  it('refuses a point it does not know, and a meter it cannot set', async () => {
    const { d } = await start([
      ...qpoints,
      { id: 'peak', name: 'Peak', type: 'meter', address: { component: 'Room', control: 'gain' } },
    ]);
    await expect(d.send({ type: 'point', pointId: 'nope', value: 1 })).rejects.toThrow(
      /no control point/,
    );
    await expect(d.send({ type: 'point', pointId: 'peak', value: 1 })).rejects.toThrow(/read only/);
  });

  it('checks a point exists and learns its range, or says it is missing', async () => {
    const { d } = await start();
    await expect(
      d.readPoint!({ type: 'level', address: { component: 'Room', control: 'gain' } }),
    ).resolves.toEqual({ value: -20, min: -100, max: 20 });
    await expect(
      d.readPoint!({ type: 'mute', address: { component: 'Room', control: 'mute' } }),
    ).resolves.toEqual({ value: false });
    await expect(
      d.readPoint!({ type: 'level', address: { component: 'Room', control: 'nothing' } }),
    ).rejects.toThrow(/no control "nothing"/);
    await expect(d.readPoint!({ type: 'level', address: { component: 'Room' } })).rejects.toThrow(
      /no control name/,
    );
    // A named control on its own.
    await expect(
      d.readPoint!({ type: 'generic', address: { control: 'Status Text' } }),
    ).resolves.toEqual({ value: 'OK' });
    await expect(d.readPoint!({ type: 'generic', address: { control: 'Nope' } })).rejects.toThrow(
      /no named control "Nope"/,
    );
  });

  it('is what a Q-SYS device asks for', () => {
    expect(createDriver(dsp('qsys-core', { host: '127.0.0.1' }, []), ctx)).toBeInstanceOf(
      QsysDriver,
    );
  });
});

// ---- Tesira --------------------------------------------------------------------------------------

interface Tesira {
  port: number;
  /** Commands received, in order. */
  seen: string[];
  /** Negotiation replies the driver sent, as hex. */
  negotiation: string[];
  values: Map<string, string>;
}

async function fakeTesira(): Promise<Tesira> {
  const seen: string[] = [];
  const negotiation: string[] = [];
  const values = new Map<string, string>([
    ['Level1 get level 1', '-10.000000'],
    ['Level1 get minLevel 1', '-100.000000'],
    ['Level1 get maxLevel 1', '12.000000'],
    ['Mute1 get mute 1', 'false'],
    ['"my level" get level 2', '-20.000000'],
    ['DEVICE get version', '"4.2.1.3"'],
  ]);
  const server: Server = createServer((socket: Socket) => {
    socket.on('error', () => undefined);
    // Telnet negotiation first, as Tesira does, then the welcome line.
    socket.write(Buffer.from([0xff, 0xfd, 0x18, 0xff, 0xfb, 0x03]));
    socket.write('\r\nWelcome to the Tesira Text Protocol Server\r\n');
    let buf = '';
    socket.on('data', (chunk: Buffer) => {
      let text = '';
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0xff) {
          negotiation.push(chunk.subarray(i, i + 3).toString('hex'));
          i += 2;
        } else text += String.fromCharCode(chunk[i]!);
      }
      buf += text;
      let end: number;
      while ((end = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, end);
        buf = buf.slice(end + 2);
        seen.push(line);
        socket.write(`${line}\r\n`); // the server echoes what it is sent
        const value = values.get(line);
        if (value !== undefined) socket.write(`+OK "value":${value}\r\n`);
        else if (/ set /.test(line) || /recallPresetByName/.test(line)) socket.write('+OK\r\n');
        else
          socket.write('-ERR address not found: {"deviceId":0 "classCode":0 "instanceNum":0}\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push({ close: () => server.close() });
  return { port: (server.address() as { port: number }).port, seen, negotiation, values };
}

const tpoints: ControlPoint[] = [
  {
    id: 'vol',
    name: 'Room volume',
    type: 'level',
    address: { tag: 'Level1', index: 1 },
    role: 'room_volume',
    min: -60,
    max: 0,
  },
  {
    id: 'mute',
    name: 'Room mute',
    type: 'mute',
    address: { tag: 'Mute1', index: 1 },
    role: 'room_mute',
  },
  {
    id: 'spaced',
    name: 'Spaced tag',
    type: 'level',
    address: { tag: 'my level', index: 2 },
    min: -40,
    max: 0,
  },
  {
    id: 'x',
    name: 'Crosspoint',
    type: 'crosspoint',
    address: { tag: 'Mixer1', input: 1, output: 2 },
  },
];

describe('Biamp Tesira driver', () => {
  const start = async () => {
    const t = await fakeTesira();
    const d = createDriver(
      dsp(
        'biamp-tesira',
        { host: '127.0.0.1', port: t.port, timeoutMs: 400, pollMs: 100 },
        tpoints,
      ),
      ctx,
    )!;
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    return { t, d };
  };

  it('is what a Tesira device asks for', () => {
    expect(createDriver(dsp('biamp-tesira', { host: '127.0.0.1' }, []), ctx)).toBeInstanceOf(
      TesiraDriver,
    );
  });

  it('refuses every telnet option the server offers, then goes online after the welcome line', async () => {
    const { t } = await start();
    await until(() => t.negotiation.length >= 2);
    // DO 24 is answered WON'T 24, and WILL 3 is answered DON'T 3.
    expect(t.negotiation.slice(0, 2)).toEqual(['fffc18', 'fffe03']);
  });

  it('reads points into state, ignoring the echoed lines', async () => {
    const { d } = await start();
    await until(() =>
      ['vol', 'mute', 'spaced'].every((id) => d.getState().points[id] !== undefined),
    );
    // -10 dB over -60..0 is 83.
    expect(d.getState()).toMatchObject({ volume: 83, muted: false });
    expect(d.getState().points.spaced).toBe(50);
  });

  it('reports the firmware version, and asks for it only once', async () => {
    const { t, d } = await start();
    await until(() => d.getState().firmware === '4.2.1.3');
    await wait(350);
    expect(t.seen.filter((l) => l === 'DEVICE get version')).toHaveLength(1);
  });

  it('carries on normally when the device gives no version', async () => {
    const t = await fakeTesira();
    t.values.delete('DEVICE get version');
    const d = createDriver(
      dsp(
        'biamp-tesira',
        { host: '127.0.0.1', port: t.port, timeoutMs: 400, pollMs: 100 },
        tpoints,
      ),
      ctx,
    )!;
    drivers.push(d);
    d.start();
    await until(() => d.getState().points.vol !== undefined);
    expect(d.getState().firmware).toBeUndefined();
    expect(d.getState().online).toBe(true);
  });

  it('sets the room volume and mute as TTP commands over the point range', async () => {
    const { t, d } = await start();
    await d.send({ type: 'volume', level: 50 });
    expect(t.seen).toContain('Level1 set level 1 -30');
    await d.send({ type: 'mute', muted: true });
    expect(t.seen).toContain('Mute1 set mute 1 true');
    expect(d.getState()).toMatchObject({ volume: 50, muted: true });
  });

  it('quotes an instance tag with a space, sets a crosspoint, and recalls a preset by name', async () => {
    const { t, d } = await start();
    await d.send({ type: 'point', pointId: 'spaced', value: 100 });
    expect(t.seen).toContain('"my level" set level 2 0');
    await d.send({ type: 'point', pointId: 'x', value: true });
    expect(t.seen).toContain('Mixer1 set crosspoint 1 2 true');
    await d.send({ type: 'preset', name: 'Day "one"' });
    expect(t.seen).toContain('DEVICE recallPresetByName "Day one"');
  });

  it('says what the server said when a command fails', async () => {
    const { d } = await start();
    await expect(
      d.readPoint!({ type: 'level', address: { tag: 'Nope', index: 1 } }),
    ).rejects.toThrow(/address not found/);
  });

  it('checks a level and learns its range', async () => {
    const { d } = await start();
    await expect(
      d.readPoint!({ type: 'level', address: { tag: 'Level1', index: 1 } }),
    ).resolves.toEqual({ value: -10, min: -100, max: 12 });
    await expect(
      d.readPoint!({ type: 'mute', address: { tag: 'Mute1', index: 1 } }),
    ).resolves.toEqual({ value: false });
  });

  it('runs commands one at a time, in order', async () => {
    const { t, d } = await start();
    await Promise.all([
      d.send({ type: 'volume', level: 10 }),
      d.send({ type: 'volume', level: 20 }),
      d.send({ type: 'volume', level: 30 }),
    ]);
    const sets = t.seen.filter((l) => l.startsWith('Level1 set level'));
    expect(sets).toEqual([
      'Level1 set level 1 -54',
      'Level1 set level 1 -48',
      'Level1 set level 1 -42',
    ]);
  });

  it('cannot send without a point for the role', async () => {
    const t = await fakeTesira();
    const d = createDriver(
      dsp('biamp-tesira', { host: '127.0.0.1', port: t.port, timeoutMs: 400 }, []),
      ctx,
    )!;
    drivers.push(d);
    d.start();
    await until(() => d.getState().online);
    await expect(d.send({ type: 'volume', level: 10 })).rejects.toThrow(/room volume/);
  });
});
